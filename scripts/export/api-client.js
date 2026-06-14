// @ts-check
/**
 * @file api-client.js
 * Phase 6: a small fetch-based client for the TableCodex API. No third-party
 * deps. All methods are defensive and return result objects rather than throwing
 * so the upload queue can decide retry policy. The actual TableCodex endpoints
 * are placeholders documented here; only the transport is implemented.
 */

import { MODULE_ID, MODULE_VERSION, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { getSetting } from "../core/settings.js";

/** @typedef {{ ok: boolean, status?: number, detail?: string, error?: string, data?: any }} ApiResult */

class ApiClient {
  /** Base URL (trailing slash trimmed) or null when unconfigured. */
  get baseUrl() {
    const url = (getSetting(SETTINGS.API_URL) || "").trim();
    return url ? url.replace(/\/+$/, "") : null;
  }

  /** Bearer token or null. */
  get token() {
    return (getSetting(SETTINGS.API_TOKEN) || "").trim() || null;
  }

  /**
   * Build request headers. We deliberately keep these to the CORS-"simple" set
   * plus Authorization: a custom header (e.g. X-TableCodex-Module) forces the
   * browser to send a preflight that lists it in Access-Control-Request-Headers,
   * which fails unless the server echoes it in Access-Control-Allow-Headers.
   * Module identity is sent as a query param instead (see `_url`). Content-Type
   * is only set when there is a JSON body.
   * @param {boolean} hasBody
   * @param {Record<string,string>} [extra]
   */
  _headers(hasBody, extra = {}) {
    /** @type {Record<string,string>} */
    const headers = { ...extra };
    if (hasBody) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /** Append the module identity as a preflight-safe query param. */
  _url(path) {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.baseUrl}${path}${sep}module=${encodeURIComponent(`${MODULE_ID}@${MODULE_VERSION}`)}`;
  }

  /**
   * Core request with timeout + uniform result shape.
   * @param {string} path
   * @param {RequestInit} [init]
   * @param {number} [timeoutMs]
   * @returns {Promise<ApiResult>}
   */
  async _request(path, init = {}, timeoutMs = 15000) {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this._url(path), {
        ...init,
        headers: this._headers(init.body != null, init.headers),
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* non-JSON body */
      }
      if (!res.ok) {
        return { ok: false, status: res.status, error: data?.error ?? res.statusText, data };
      }
      return { ok: true, status: res.status, data };
    } catch (err) {
      const aborted = err?.name === "AbortError";
      return { ok: false, error: aborted ? "request timed out" : String(err?.message ?? err) };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Verify connectivity + auth against the real API. There is no public health
   * endpoint (the SPA catch-all serves HTML for unknown paths), so we hit the
   * authenticated `GET /api/me` and treat 200 as connected, 401 as a bad/missing
   * token.
   */
  async testConnection() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/me", { method: "GET" });
    if (result.ok) {
      const u = result.data ?? {};
      result.detail = u.email ?? u.username ?? u.name ?? "authenticated";
    } else if (result.status === 401) {
      result.error = "invalid or missing API token";
    }
    logger.debug("api-client: testConnection", result.ok);
    return result;
  }

  /**
   * List the campaigns available to this token, for selection in the link UI.
   * GET /api/campaigns. Normalizes the response to `data: [{id, name}]`.
   * @returns {Promise<ApiResult>}
   */
  async listCampaigns() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/campaigns", { method: "GET" });
    if (result.ok) {
      const raw = Array.isArray(result.data) ? result.data : result.data?.campaigns ?? [];
      result.data = raw.map((c) => ({
        id: c.id ?? c.campaignId ?? c._id ?? "",
        name: c.name ?? c.title ?? c.id ?? "(unnamed)",
      }));
    }
    logger.debug("api-client: listCampaigns", result.ok, result.data?.length ?? 0);
    return result;
  }

  /**
   * Push a session payload. Sessions are nested under a campaign:
   * `POST /api/campaigns/:campaignId/sessions` (campaignId is numeric server-side).
   *
   * The TableCodex session schema requires at least `title` (string) and
   * `sessionNumber` (number); the full telemetry payload is attached under
   * `telemetry`. Adjust `_buildSessionBody` if the server schema gains/renames
   * required fields.
   * @param {object} payload  Output of buildPayload().
   * @returns {Promise<ApiResult>}
   */
  async syncSession(payload) {
    const campaignId = (getSetting(SETTINGS.CAMPAIGN_ID) || "").toString().trim();
    if (!campaignId) return { ok: false, error: "no campaign linked" };
    return this._request(
      `/api/campaigns/${encodeURIComponent(campaignId)}/sessions`,
      { method: "POST", body: JSON.stringify(this._buildSessionBody(payload)) },
      60000,
    );
  }

  /**
   * Map our telemetry payload to the TableCodex session create schema.
   * Known required fields: `title` (string), `sessionNumber` (number).
   * @param {object} payload
   */
  _buildSessionBody(payload) {
    const session = payload?.session ?? {};
    const started = session.startedAt ? new Date(session.startedAt) : new Date();
    const dateStr = started.toISOString().slice(0, 10);
    // Derive a stable sequence number from the local session index.
    let sessionNumber = 1;
    try {
      const index = getSetting(SETTINGS.SESSION_INDEX) ?? [];
      const sameCampaign = index.filter((s) => String(s.campaignId ?? "") === String(session.campaignId ?? ""));
      const pos = sameCampaign.findIndex((s) => s.id === session.id);
      sessionNumber = (pos >= 0 ? pos : sameCampaign.length) + 1;
    } catch {
      /* fall back to 1 */
    }
    return {
      title: session.title || `${session.worldName || "Foundry"} session — ${dateStr}`,
      sessionNumber,
      date: dateStr,
      telemetry: payload,
    };
  }

  /**
   * List sessions already recorded for the linked campaign.
   * `GET /api/campaigns/:campaignId/sessions`.
   * @returns {Promise<ApiResult>}
   */
  async getSyncStatus() {
    const campaignId = (getSetting(SETTINGS.CAMPAIGN_ID) || "").toString().trim();
    if (!campaignId) return { ok: false, error: "no campaign linked" };
    return this._request(`/api/campaigns/${encodeURIComponent(campaignId)}/sessions`, {
      method: "GET",
    });
  }
}

export const apiClient = new ApiClient();
export { ApiClient };
