// @ts-check
/**
 * @file api-client.js
 * Phase 6: a small fetch-based client for the TableCodex API. No third-party
 * deps. All methods are defensive and return result objects rather than throwing
 * so the upload queue can decide retry policy. Endpoints match the TableCodex
 * OpenAPI spec (/api/me, /api/campaigns, /api/campaigns/:id/sessions[/transcript]).
 */

import { MODULE_ID, MODULE_VERSION, ENVELOPE_SCHEMA, SETTINGS } from "../core/constants.js";
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
   * campaignId is required by the server — falls back to the CAMPAIGN_ID setting
   * if not supplied in `input`.
   * @param {{campaignId?:string|number, foundryWorldId:string, foundryWorldName:string, systemId?:string, foundryVersion?:string, moduleVersion?:string}} input
   * @returns {Promise<ApiResult>}
   */
  async connectWorld(input) {
    if (!input?.foundryWorldId || !input?.foundryWorldName) {
      return { ok: false, error: "world id/name required to connect" };
    }
    // campaignId is required by the server — resolve from input or fall back to setting.
    const rawId = input.campaignId ?? (getSetting(SETTINGS.CAMPAIGN_ID) || "");
    const campaignId = Number(rawId);
    if (!Number.isFinite(campaignId) || campaignId <= 0) {
      return { ok: false, error: "campaign id required to connect — select a campaign in the panel first" };
    }
    return this._request(
      "/api/integrations/foundry/connect",
      { method: "POST", body: JSON.stringify({ ...input, campaignId }) },
      30000,
    );
  }

  /**
   * Check connection health: token validity, linked campaign/world, and last sync time.
   * `GET /api/integrations/foundry/health` → FoundryHealthResponse.
   * @returns {Promise<ApiResult>}
   */
  async getHealth() {
    return this._request("/api/integrations/foundry/health", { method: "GET" });
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
    const session = body.session ?? {};
    if (!session.worldId) return { ok: false, error: "missing foundry world id" };

    // Best-effort: register/refresh the world connection first (idempotent).
    await this.connectWorld({
      campaignId: body.campaignId,
      foundryWorldId: session.worldId,
      foundryWorldName: session.worldName,
      systemId: session.systemId,
      foundryVersion: session.foundryVersion,
      moduleVersion: session.moduleVersion,
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
   * Map our payload (buildPayload output) to FoundryImportPayload.
   *
   * We send the capture ENVELOPE as-is (`session` + `reconstruction` +
   * `rawEvents`) rather than flattening it into top-level scalars and derived
   * arrays. The server sniffs the payload shape, and the envelope form routes to
   * its "module capture format" branch, which is the only one that:
   *   • reads `session.sessionIndex` / `session.previousSessionId` — the
   *     deterministic recency ordinal the recap + intelligence pipelines order
   *     sessions by. Flattening dropped `session` entirely, so every API-synced
   *     session landed with a null ordinal.
   *   • ignores a `rolls` array, so rolls are not imported twice — once from
   *     `rolls` and again from the same events in `rawEvents`. The `rolls` copy
   *     was also the unattributed one (the server reads `roll.actor`, but
   *     roll-capture records the speaker as `metadata.speakerAlias`).
   *   • resolves systemId/foundryVersion/moduleVersion from `session`; the
   *     legacy branch does not surface them at all.
   *
   * That branch is gated on the payload NOT carrying `foundryWorldId`, `rolls`,
   * or `chatMessages` at the top level — it tests key presence, so those keys
   * must be absent entirely, not merely undefined. Do not reintroduce them here.
   * `campaignId` and `title` stay at the root because the server reads both from
   * the root and neither affects shape detection.
   *
   * @param {object} payload
   */
  _buildImportPayload(payload) {
    const session = payload?.session ?? {};
    const recon = payload?.reconstruction ?? {};
    const campaignIdRaw = (getSetting(SETTINGS.CAMPAIGN_ID) || "").toString().trim();
    const campaignId = campaignIdRaw ? Number(campaignIdRaw) : undefined;

    // The world id is the dedup key server-side, so resolve it to something
    // non-empty here rather than shipping "" and creating an orphan import.
    const worldId = session.worldId || getSetting(SETTINGS.WORLD_ID) || game?.world?.id || "";
    const worldName =
      session.worldName || getSetting(SETTINGS.WORLD_NAME) || game?.world?.title || worldId;

    return {
      ...(Number.isFinite(campaignId) ? { campaignId } : {}),
      // User-provided session name → TableCodex session title (server uses this
      // in place of the auto "<World> – <date>" title when present). Read from
      // the payload root, not from session{}.
      title: session.title ?? null,
      schemaVersion: String(ENVELOPE_SCHEMA),
      ...(payload?.module ? { module: payload.module } : {}),
      session: {
        ...session,
        id: session.id ?? recon.sessionId ?? null,
        worldId,
        worldName,
        // startedAt/endedAt may be epoch ms (session meta) or ISO (reconstruction);
        // the server normalizes both. Fall back to the reconstruction bounds so a
        // mid-session "Sync now" still reports an end time.
        startedAt: session.startedAt ?? recon.startedAt ?? null,
        endedAt: session.endedAt ?? recon.endedAt ?? null,
        systemId: session.systemId || game?.system?.id || null,
        foundryVersion: session.foundryVersion || game?.version || null,
        moduleVersion: session.moduleVersion || MODULE_VERSION,
      },
      reconstruction: recon,
      rawEvents: payload?.rawEvents ?? [],
    };
  }

  /**
   * List importable session plans for the linked campaign (PRD F1.1).
   * `GET /api/integrations/foundry/session-plans` → { success, plans: [...] }.
   * Read-only summary; does NOT mark a plan as exported. Normalized to
   * `data: [{ id, title, plannedSessionNumber, status, sceneCount, npcCount, hasBattleMaps, foundryExportedAt }]`.
   * @returns {Promise<ApiResult>}
   */
  async listSessionPlans() {
    if (!this.baseUrl) return { ok: false, error: "API URL not configured" };
    const result = await this._request("/api/integrations/foundry/session-plans", { method: "GET" });
    if (result.ok) {
      const raw = result.data?.plans ?? (Array.isArray(result.data) ? result.data : []);
      result.data = raw.map((p) => ({
        id: p.id,
        title: p.title ?? `Plan ${p.id}`,
        plannedSessionNumber: p.plannedSessionNumber ?? null,
        status: p.status ?? null,
        sceneCount: p.sceneCount ?? 0,
        npcCount: p.npcCount ?? 0,
        hasBattleMaps: !!p.hasBattleMaps,
        foundryExportedAt: p.foundryExportedAt ?? null,
      }));
    }
    logger.debug("api-client: listSessionPlans", result.ok, result.data?.length ?? 0);
    return result;
  }

  /**
   * Fetch the full Foundry export payload for one plan (PRD F1.2). Fetching marks
   * the plan as "exported" server-side — call this only when actually importing,
   * not for the panel preview (use listSessionPlans for that).
   * `GET /api/integrations/foundry/session-plans/:planId` → FoundryExportPayload.
   * @param {number|string} planId
   * @returns {Promise<ApiResult>}
   */
  async getSessionPlan(planId) {
    if (planId == null) return { ok: false, error: "planId required" };
    return this._request(
      `/api/integrations/foundry/session-plans/${encodeURIComponent(planId)}`,
      { method: "GET" },
      30000,
    );
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
