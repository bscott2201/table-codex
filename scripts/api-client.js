import { MODULE_ID, getSetting, setSetting, cleanToken } from "./settings.js";
import { log, debug } from "./logger.js";
import { getWorldInfo } from "./world-info.js";

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
// Validators
// ---------------------------------------------------------------------------

export function validateApiCredentials() {
  if (!(getSetting("tablecodexApiUrl") ?? "").trim()) {
    return game.i18n.localize("TABLECODEX.Error.NoApiUrl");
  }
  if (!cleanToken(getSetting("apiToken"))) {
    return game.i18n.localize("TABLECODEX.Error.NoApiToken");
  }
  return null;
}

export function validateReadyToSync() {
  const base = validateApiCredentials();
  if (base) return base;
  if (!_safeCampaignId()) {
    return game.i18n.localize("TABLECODEX.Error.NoCampaign");
  }
  return null;
}

// Returns a clean campaign ID string, or null if it's missing/invalid.
function _safeCampaignId() {
  const raw = getSetting("selectedCampaignId");
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null" || trimmed === "[object Object]") {
    return null;
  }
  return trimmed;
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

class ApiError extends Error {
  constructor(status, message, missingFields) {
    super(message);
    this.status = status;
    this.missingFields = missingFields ?? null;
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
    let missingFields = null;
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        const data = await res.json();
        bodyMsg = data?.message ?? data?.error ?? null;
        missingFields = Array.isArray(data?.missingFields) ? data.missingFields : null;
        bodyText = JSON.stringify(data);
      } else {
        bodyText = await res.text();
        bodyMsg = bodyText || null;
      }
    } catch { /* ignore */ }

    debug(
      `API error — status: ${res.status}, url: ${url},`,
      `body: ${bodyText ?? "(empty)"},`,
      `auth present: ${!!opts.headers["Authorization"]},`,
      `world: ${game.world?.id ?? "?"} / ${game.world?.title ?? "?"}`
    );

    throw new ApiError(res.status, bodyMsg ?? `HTTP ${res.status}`, missingFields);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return { ok: true };
}

function _authErrorMessage(err) {
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
  // Step 1 — verify token is valid. Does NOT require a selected campaign.
  // Gracefully handles 404 (endpoint not deployed yet) without blocking the flow.
  async pingApi() {
    const invalid = validateApiCredentials();
    if (invalid) {
      ui.notifications.warn(`TableCodex: ${invalid}`);
      return { success: false, error: invalid };
    }

    debug("pingApi — url:", buildApiUrl("/integrations/foundry/ping"));

    try {
      const result = await _request("GET", "/integrations/foundry/ping");
      log("Ping OK:", result?.status, "| scopes:", result?.availableScopes?.join(", "));
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.PingOk"));
      return { success: true, data: result };
    } catch (err) {
      // 404 means the route doesn't exist yet on the backend — not an auth failure.
      if (err instanceof ApiError && err.status === 404) {
        const advisory = "Ping endpoint not available yet. Try Fetch Campaigns to verify token access.";
        ui.notifications.warn(`TableCodex: ${advisory}`);
        log("pingApi: 404 — endpoint not deployed. Token may still be valid.");
        return { success: false, notFound: true, error: advisory, status: 404 };
      }
      const userMsg = _authErrorMessage(err);
      ui.notifications.error(`TableCodex: ${userMsg}`);
      log(`pingApi failed — ${err.status ? `HTTP ${err.status} — ` : ""}${err.message}`);
      return { success: false, error: err.message, status: err.status ?? null };
    }
  },

  // Step 2 — fetch available campaigns. Does NOT require a selected campaign.
  async fetchCampaigns() {
    const invalid = validateApiCredentials();
    if (invalid) {
      ui.notifications.warn(`TableCodex: ${invalid}`);
      return { success: false, campaigns: [], error: invalid };
    }

    try {
      const result = await _request("GET", "/integrations/foundry/campaigns");
      const campaigns = result?.campaigns ?? [];
      log(`Fetched ${campaigns.length} campaign(s).`);
      debug("Campaigns:", campaigns.map((c) => `${c.name} (${c.id})`).join(", "));
      return { success: true, campaigns };
    } catch (err) {
      const userMsg = _authErrorMessage(err);
      ui.notifications.error(`TableCodex: ${userMsg}`);
      log(`fetchCampaigns failed — ${err.status ? `HTTP ${err.status} — ` : ""}${err.message}`);
      return { success: false, campaigns: [], error: err.message };
    }
  },

  // Step 3 — confirm campaign + world pairing. Requires a selected campaign.
  async linkWorld() {
    const campaignId = _safeCampaignId();
    if (!campaignId) {
      const msg = "Select a TableCodex campaign before linking this world.";
      ui.notifications.warn(`TableCodex: ${msg}`);
      return { success: false, error: msg };
    }

    const wi = getWorldInfo();
    const campaignName = getSetting("selectedCampaignName") ?? "";

    // Pre-flight: surface any missing world fields before hitting the server
    const missingLocally = [];
    if (!wi.foundryWorldId || wi.foundryWorldId === "unknown-world") missingLocally.push("foundryWorldId");
    if (!wi.foundryWorldName || wi.foundryWorldName === "Unknown World") missingLocally.push("foundryWorldName");
    if (!wi.systemId || wi.systemId === "unknown") missingLocally.push("systemId");

    if (missingLocally.length > 0) {
      const msg = `Cannot link world — missing: ${missingLocally.join(", ")}. Is the world fully loaded?`;
      ui.notifications.error(`TableCodex: ${msg}`);
      log("linkWorld pre-flight failed:", msg);
      return { success: false, error: msg };
    }

    const body = {
      campaignId,
      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
      systemId:         wi.systemId,
      foundryVersion:   wi.foundryVersion,
      moduleVersion:    wi.moduleVersion,
    };

    debug("linkWorld — url:", buildApiUrl("/integrations/foundry/connect"));
    debug("linkWorld — body:", JSON.stringify(body));
    debug(`linkWorld — campaignId: ${campaignId}, campaignName: ${campaignName}`);
    debug(`linkWorld — foundryWorldId: ${wi.foundryWorldId}, foundryWorldName: ${wi.foundryWorldName}`);
    debug(`linkWorld — systemId: ${wi.systemId}, foundryVersion: ${wi.foundryVersion}, moduleVersion: ${wi.moduleVersion}`);

    try {
      const result = await _request("POST", "/integrations/foundry/connect", body);
      await setSetting("worldLinked", true);
      log("World linked OK:", result);
      ui.notifications.info(
        game.i18n.format("TABLECODEX.Notify.WorldLinked", { campaign: campaignName })
      );
      return { success: true, data: result };
    } catch (err) {
      await setSetting("worldLinked", false);

      log("linkWorld failed —",
        `HTTP ${err.status ?? "?"} |`,
        `campaignId: ${campaignId} |`,
        `foundryWorldId: ${wi.foundryWorldId} |`,
        `foundryWorldName: ${wi.foundryWorldName} |`,
        `systemId: ${wi.systemId} |`,
        `foundryVersion: ${wi.foundryVersion} |`,
        `moduleVersion: ${wi.moduleVersion} |`,
        `error: ${err.message}`
      );

      if (err instanceof ApiError && err.status === 400 && err.missingFields?.length) {
        const msg = `Missing required fields: ${err.missingFields.join(", ")}`;
        ui.notifications.error(`TableCodex: ${msg}`);
        return { success: false, error: msg, status: 400 };
      }

      const userMsg = _authErrorMessage(err);
      ui.notifications.error(`TableCodex: ${userMsg}`);
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
        ? _authErrorMessage(err)
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
