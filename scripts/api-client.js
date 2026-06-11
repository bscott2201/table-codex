import { MODULE_ID, getSetting, cleanToken } from "./settings.js";
import { log, debug } from "./logger.js";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(url) {
  return (url ?? "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
}

export function buildApiUrl(path) {
  const raw = getSetting("tablecodexApiUrl") ?? "";
  if (!raw.trim()) throw new Error(game.i18n.localize("TABLECODEX.Error.NoApiUrl"));
  return `${normalizeBaseUrl(raw)}/api${path}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _token() {
  const t = cleanToken(getSetting("apiToken"));
  if (!t) throw new Error(game.i18n.localize("TABLECODEX.Error.NoApiToken"));
  debug(`Token loaded — length: ${t.length}, starts with: ${t.slice(0, 4)}...`);
  return t;
}

function _headers() {
  return {
    "Authorization": `Bearer ${_token()}`,
    "Content-Type": "application/json",
  };
}

// Validates that url, token, and campaign are all present. Returns an error
// message string, or null if everything is ready.
export function validateReadyToConnect() {
  if (!(getSetting("tablecodexApiUrl") ?? "").trim()) {
    return game.i18n.localize("TABLECODEX.Error.NoApiUrl");
  }
  if (!cleanToken(getSetting("apiToken"))) {
    return game.i18n.localize("TABLECODEX.Error.NoApiToken");
  }
  if (!(getSetting("selectedCampaignId") ?? "").trim()) {
    return game.i18n.localize("TABLECODEX.Error.NoCampaign");
  }
  return null;
}

export function validateReadyToSync() {
  const base = validateReadyToConnect();
  if (base) return base;
  return null;
}

// Structured error that carries the HTTP status through the catch boundary.
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function _request(method, path, body) {
  const url = buildApiUrl(path);
  debug("API request:", method, url);

  const opts = { method, headers: _headers() };
  if (body !== undefined) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (networkErr) {
    debug("Network error hitting", url, "—", networkErr.message);
    throw new Error(
      `Connection failed. Check API URL, token, and CORS configuration. (${networkErr.message})`
    );
  }

  if (!res.ok) {
    let bodyMsg = null;
    let bodyText = null;
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const data = await res.json();
        bodyMsg = data?.message ?? data?.error ?? null;
        bodyText = JSON.stringify(data);
      } else {
        bodyText = await res.text();
        bodyMsg = bodyText || null;
      }
    } catch { /* ignore body parse errors */ }

    debug(
      `API error — status: ${res.status}, url: ${url},`,
      `body: ${bodyText ?? "(empty)"},`,
      `auth header present: ${!!opts.headers["Authorization"]},`,
      `world: ${game.world?.id ?? "?"} / ${game.world?.title ?? "?"}`
    );

    throw new ApiError(res.status, bodyMsg ?? `HTTP ${res.status}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Status-specific user messages
// ---------------------------------------------------------------------------

function _connectionErrorMessage(err) {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Missing or invalid TableCodex API token.";
    if (err.status === 403) return "TableCodex rejected the token. Regenerate the Foundry token in TableCodex and paste it here.";
  }
  return "Connection failed. Check API URL, token, and CORS configuration.";
}

// ---------------------------------------------------------------------------
// Public API client
// ---------------------------------------------------------------------------

export const apiClient = {
  async fetchCampaigns() {
    try {
      const result = await _request("GET", "/integrations/foundry/campaigns");
      const campaigns = result?.campaigns ?? [];
      log(`Fetched ${campaigns.length} campaign(s).`);
      debug("Campaigns:", campaigns.map((c) => `${c.name} (${c.id})`).join(", "));
      return { success: true, campaigns };
    } catch (err) {
      const userMsg = _connectionErrorMessage(err);
      ui.notifications.error(`TableCodex: ${userMsg}`);
      log(`fetchCampaigns failed — ${err.status ? `HTTP ${err.status} — ` : ""}${err.message}`);
      return { success: false, campaigns: [], error: err.message };
    }
  },

  async testConnection() {
    const invalid = validateReadyToConnect();
    if (invalid) {
      ui.notifications.warn(`TableCodex: ${invalid}`);
      return { success: false, error: invalid };
    }

    const campaignId   = getSetting("selectedCampaignId")   ?? "";
    const campaignName = getSetting("selectedCampaignName")  ?? "";

    const connectBody = {
      campaignId,
      foundryWorldId:   game.world?.id    ?? "",
      foundryWorldName: game.world?.title ?? "",
      systemId:         game.system?.id   ?? "",
      foundryVersion:   game.version      ?? "14",
      moduleVersion:    game.modules.get(MODULE_ID)?.version ?? "0.2.3",
    };

    debug("testConnection — url:", buildApiUrl("/integrations/foundry/connect"));
    debug("testConnection — body:", JSON.stringify({ ...connectBody }));
    debug(`testConnection — campaignId: ${campaignId}, campaignName: ${campaignName}`);

    try {
      const result = await _request("POST", "/integrations/foundry/connect", connectBody);
      log("Connection test OK:", result);
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ConnectionOk"));
      return { success: true, data: result };
    } catch (err) {
      const userMsg = _connectionErrorMessage(err);
      ui.notifications.error(`TableCodex: ${userMsg}`);
      log(`testConnection failed — ${err.status ? `HTTP ${err.status} — ` : ""}${err.message}`);
      return { success: false, error: err.message, status: err.status ?? null };
    }
  },

  async syncSession(payload) {
    const invalid = validateReadyToSync();
    if (invalid) {
      ui.notifications.warn(`TableCodex: ${invalid}`);
      return { success: false, error: invalid };
    }

    try {
      const result = await _request("POST", "/integrations/foundry/session-import", payload);
      const importId = result?.importId ?? result?.id ?? null;
      log("Session synced, importId:", importId);
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.SyncOk"));
      return { success: true, importId };
    } catch (err) {
      const userMsg = err instanceof ApiError && (err.status === 401 || err.status === 403)
        ? _connectionErrorMessage(err)
        : err.message;
      ui.notifications.error(`${game.i18n.localize("TABLECODEX.Notify.SyncFailed")}: ${userMsg}`);
      return { success: false, error: err.message, status: err.status ?? null };
    }
  },

  async getSyncStatus(importId) {
    try {
      const result = await _request("GET", `/integrations/foundry/sync-status/${importId}`);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message, status: err.status ?? null };
    }
  },
};
