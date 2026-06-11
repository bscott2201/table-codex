// TableCodex Sync — main.js
// Entry point. All top-level code here is plain JS with no Foundry class references.
// Foundry globals (Application, FormApplication, etc.) are only referenced inside
// hook callbacks, which fire after Foundry's core has fully initialised.

import { MODULE_ID, MODULE_TITLE, MODULE_VERSION, registerSettings, getSetting, setSetting } from "./settings.js";
import { log, debug } from "./logger.js";
import { sessionRecorder } from "./session-recorder.js";
import { normalizeChat, normalizeCombatEvent, normalizeSceneView, normalizeActorEvent, normalizeItemEvent, normalizeJournalEvent } from "./event-normalizer.js";
import { openPanel, refreshPanel, injectSceneControls, openUnsyncedDialog } from "./ui.js";
import { apiClient } from "./api-client.js";
import { getPendingSessions } from "./session-store.js";

// Expose a placeholder immediately so the console helper works even before ready.
globalThis.TableCodexSync = {
  openPanel: () => console.warn("[TableCodex Sync] Not ready yet — wait for the ready hook"),
  status: "loading",
};

console.log("[TableCodex Sync] main.js evaluated");

// ---------------------------------------------------------------------------
// Settings menu
// ---------------------------------------------------------------------------

function registerSettingsMenu() {
  // The class is defined inside this function so that FormApplication is only
  // referenced when the function is called (inside the init hook), not at
  // module parse time when Foundry may not have set up its class globals yet.
  class TableCodexSettingsMenu extends FormApplication {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id:       "tablecodex-settings-menu",
        title:    MODULE_TITLE,
        template: "modules/" + MODULE_ID + "/templates/blank.hbs",
        width:    1,
        height:   1,
      });
    }
    async _updateObject() {}
    async render(_force, _options) {
      openPanel();
      return this;
    }
  }

  game.settings.registerMenu(MODULE_ID, "openPanel", {
    name:       "TableCodex Sync Panel",
    label:      "Open TableCodex Sync",
    hint:       "Open the TableCodex Sync panel for API connection, campaign selection, session capture, export, and sync.",
    icon:       "fa-solid fa-scroll",
    type:       TableCodexSettingsMenu,
    restricted: true,
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  try {
    console.log("[TableCodex Sync] init hook fired");

    registerSettings();
    console.log("[TableCodex Sync] settings registered");

    registerSettingsMenu();
    console.log("[TableCodex Sync] settings menu registered");

    Handlebars.registerHelper("eq", (a, b) => a === b);
    Handlebars.registerHelper("gt", (a, b) => a > b);
  } catch (err) {
    console.error("[TableCodex Sync] init hook failed:", err);
  }
});

// ---------------------------------------------------------------------------
// Scene controls — hook must be registered at module scope, not inside ready
// ---------------------------------------------------------------------------

Hooks.on("getSceneControlButtons", (controls) => {
  try {
    injectSceneControls(controls);
  } catch (err) {
    console.error("[TableCodex Sync] injectSceneControls failed:", err);
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

Hooks.once("ready", async () => {
  try {
    console.log("[TableCodex Sync] ready hook fired");
    await _initializeOnReady();
  } catch (err) {
    console.error("[TableCodex Sync] ready hook failed:", err);
  }
});

async function _initializeOnReady() {
  const modVersion = game.modules.get(MODULE_ID)?.version ?? MODULE_VERSION;

  // Startup diagnostics
  console.group("[TableCodex Sync] Startup Diagnostics");
  console.log("Module ID:     ", MODULE_ID);
  console.log("Version:       ", modVersion);
  console.log("Foundry:       ", game.version);
  console.log("System:        ", game.system?.id);
  console.log("World ID:      ", game.world?.id);
  console.log("World title:   ", game.world?.title);
  console.log("Is GM:         ", game.user?.isGM);
  console.log("Module URL:    ", game.modules.get(MODULE_ID)?.url ?? "(not found — check folder name)");
  console.log("Module active: ", game.modules.get(MODULE_ID)?.active ?? false);
  console.log("Settings reg:  ", game.settings.settings?.has?.(`${MODULE_ID}.tablecodexApiUrl`) ?? "unknown");
  console.groupEnd();

  // Promote the global to its full form
  globalThis.TableCodexSync = {
    openPanel,
    refreshPanel,
    openUnsyncedDialog,
    sessionRecorder,
    apiClient,
    getSetting,
    setSetting,
    status: "ready",
  };
  console.log("[TableCodex Sync] TableCodexSync.openPanel() is ready");

  // Persist world info for payload use
  try {
    await setSetting("foundryWorldId",   game.world?.id    ?? "");
    await setSetting("foundryWorldName", game.world?.title ?? "");
  } catch { /* ignore */ }

  // GM: resume a session that survived a page reload
  if (game.user?.isGM) {
    const buf = getSetting("localSessionBuffer");
    if (buf?.session?.active) {
      await sessionRecorder.resume();
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Notify.SessionResumed"));
    } else if (buf?.session && !buf.session.active) {
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.SessionPendingExport"));
    }
  }

  // Session lifecycle hooks
  Hooks.on(MODULE_ID + ".sessionStarted", refreshPanel);
  Hooks.on(MODULE_ID + ".sessionStopped", refreshPanel);
  Hooks.on(MODULE_ID + ".bufferCleared",  refreshPanel);

  // Warn about pending unsynced sessions
  if (game.user?.isGM) {
    const pending = getPendingSessions();
    debug("Session store: " + pending.length + " pending session(s).");
    if (pending.length > 0) {
      const label = pending.length === 1 ? "session" : "sessions";
      ui.notifications.warn(
        "TableCodex: You have " + pending.length + " unsynced " + label + ". " +
        "Open the TableCodex panel → \"Review Unsynced Sessions\"."
      );
    }
  }

  // Force scene controls repaint so toolbar buttons appear without a scene reload
  if (game.user?.isGM) {
    ui.controls?.render?.(true);
  }

  _registerCaptureHooks();
}

// ---------------------------------------------------------------------------
// Event capture hooks — registered inside ready to ensure sessionRecorder exists
// ---------------------------------------------------------------------------

function _registerCaptureHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeChat(message);
    if (!data) return;
    sessionRecorder.recordChat(data);
    for (const roll of data.rolls) sessionRecorder.recordRoll(roll);
    debug("Chat captured: " + message.id);
  });

  Hooks.on("combatStart", (combat) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("combat-start", combat);
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("deleteCombat", (combat) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("combat-end", combat);
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("combatRound", (combat) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("round-change", combat, { round: combat.round });
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("combatTurn", (combat) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("turn-change", combat, {
      round: combat.round,
      turn:  combat.turn,
      activeCombatant: combat.combatant
        ? { id: combat.combatant.id, name: combat.combatant.name }
        : null,
    });
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("canvasReady", (canvas) => {
    if (!sessionRecorder.isActive) return;
    const scene = canvas?.scene;
    if (!scene) return;
    const data = normalizeSceneView(scene);
    if (data) sessionRecorder.recordScene(data);
    debug("Scene viewed: " + scene.name);
  });

  Hooks.on("createActor", (actor) => {
    if (!sessionRecorder.isActive || !getSetting("captureActorSnapshots")) return;
    const data = normalizeActorEvent("created", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  Hooks.on("updateActor", (actor) => {
    if (!sessionRecorder.isActive || !getSetting("captureActorSnapshots")) return;
    const data = normalizeActorEvent("updated", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  Hooks.on("deleteActor", (actor) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeActorEvent("deleted", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  Hooks.on("createItem", (item) => {
    if (!sessionRecorder.isActive || !getSetting("captureItemSnapshots")) return;
    const data = normalizeItemEvent("created", item);
    if (data) sessionRecorder.recordItem(data);
  });

  Hooks.on("updateItem", (item) => {
    if (!sessionRecorder.isActive || !getSetting("captureItemSnapshots")) return;
    const data = normalizeItemEvent("updated", item);
    if (data) sessionRecorder.recordItem(data);
  });

  Hooks.on("deleteItem", (item) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeItemEvent("deleted", item);
    if (data) sessionRecorder.recordItem(data);
  });

  Hooks.on("renderJournalSheet", (_app, _html, data) => {
    if (!sessionRecorder.isActive) return;
    const journal = data?.document ?? _app?.document;
    if (!journal) return;
    const normalized = normalizeJournalEvent("opened", journal);
    if (normalized) sessionRecorder.recordJournal(normalized);
  });

  Hooks.on("updateJournalEntry", (journal) => {
    if (!sessionRecorder.isActive) return;
    const normalized = normalizeJournalEvent("updated", journal);
    if (normalized) sessionRecorder.recordJournal(normalized);
  });

  Hooks.on("createToken", (token) => {
    if (!sessionRecorder.isActive) return;
    sessionRecorder.recordScene({
      subtype:   "token-created",
      timestamp: new Date().toISOString(),
      sceneId:   token.parent?.id ?? token.sceneId ?? null,
      name:      token.parent?.name ?? null,
      token:     { id: token.id, name: token.name, actorId: token.actorId, x: token.x, y: token.y, hidden: token.hidden },
    });
  });

  Hooks.on("deleteToken", (token) => {
    if (!sessionRecorder.isActive) return;
    sessionRecorder.recordScene({
      subtype:   "token-deleted",
      timestamp: new Date().toISOString(),
      sceneId:   token.parent?.id ?? token.sceneId ?? null,
      name:      token.parent?.name ?? null,
      token:     { id: token.id, name: token.name, actorId: token.actorId },
    });
  });
}
