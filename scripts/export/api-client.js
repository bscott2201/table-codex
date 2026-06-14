// @ts-check
/**
 * @file api-client.js
 * Phase 6: a small fetch-based client for the TableCodex API. No third-party
 * deps. All methods are defensive and return result objects rather than throwing
 * so the upload queue can decide retry policy. Endpoints match the TableCodex
 * OpenAPI spec (/api/me, /api/campaigns, /api/campaigns/:id/sessions[/transcript]).
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
   * Verify connectivity, CORS, and token validity via the purpose-built Foundry
   * module endpoint `GET /api/integrations/foundry/ping` (no campaign required).
   * The Foundry token is a `Bearer ftx_...` API key generated in TableCodex.
   */
  async testConnection() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/integrations/foundry/ping", { method: "GET" });
    if (result.ok && result.data?.success) {
      const d = result.data;
      result.detail = `${d.tokenType ?? "token"}${d.scopes?.length ? ` [${d.scopes.join(", ")}]` : ""}`;
    } else if (result.status === 401) {
      result.ok = false;
      result.error = result.data?.error ?? "invalid or missing Foundry token (Bearer ftx_...)";
    }
    logger.debug("api-client: testConnection", result.ok);
    return result;
  }

  /**
   * List campaigns this Foundry token can access, for selection in the link UI.
   * `GET /api/integrations/foundry/campaigns` → FoundryCampaignsResponse.
   * Normalized to `data: [{ id, name, system }]`.
   * @returns {Promise<ApiResult>}
   */
  async listCampaigns() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/integrations/foundry/campaigns", { method: "GET" });
    if (result.ok) {
      const raw = result.data?.campaigns ?? (Array.isArray(result.data) ? result.data : []);
      result.data = raw.map((c) => ({
        id: c.id ?? "",
        name: c.name ?? `Campaign ${c.id}`,
        system: c.system ?? null,
      }));
    }
    logger.debug("api-client: listCampaigns", result.ok, result.data?.length ?? 0);
    return result;
  }

  /**
   * Register or update this Foundry world connection.
   * `POST /api/integrations/foundry/connect` (FoundryConnectInput).
   * @param {{campaignId?:string|number, foundryWorldId:string, foundryWorldName:string, systemId?:string, foundryVersion?:string, moduleVersion?:string}} input
   * @returns {Promise<ApiResult>}
   */
  async connectWorld(input) {
    if (!input?.foundryWorldId || !input?.foundryWorldName) {
      return { ok: false, error: "world id/name required to connect" };
    }
    return this._request(
      "/api/integrations/foundry/connect",
      { method: "POST", body: JSON.stringify(input) },
      30000,
    );
  }

  /**
   * Push a session import. The Foundry integration endpoint accepts our
   * structured telemetry directly (incl. a `rawEvents` array), so there is no
   * transcript hack — the server processes the import server-side.
   * `POST /api/integrations/foundry/session-import` → FoundrySyncStatusResponse.
   * @param {object} payload  Output of buildPayload().
   * @returns {Promise<ApiResult>}
   */
  async syncSession(payload) {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const body = this._buildImportPayload(payload);
    if (!body.foundryWorldId) return { ok: false, error: "missing foundry world id" };

    // Best-effort: register/refresh the world connection first (idempotent).
    await this.connectWorld({
      campaignId: body.campaignId,
      foundryWorldId: body.foundryWorldId,
      foundryWorldName: body.foundryWorldName,
      systemId: body.systemId,
      foundryVersion: body.foundryVersion,
      moduleVersion: body.moduleVersion,
    }).catch(() => {});

    const result = await this._request(
      "/api/integrations/foundry/session-import",
      { method: "POST", body: JSON.stringify(body) },
      120000,
    );
    if (result.ok) {
      logger.info(`api-client: import accepted (importId ${result.data?.importId}, ${result.data?.status})`);
    }
    return result;
  }

  /**
   * Map our payload (buildPayload output) to FoundryImportPayload. Required:
   * `foundryWorldId`. We send the full raw envelope log plus a few derived
   * arrays the server understands.
   * @param {object} payload
   */
  _buildImportPayload(payload) {
    const session = payload?.session ?? {};
    const recon = payload?.reconstruction ?? {};
    const events = payload?.rawEvents ?? [];
    const campaignIdRaw = (getSetting(SETTINGS.CAMPAIGN_ID) || "").toString().trim();
    const campaignId = campaignIdRaw ? Number(campaignIdRaw) : undefined;

    const rolls = events.filter((e) => e.eventType === "roll").map((e) => e.metadata);
    const actors = Object.values(recon.actors ?? {});

    return {
      ...(Number.isFinite(campaignId) ? { campaignId } : {}),
      foundryWorldId: session.worldId ?? getSetting(SETTINGS.WORLD_ID) ?? "",
      foundryWorldName: session.worldName ?? getSetting(SETTINGS.WORLD_NAME) ?? "",
      localSessionId: session.id ?? recon.sessionId ?? null,
      startedAt: recon.startedAt ?? session.startedAt ?? null,
      endedAt: recon.endedAt ?? null,
      foundryVersion: session.foundryVersion ?? game.version ?? null,
      systemId: session.systemId ?? game.system?.id ?? null,
      moduleVersion: session.moduleVersion ?? MODULE_VERSION,
      rawEvents: events,
      rolls,
      combats: recon.combats ?? [],
      actors,
    };
  }

  /**
   * Get import processing status.
   * `GET /api/integrations/foundry/sync-status?importId=N`.
   * @param {number|string} importId
   * @returns {Promise<ApiResult>}
   */
  async getSyncStatus(importId) {
    if (importId == null) return { ok: false, error: "importId required" };
    return this._request(
      `/api/integrations/foundry/sync-status?importId=${encodeURIComponent(importId)}`,
      { method: "GET" },
    );
  }
}

export const apiClient = new ApiClient();
export { ApiClient };
