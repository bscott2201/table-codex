// @ts-check
/**
 * @file panel.js
 * The main control panel — an ApplicationV2 + HandlebarsApplicationMixin window
 * (V1 Application/FormApplication are deprecated in V14). The class is built
 * lazily on first open so `foundry.applications.*` is only referenced after the
 * core is initialized.
 *
 * The panel surfaces session control, live diagnostics, export, and sync — but
 * per the project principle, UI is secondary to telemetry fidelity.
 */

import { MODULE_ID, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { sessionManager } from "../session/session-manager.js";
import { eventStore } from "../bus/event-store.js";
import { getSetting } from "../core/settings.js";
import { jsonExporter } from "../export/json-exporter.js";
import { markdownExporter } from "../export/markdown-exporter.js";
import { uploadQueue } from "../export/upload-queue.js";
import { openCampaignLink } from "./campaign-link.js";

/** @type {any} cached singleton instance */
let _instance = null;
/** @type {any} cached class (built lazily) */
let _PanelClass = null;

/** Build (once) the ApplicationV2 panel class. */
function getPanelClass() {
  if (_PanelClass) return _PanelClass;

  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class TableCodexPanel extends HandlebarsApplicationMixin(ApplicationV2) {
    static DEFAULT_OPTIONS = {
      id: "tablecodex-panel",
      tag: "div",
      window: {
        title: "TableCodex Sync",
        icon: "fa-solid fa-scroll",
        resizable: true,
      },
      position: { width: 480, height: "auto" },
      actions: {
        startSession: TableCodexPanel._onStartSession,
        stopSession: TableCodexPanel._onStopSession,
        exportJson: TableCodexPanel._onExportJson,
        exportMarkdown: TableCodexPanel._onExportMarkdown,
        syncNow: TableCodexPanel._onSyncNow,
        linkCampaign: TableCodexPanel._onLinkCampaign,
      },
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/panel.hbs` },
    };

    /** @override */
    async _prepareContext() {
      const meta = sessionManager.meta;
      const queue = uploadQueue.snapshot();
      return {
        active: sessionManager.isActive,
        sessionId: meta?.active ? meta.id : null,
        eventCount: eventStore.size,
        campaignId: getSetting(SETTINGS.CAMPAIGN_ID) || null,
        campaignName: getSetting(SETTINGS.CAMPAIGN_NAME) || null,
        apiUrl: getSetting(SETTINGS.API_URL) || null,
        worldName: game.world?.title,
        systemId: `${game.system?.id}@${game.system?.version}`,
        queuePending: queue.pending,
        queueFailed: queue.failed,
      };
    }

    static async _onStartSession() {
      await sessionManager.start();
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
      await uploadQueue.process();
      _instance?.render();
    }
    static _onLinkCampaign() {
      openCampaignLink();
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
