import { getSetting, setSetting, cleanToken } from "./settings.js";
import { sessionRecorder } from "./session-recorder.js";
import { exportJson, exportMarkdown, syncSession } from "./exporter.js";
import { apiClient } from "./api-client.js";

// ---------------------------------------------------------------------------
// Session panel application
// ---------------------------------------------------------------------------

export class TableCodexPanel extends Application {
  constructor(...args) {
    super(...args);
    // Transient state — resets on page reload (appropriate, API availability is unknown)
    this._campaigns  = [];               // populated by fetchCampaigns
    this._apiState   = "untested";       // "untested" | "ok" | "unavailable" | "failed"
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id:        "tablecodex-panel",
      title:     "TableCodex Sync",
      template:  "modules/tablecodex-sync/templates/session-panel.hbs",
      width:     380,
      height:    "auto",
      resizable: false,
      classes:   ["tablecodex-panel"],
    });
  }

  getData() {
    const sess         = sessionRecorder.session;
    const stats        = sessionRecorder.stats;
    const isActive     = sessionRecorder.isActive;
    const campaignId   = getSetting("selectedCampaignId")   ?? "";
    const campaignName = getSetting("selectedCampaignName") ?? "";
    const worldLinked  = getSetting("worldLinked")          ?? false;
    const apiUrl       = (getSetting("tablecodexApiUrl")    ?? "").trim();
    const tokenLen     = cleanToken(getSetting("apiToken")).length;

    return {
      // API connection state
      apiState:   this._apiState,        // "untested" | "ok" | "failed"
      hasApiUrl:  !!apiUrl,
      hasToken:   tokenLen > 0,
      tokenHint:  tokenLen > 0 ? `configured (${tokenLen} chars)` : "not set",

      // Campaign / world-link state
      hasCampaign:  !!(campaignId.trim()),
      campaignId,
      campaignName,
      worldLinked,
      worldName: game.world?.title ?? "",

      // Campaign selector
      campaigns:          this._campaigns,
      hasFetchedCampaigns: this._campaigns.length > 0,

      // Session
      isActive,
      sessionTitle:   sess?.sessionTitle   ?? "",
      localSessionId: sess?.localSessionId ?? "—",
      startedAt: sess?.startedAt ? new Date(sess.startedAt).toLocaleString() : "—",
      endedAt:   sess?.endedAt   ? new Date(sess.endedAt).toLocaleString()   : "—",
      synced:         sess?.synced         ?? false,
      remoteImportId: sess?.remoteImportId ?? null,
      stats,
      hasSession: sess !== null,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[data-action='ping-api']").on("click",        () => this._onPingApi());
    html.find("[data-action='fetch-campaigns']").on("click", () => this._onFetchCampaigns());
    html.find("[data-action='save-campaign']").on("click",   () => this._onSaveCampaign(html));
    html.find("[data-action='link-world']").on("click",      () => this._onLinkWorld());
    html.find("[data-action='start-session']").on("click",   () => this._onStartSession());
    html.find("[data-action='end-session']").on("click",     () => this._onEndSession());
    html.find("[data-action='export-json']").on("click",     () => exportJson());
    html.find("[data-action='export-md']").on("click",       () => exportMarkdown());
    html.find("[data-action='sync-session']").on("click",    () => this._onSync());
    html.find("[data-action='clear-buffer']").on("click",    () => this._onClearBuffer());
    html.find("[data-action='open-settings']").on("click",   () => new SettingsConfig({}).render(true));
  }

  // Step 1 — verify token is valid (no campaign required)
  async _onPingApi() {
    const result = await apiClient.pingApi();

    if (result.success) {
      this._apiState = "ok";
    } else if (result.notFound) {
      // 404 means the ping route isn't deployed yet — treat as "unavailable" not "broken"
      this._apiState = "unavailable";
    } else {
      this._apiState = "failed";
    }

    this.render();

    // Auto-fetch campaigns regardless of ping outcome as long as credentials exist
    // (ping 404 doesn't mean the token is bad)
    if (result.success || result.notFound) {
      if (this._campaigns.length === 0) {
        await this._onFetchCampaigns();
      }
    }
  }

  // Step 2 — populate campaign list (no campaign required)
  async _onFetchCampaigns() {
    const result = await apiClient.fetchCampaigns();
    if (!result.success) return;

    this._campaigns = result.campaigns;

    // Auto-select if exactly one campaign and none is saved yet
    const currentId = (getSetting("selectedCampaignId") ?? "").trim();
    if (result.campaigns.length === 1 && !currentId) {
      const c = result.campaigns[0];
      // Guard: only save if we have a real string id
      if (c.id && typeof c.id === "string" && c.id.trim()) {
        await setSetting("selectedCampaignId",   c.id.trim());
        await setSetting("selectedCampaignName", c.name ?? "");
        ui.notifications.info(
          game.i18n.format("TABLECODEX.Notify.CampaignAutoSelected", { name: c.name })
        );
      }
    } else if (result.campaigns.length === 0) {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignsFound"));
    }

    this.render();
  }

  // Step 3a — save campaign selection from dropdown
  async _onSaveCampaign(html) {
    const rawId = html.find("[data-campaign-select]").val();

    // Defensive: reject empty, "undefined", "null", "[object Object]"
    const id = (typeof rawId === "string") ? rawId.trim() : "";
    if (!id || id === "undefined" || id === "null" || id === "[object Object]") {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignSelected"));
      return;
    }

    const campaign = this._campaigns.find((c) => c.id === id);
    if (!campaign) {
      ui.notifications.warn("Selected campaign not found in list. Try Fetch Campaigns again.");
      return;
    }

    await setSetting("selectedCampaignId",   campaign.id);
    await setSetting("selectedCampaignName", campaign.name ?? "");
    ui.notifications.info(
      game.i18n.format("TABLECODEX.Notify.CampaignLinked", { name: campaign.name })
    );
    this.render();
  }

  // Step 3b — confirm the campaign + world pairing with the server
  async _onLinkWorld() {
    const result = await apiClient.linkWorld();
    this.render();
    return result;
  }

  async _onStartSession() {
    if (!(getSetting("selectedCampaignId") ?? "").trim()) {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignForSession"));
    }
    const title = await _promptSessionTitle();
    if (title === null) return;
    await sessionRecorder.start({ sessionTitle: title });
    this.render();
  }

  async _onEndSession() {
    const confirmed = await Dialog.confirm({
      title:   game.i18n.localize("TABLECODEX.Dialog.EndSession.Title"),
      content: `<p>${game.i18n.localize("TABLECODEX.Dialog.EndSession.Content")}</p>`,
    });
    if (!confirmed) return;
    await sessionRecorder.stop();
    this.render();
  }

  async _onSync() {
    await syncSession();
    this.render();
  }

  async _onClearBuffer() {
    const confirmed = await Dialog.confirm({
      title:   game.i18n.localize("TABLECODEX.Dialog.ClearBuffer.Title"),
      content: `<p>${game.i18n.localize("TABLECODEX.Dialog.ClearBuffer.Content")}</p>`,
    });
    if (!confirmed) return;
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

  const tokenGroup = Array.isArray(controls)
    ? controls.find((c) => c.name === "token" || c.name === "tokens")
    : (controls.tokens ?? controls.token);

  if (!tokenGroup?.tools) return;

  const panelTool = {
    name:     "tablecodex-panel",
    title:    "TableCodex Sync",
    icon:     "fas fa-scroll",
    button:   true,
    onChange: () => openPanel(),
  };

  const sessionTool = {
    name:   "tablecodex-session",
    title:  isActive
      ? game.i18n.localize("TABLECODEX.Controls.StopSession")
      : game.i18n.localize("TABLECODEX.Controls.StartSession"),
    icon:   isActive ? "fas fa-stop-circle" : "fas fa-circle",
    button: true,
    onChange: async () => {
      if (sessionRecorder.isActive) {
        await sessionRecorder.stop();
      } else {
        if (!(getSetting("selectedCampaignId") ?? "").trim()) {
          ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignForSession"));
        }
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
    tokenGroup.tools["tablecodex-panel"]   = panelTool;
    tokenGroup.tools["tablecodex-session"] = sessionTool;
  }
}

// ---------------------------------------------------------------------------
// Prompt helper
// ---------------------------------------------------------------------------

async function _promptSessionTitle() {
  return new Promise((resolve) => {
    new Dialog({
      title:   game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Title"),
      content: `
        <form>
          <div class="form-group">
            <label>${game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Label")}</label>
            <input type="text" name="title"
              placeholder="${game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Placeholder")}"
              autofocus />
          </div>
        </form>`,
      buttons: {
        ok: {
          label:    game.i18n.localize("TABLECODEX.Dialog.SessionTitle.Start"),
          callback: (html) => resolve(html.find("[name='title']").val() ?? ""),
        },
        cancel: {
          label:    game.i18n.localize("Cancel"),
          callback: () => resolve(null),
        },
      },
      default: "ok",
      close:   () => resolve(null),
    }).render(true);
  });
}
