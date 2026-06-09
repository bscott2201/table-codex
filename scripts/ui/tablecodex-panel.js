import { MODULE_ID, MODULE_TITLE } from "../constants.js";
import { captureManager } from "../capture/capture-manager.js";
import { getSetting, setSetting } from "../core/settings.js";
import { requireGM } from "../core/permissions.js";
import { logger } from "../core/logger.js";

export class TableCodexPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tablecodex-panel",
      title: MODULE_TITLE,
      template: `modules/${MODULE_ID}/templates/panel.hbs`,
      width: 320,
      height: "auto",
      resizable: false,
      minimizable: true,
      classes: ["tablecodex-panel"],
    });
  }

  getData() {
    const status = captureManager.getStatus();
    return {
      ...status,
      moduleTitle: MODULE_TITLE,
      isGM: game?.user?.isGM ?? false,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='start-capture']").on("click", () => this._onStartCapture());
    html.find("[data-action='stop-capture']").on("click", () => this._onStopCapture());
    html.find("[data-action='sync-now']").on("click", () => this._onSyncNow());
    html.find("[data-action='export-markdown']").on("click", () => this._onExportMarkdown());
    html.find("[data-action='clear-archive']").on("click", () => this._onClearArchive());
  }

  async _onStartCapture() {
    if (!requireGM("Start Capture")) return;

    const sessionTitle = await this._promptSessionTitle();
    if (sessionTitle === null) return;

    const campaignId = getSetting("campaignId") || "";
    const sessionId = getSetting("sessionId") || "";

    await captureManager.startCapture({ campaignId, sessionId, sessionTitle });
    this.render(true);
  }

  async _onStopCapture() {
    if (!requireGM("Stop Capture")) return;
    await captureManager.stopCapture();
    this.render(true);
  }

  async _onSyncNow() {
    if (!requireGM("Sync Now")) return;
    await captureManager.syncNow();
    this.render(true);
  }

  _onExportMarkdown() {
    captureManager.exportSessionMarkdown();
  }

  async _onClearArchive() {
    if (!requireGM("Clear Archive")) return;
    const confirmed = await Dialog.confirm({
      title: "Clear Session Archive",
      content: "<p>Are you sure you want to clear the local session archive? This cannot be undone.</p>",
    });
    if (confirmed) {
      captureManager.clearCurrentSessionArchive();
      this.render(true);
    }
  }

  async _promptSessionTitle() {
    return new Promise((resolve) => {
      new Dialog({
        title: "Start Capture",
        content: `
          <div class="form-group">
            <label>Session Title</label>
            <input type="text" id="tc-session-title" placeholder="e.g. Session 12 — The Tomb" style="width:100%">
          </div>
        `,
        buttons: {
          start: {
            icon: '<i class="fas fa-circle"></i>',
            label: "Start",
            callback: (html) => resolve(html.find("#tc-session-title").val()?.trim() || "Untitled Session"),
          },
          cancel: {
            icon: '<i class="fas fa-times"></i>',
            label: "Cancel",
            callback: () => resolve(null),
          },
        },
        default: "start",
      }).render(true);
    });
  }
}

let _panelInstance = null;

export function openTableCodexPanel() {
  if (!_panelInstance) _panelInstance = new TableCodexPanel();
  _panelInstance.render(true);
}

export function refreshTableCodexPanel() {
  if (_panelInstance?.rendered) _panelInstance.render(false);
}
