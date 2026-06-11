import { MODULE_ID, getSetting } from "./settings.js";
import { log } from "./logger.js";

function _base() {
  let url = (getSetting("tablecodexApiUrl") ?? "").trim().replace(/\/$/, "");
  if (!url) throw new Error(game.i18n.localize("TABLECODEX.Error.NoApiUrl"));
  return url;
}

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
  };
}

async function _request(method, path, body) {
  const url = `${_base()}${path}`;
  const opts = {
    method,
    headers: _headers(),
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.message ?? data?.error ?? msg;
    } catch { /* ignore parse error */ }
    throw new Error(msg);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return { ok: true };
}

export const apiClient = {
  async testConnection() {
    try {
      const result = await _request("POST", "/api/integrations/foundry/connect", {
        worldId: game.world?.id ?? "",
        worldName: game.world?.title ?? "",
        foundryVersion: game.version ?? "14",
        moduleVersion: game.modules.get(MODULE_ID)?.version ?? "0.1.0",
      });
      log("Connection test OK:", result);
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ConnectionOk"));
      return { success: true, data: result };
    } catch (err) {
      ui.notifications.error(`${game.i18n.localize("TABLECODEX.Notify.ConnectionFailed")}: ${err.message}`);
      return { success: false, error: err.message };
    }
  },

  async syncSession(payload) {
    try {
      const result = await _request("POST", "/api/integrations/foundry/session-import", payload);
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
      const result = await _request("GET", `/api/integrations/foundry/sync-status/${importId}`);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  },
};
