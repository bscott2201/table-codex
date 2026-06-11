import { MODULE_ID, getSetting } from "./settings.js";
import { log, debug } from "./logger.js";

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(url) {
  // Strip trailing slashes, then strip a trailing /api segment so callers
  // that enter either "https://host" or "https://host/api" both work.
  return (url ?? "").trim().replace(/\/+$/, "").replace(/\/api$/, "");
}

export function buildApiUrl(path) {
  const raw = getSetting("tablecodexApiUrl") ?? "";
  if (!raw.trim()) throw new Error(game.i18n.localize("TABLECODEX.Error.NoApiUrl"));
  // path must start with /integrations/... (no /api prefix — we add it here)
  return `${normalizeBaseUrl(raw)}/api${path}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _token() {
  const t = getSetting("apiToken") ?? "";
  if (!t) throw new Error(game.i18n.localize("TABLECODEX.Error.NoApiToken"));
  return t;
}

function _headers() {
  return {
    "Authorization": `Bearer ${_token()}`,
    "Content-Type": "application/json",
    "X-Foundry-Module": MODULE_ID,
    "X-Foundry-Version": game.version ?? "14",
    "X-TableCodex-World-Id": game.world?.id ?? "",
  };
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
    debug("Network error:", networkErr);
    throw new Error(
      `Connection failed. Check API URL, token, and CORS configuration. (${networkErr.message})`
    );
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.message ?? data?.error ?? msg;
    } catch { /* ignore parse error */ }
    debug("API error response:", res.status, msg, "URL:", url);
    throw new Error(msg);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public API client
// ---------------------------------------------------------------------------

export const apiClient = {
  async testConnection() {
    try {
      const result = await _request("POST", "/integrations/foundry/connect", {
        worldId: game.world?.id ?? "",
        worldName: game.world?.title ?? "",
        foundryVersion: game.version ?? "14",
        moduleVersion: game.modules.get(MODULE_ID)?.version ?? "0.1.0",
      });
      log("Connection test OK:", result);
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ConnectionOk"));
      return { success: true, data: result };
    } catch (err) {
      const msg = "Connection failed. Check API URL, token, and CORS configuration.";
      ui.notifications.error(`TableCodex: ${msg}`);
      debug("testConnection error:", err.message);
      return { success: false, error: err.message };
    }
  },

  async syncSession(payload) {
    try {
      const result = await _request("POST", "/integrations/foundry/session-import", payload);
      const importId = result?.importId ?? result?.id ?? null;
      log("Session synced, importId:", importId);
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.SyncOk"));
      return { success: true, importId };
    } catch (err) {
      ui.notifications.error(`${game.i18n.localize("TABLECODEX.Notify.SyncFailed")}: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  async getSyncStatus(importId) {
    try {
      const result = await _request("GET", `/integrations/foundry/sync-status/${importId}`);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
