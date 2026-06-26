// @ts-check
/**
 * @file panel.js
 * The single TableCodex control window — an ApplicationV2 + HandlebarsApplicationMixin
 * (V1 Application/FormApplication are deprecated in V14). Built lazily on first open
 * so `foundry.applications.*` is only referenced after the core is initialized.
 *
 * This window unifies what used to be two windows: session control (start/stop,
 * export, sync, live diagnostics) AND campaign linking (API URL/token, test, load
 * campaigns, pick campaign). Starting a session opens a small dialog to name it; the
 * name becomes the TableCodex session title.
 */

import { MODULE_ID, MODULE_VERSION, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { sessionManager } from "../session/session-manager.js";
import { eventStore } from "../bus/event-store.js";
import { getSetting, setSetting } from "../core/settings.js";
import { jsonExporter } from "../export/json-exporter.js";
import { markdownExporter } from "../export/markdown-exporter.js";
import { uploadQueue } from "../export/upload-queue.js";
import { apiClient } from "../export/api-client.js";

/** @type {any} cached singleton instance */
let _instance = null;
/** @type {any} cached class (built lazily) */
let _PanelClass = null;

/** Minimal HTML-attribute escape for injecting a default value into dialog markup. */
function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build (once) the ApplicationV2 panel class. */
function getPanelClass() {
  if (_PanelClass) return _PanelClass;

  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class TableCodexPanel extends HandlebarsApplicationMixin(ApplicationV2) {
    /** @type {{id:string,name:string}[]} campaigns fetched from the API (empty until loaded) */
    _campaigns = [];
    /** @type {{ok:boolean,message:string}|null} last test/load/save result */
    _status = null;

    static DEFAULT_OPTIONS = {
      id: "tablecodex-panel",
      tag: "div",
      window: {
        title: "TableCodex Sync",
        icon: "fa-solid fa-scroll",
        resizable: true,
      },
      position: { width: 500, height: "auto" },
      actions: {
        startSession: TableCodexPanel._onStartSession,
        stopSession: TableCodexPanel._onStopSession,
        exportJson: TableCodexPanel._onExportJson,
        exportMarkdown: TableCodexPanel._onExportMarkdown,
        syncNow: TableCodexPanel._onSyncNow,
        testConnection: TableCodexPanel._onTest,
        loadCampaigns: TableCodexPanel._onLoadCampaigns,
        saveLink: TableCodexPanel._onSaveLink,
      },
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/panel.hbs` },
    };

    /** @override */
    async _prepareContext() {
      const meta = sessionManager.meta;
      const queue = uploadQueue.snapshot();
      const selectedId = getSetting(SETTINGS.CAMPAIGN_ID) || "";
      const linked = Boolean(selectedId);
      return {
        active: sessionManager.isActive,
        sessionId: meta?.active ? meta.id : null,
        sessionName: meta?.active ? meta.title ?? null : null,
        eventCount: eventStore.size,
        campaignId: selectedId || null,
        campaignName: getSetting(SETTINGS.CAMPAIGN_NAME) || null,
        apiUrl: getSetting(SETTINGS.API_URL) || "",
        apiToken: getSetting(SETTINGS.API_TOKEN) || "",
        worldName: game.world?.title,
        systemId: `${game.system?.id}@${game.system?.version}`,
        queuePending: queue.pending,
        queueFailed: queue.failed,
        // Connection / campaign section
        linked,
        // Keep the connection section open until a campaign is linked, so first-run
        // setup is obvious; collapse it once linked to keep the focus on sessions.
        connectionOpen: !linked,
        campaigns: this._campaigns.map((c) => ({
          ...c,
          selected: String(c.id) === String(selectedId),
        })),
        hasCampaigns: this._campaigns.length > 0,
        status: this._status,
      };
    }

    /** A sensible default session name: "<World> — <date>". */
    _defaultSessionName() {
      const world = game.world?.title ?? "Session";
      const date = new Date().toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      return `${world} — ${date}`;
    }

    /**
     * @this {any}
     * Prompt for a session name, then start recording. The name becomes the
     * TableCodex session title. Cancelling the dialog aborts the start.
     */
    static async _onStartSession() {
      const def = this._defaultSessionName();
      let title = def;
      try {
        const DialogV2 = foundry.applications?.api?.DialogV2;
        if (DialogV2?.prompt) {
          const result = await DialogV2.prompt({
            window: { title: "Start TableCodex Session", icon: "fa-solid fa-play" },
            content: `<div class="form-group tc-name-dialog">
                <label for="tc-session-name">Session name</label>
                <input id="tc-session-name" name="sessionName" type="text"
                       value="${escapeAttr(def)}" autofocus />
                <p class="tc-hint">This becomes the session's title in TableCodex.</p>
              </div>`,
            ok: {
              label: "Start recording",
              icon: "fa-solid fa-circle-dot",
              callback: (_event, button) =>
                button.form?.elements?.sessionName?.value ?? def,
            },
            rejectClose: false,
          });
          // null/undefined → dialog dismissed; don't start.
          if (result === null || result === undefined) return;
          title = String(result).trim() || def;
        }
      } catch (err) {
        logger.warn("panel: name dialog unavailable, starting with default name", err);
      }
      await sessionManager.start({ title });
      _instance?.render();
    }

    static async _onStopSession() {
      await sessionManager.stop();
      _instance?.render();
    }

    static _onExportJson() {
      jsonExporter.download();
    }

    static _onExportMarkdown() {
      markdownExporter.download();
    }

    static async _onSyncNow() {
      const { snapshot, error } = await uploadQueue.syncNow();
      if (error) {
        ui.notifications?.warn(`TableCodex: ${error}`);
      } else if (snapshot.failed > 0) {
        ui.notifications?.error(`TableCodex: ${snapshot.failed} session(s) failed to sync (see console).`);
      } else if (snapshot.pending > 0) {
        ui.notifications?.info(`TableCodex: syncing ${snapshot.pending} session(s)…`);
      } else {
        ui.notifications?.info("TableCodex: sync complete — nothing pending.");
      }
      _instance?.render();
    }

    // ── Connection / campaign linking (merged from the old campaign-link window) ──

    /**
     * @this {any}
     * Persist the API URL/token currently typed so the API client (which reads from
     * settings) uses fresh values before a test/fetch.
     */
    async _syncCredsFromForm() {
      const root = this.element;
      if (!root) return;
      const url = root.querySelector('[name="apiUrl"]')?.value ?? "";
      const token = root.querySelector('[name="apiToken"]')?.value ?? "";
      await setSetting(SETTINGS.API_URL, url.trim());
      await setSetting(SETTINGS.API_TOKEN, token.trim());
    }

    /** @this {any} */
    static async _onTest() {
      await this._syncCredsFromForm();
      const result = await apiClient.testConnection();
      this._status = result.ok
        ? { ok: true, message: `Connected (${result.detail ?? "verified"}).` }
        : { ok: false, message: result.error ?? "Connection failed." };
      if (result.ok) ui.notifications?.info(`TableCodex: ${this._status.message}`);
      else ui.notifications?.error(`TableCodex: ${this._status.message}`);
      this.render();
    }

    /** @this {any} Fetch the campaign list into the dropdown. */
    static async _onLoadCampaigns() {
      await this._syncCredsFromForm();
      const result = await apiClient.listCampaigns();
      if (result.ok) {
        this._campaigns = result.data ?? [];
        this._status = { ok: true, message: `Loaded ${this._campaigns.length} campaign(s).` };
        if (this._campaigns.length === 0) {
          ui.notifications?.warn("TableCodex: no campaigns found for this token.");
        }
      } else {
        this._campaigns = [];
        this._status = { ok: false, message: result.error ?? "Failed to load campaigns." };
        ui.notifications?.error(`TableCodex: ${this._status.message}`);
      }
      this.render();
    }

    /** @this {any} Save API creds + campaign selection, then register with server. */
    static async _onSaveLink() {
      const root = this.element;
      if (!root) return;
      const url = (root.querySelector('[name="apiUrl"]')?.value ?? "").trim();
      const token = (root.querySelector('[name="apiToken"]')?.value ?? "").trim();
      const campaignId = (root.querySelector('[name="campaignId"]')?.value ?? "").trim();
      // Name comes from the fetched list when a dropdown was used; otherwise the
      // manual name field.
      const matched = this._campaigns.find((c) => String(c.id) === campaignId);
      const manualName = (root.querySelector('[name="campaignName"]')?.value ?? "").trim();
      const campaignName = matched?.name ?? manualName;

      await setSetting(SETTINGS.API_URL, url);
      await setSetting(SETTINGS.API_TOKEN, token);
      await setSetting(SETTINGS.CAMPAIGN_ID, campaignId);
      await setSetting(SETTINGS.CAMPAIGN_NAME, campaignName);

      if (campaignId) {
        // Register the world connection with the server so the campaign dashboard
        // shows this world as linked. The server now requires campaignId in the
        // connect body, so we do this explicitly here rather than waiting for sync.
        const connectResult = await apiClient.connectWorld({
          campaignId: Number(campaignId),
          foundryWorldId: game.world?.id ?? "",
          foundryWorldName: game.world?.title ?? "",
          systemId: game.system?.id,
          foundryVersion: game.version ?? undefined,
          moduleVersion: MODULE_VERSION,
        });
        if (connectResult.ok) {
          this._status = { ok: true, message: `Linked to ${campaignName || campaignId}.` };
          ui.notifications?.info("TableCodex: campaign linked and registered with server.");
        } else {
          this._status = {
            ok: false,
            message: `Settings saved — server registration failed: ${connectResult.error ?? "unknown error"}. Check your API URL and token.`,
          };
          ui.notifications?.warn(`TableCodex: ${this._status.message}`);
        }
      } else {
        this._status = { ok: true, message: "Saved (no campaign selected)." };
        ui.notifications?.info("TableCodex: settings saved.");
      }

      logger.info(`panel: campaign link saved (${campaignId || "none"})`);
      this.render();
    }
  }

  _PanelClass = TableCodexPanel;
  return _PanelClass;
}

/** Open (or focus) the panel. */
export function openPanel() {
  try {
    const Cls = getPanelClass();
    if (!_instance) _instance = new Cls();
    _instance.render(true);
  } catch (err) {
    logger.error("panel: failed to open", err);
    ui.notifications?.error("TableCodex: failed to open panel (see console).");
  }
}

/** Re-render the panel if it is open. */
export function refreshPanel() {
  if (_instance?.rendered) _instance.render();
}
