import { sessionRecorder } from "./session-recorder.js";
import { exportJson, exportMarkdown, syncSession } from "./exporter.js";
import { apiClient } from "./api-client.js";

// ---------------------------------------------------------------------------
// Session panel application
// ---------------------------------------------------------------------------

export class TableCodexPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "tablecodex-panel",
      title: "TableCodex Sync",
      template: "modules/tablecodex-sync/templates/session-panel.hbs",
      width: 360,
      height: "auto",
      resizable: false,
      classes: ["tablecodex-panel"],
    });
  }

  getData() {
    const sess = sessionRecorder.session;
    const stats = sessionRecorder.stats;
    const isActive = sessionRecorder.isActive;

    return {
      isActive,
      sessionTitle: sess?.sessionTitle ?? "",
      localSessionId: sess?.localSessionId ?? "—",
      startedAt: sess?.startedAt ? new Date(sess.startedAt).toLocaleString() : "—",
      endedAt: sess?.endedAt ? new Date(sess.endedAt).toLocaleString() : "—",
      synced: sess?.synced ?? false,
      remoteImportId: sess?.remoteImportId ?? null,
      stats,
      hasSession: sess !== null,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='start-session']").on("click", () => this._onStartSession());
    html.find("[data-action='end-session']").on("click", () => this._onEndSession());
    html.find("[data-action='export-json']").on("click", () => { exportJson(); });
    html.find("[data-action='export-md']").on("click", () => { exportMarkdown(); });
    html.find("[data-action='sync-session']").on("click", () => this._onSync());
    html.find("[data-action='clear-buffer']").on("click", () => this._onClearBuffer());
    html.find("[data-action='test-connection']").on("click", () => apiClient.testConnection());
    html.find("[data-action='open-settings']").on("click", () => {
      new SettingsConfig({}).render(true);
    });
  }

  async _onStartSession() {
    const title = await _promptSessionTitle();
    if (title === null) return;
    await sessionRecorder.start({ sessionTitle: title });
    this.render();
  }

  async _onEndSession() {
    const confirm = await Dialog.confirm({
      title: game.i18n.localize("TABLECODEX.Dialog.EndSession.Title"),
      content: `<p>${game.i18n.localize("TABLECODEX.Dialog.EndSession.Content")}</p>`,
    });
    if (!confirm) return;
    await sessionRecorder.stop();
    this.render();
  }

  async _onSync() {
    await syncSession();
    this.render();
  }

  async _onClearBuffer() {
    const confirm = await Dialog.confirm({
      title: game.i18n.localize("TABLECODEX.Dialog.ClearBuffer.Title"),
      content: `<p>${game.i18n.localize("TABLECODEX.Dialog.ClearBuffer.Content")}</p>`,
    });
    if (!confirm) return;
    await sessionRecorder.clearBuffer();
    this.render();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _panel = null;

export function openPanel() {
  if (!_panel) _panel = new TableCodexPanel();
  _panel.render(true);
}

export function refreshPanel() {
  _panel?.render();
}

// ---------------------------------------------------------------------------
// Scene controls button injection (GM only)
// ---------------------------------------------------------------------------

export function injectSceneControls(controls) {
  if (!game.user?.isGM) return;

  const isActive = sessionRecorder.isActive;

  // V14: controls is a plain object keyed by group name
  const tokenGroup = Array.isArray(controls)
    ? controls.find((c) => c.name === "token" || c.name === "tokens")
    : (controls.tokens ?? controls.token);

  if (!tokenGroup?.tools) return;

  const panelTool = {
    name: "tablecodex-panel",
    title: "TableCodex Sync",
    icon: "fas fa-scroll",
    button: true,
    onChange: () => openPanel(),
  };

  const sessionTool = {
    name: "tablecodex-session",
    title: isActive
      ? game.i18n.localize("TABLECODEX.Controls.StopSession")
      : game.i18n.localize("TABLECODEX.Controls.StartSession"),
    icon: isActive ? "fas fa-stop-circle" : "fas fa-circle",
    button: true,
    onChange: async () => {
      if (sessionRecorder.isActive) {
        await sessionRecorder.stop();
      } else {
        const title = await _promptSessionTitle();
        if (title === null) return;
        await sessionRecorder.start({ sessionTitle: title });
      }
      ui.controls?.render();
    },
  };

  if (Array.isArray(tokenGroup.tools)) {
    tokenGroup.tools.push(panelTool, sessionTool);
  } else {
    tokenGroup.tools["tablecodex-panel"] = panelTool;
    tokenGroup.tools["tablecodex-session"] = sessionTool;
  }
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

async function _promptSessionTitle() {
  return new Promise((resolve) => {
    new Dialog({
      title: game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Title"),
      content: `
        <form>
          <div class="form-group">
            <label>${game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Label")}</label>
            <input type="text" name="title" placeholder="${game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Placeholder")}" autofocus />
          </div>
        </form>`,
      buttons: {
        ok: {
          label: game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Start"),
          callback: (html) => resolve(html.find("[name='title']").val() ?? ""),
        },
        cancel: {
          label: game.i18n.localize("Cancel"),
          callback: () => resolve(null),
        },
      },
      default: "ok",
      close: () => resolve(null),
    }).render(true);
  });
}
