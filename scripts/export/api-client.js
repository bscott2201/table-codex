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

  /** Standard headers including auth + module identity. */
  _headers(extra = {}) {
    /** @type {Record<string,string>} */
    const headers = {
      "Content-Type": "application/json",
      "X-TableCodex-Module": `${MODULE_ID}@${MODULE_VERSION}`,
      ...extra,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
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
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: this._headers(init.headers),
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

  /** Verify connectivity + auth. GET /api/ping. */
  async testConnection() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/ping", { method: "GET" });
    if (result.ok) result.detail = result.data?.version ?? "ok";
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
   * Push a session payload. POST /api/sessions.
   * @param {object} payload  Output of buildPayload().
   * @returns {Promise<ApiResult>}
   */
  async syncSession(payload) {
    const campaignId = getSetting(SETTINGS.CAMPAIGN_ID) || null;
    return this._request(
      "/api/sessions",
      { method: "POST", body: JSON.stringify({ campaignId, payload }) },
      60000,
    );
  }

  /**
   * Fetch sync status for a session id. GET /api/sessions/:id/status.
   * @param {string} sessionId
   */
  async getSyncStatus(sessionId) {
    return this._request(`/api/sessions/${encodeURIComponent(sessionId)}/status`, {
      method: "GET",
    });
  }
}

export const apiClient = new ApiClient();
export { ApiClient };
