import { MODULE_ID, MODULE_TITLE, MODULE_VERSION, registerSettings, getSetting, setSetting } from "./settings.js";
import { log, debug } from "./logger.js";
import { sessionRecorder } from "./session-recorder.js";
import { normalizeChat, normalizeCombatEvent, normalizeSceneView, normalizeActorEvent, normalizeItemEvent, normalizeJournalEvent } from "./event-normalizer.js";
import { openPanel, refreshPanel, injectSceneControls } from "./ui.js";
import { apiClient } from "./api-client.js";
import { getPendingSessions } from "./session-store.js";

// ---------------------------------------------------------------------------
// FormApplication shim for the settings menu button.
// Foundry's registerMenu requires a FormApplication subclass.
// We override render() to open the real panel instead of rendering a form.
// Defined at module scope so it exists by the time init fires.
// ---------------------------------------------------------------------------

class TableCodexPanelMenuShim extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      title: MODULE_TITLE,
      id:    "tablecodex-panel-launcher",
    });
  }
  async _updateObject() {}
  render(_force, _options) {
    openPanel();
    return this;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  console.log(`[${MODULE_TITLE}] init`);

  try {
    registerSettings();
    console.log(`[${MODULE_TITLE}] settings registered`);
  } catch (err) {
    console.error(`[${MODULE_TITLE}] registerSettings() failed:`, err);
  }

  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("gt", (a, b) => a > b);

  // Register the settings menu button.
  // Shows as "Open TableCodex Sync" under Configure Settings → Module Settings → TableCodex Sync.
  try {
    game.settings.registerMenu(MODULE_ID, "openPanel", {
      name:       "TableCodex Sync Panel",
      label:      "Open TableCodex Sync",
      hint:       "Open the TableCodex Sync panel for API connection, campaign selection, session capture, export, and sync.",
      icon:       "fa-solid fa-scroll",
      type:       TableCodexPanelMenuShim,
      restricted: true,
    });
    console.log(`[${MODULE_TITLE}] registerMenu OK`);
  } catch (err) {
    console.error(`[${MODULE_TITLE}] registerMenu() failed:`, err);
  }
});

// ---------------------------------------------------------------------------
// Scene controls — registered before ready so they appear on first load
// ---------------------------------------------------------------------------

Hooks.on("getSceneControlButtons", injectSceneControls);

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

Hooks.once("ready", async () => {
  // Startup diagnostics — always visible in console
  const modVersion = game.modules.get(MODULE_ID)?.version ?? MODULE_VERSION;
  console.group(`[${MODULE_TITLE}] Startup Diagnostics`);
  console.log("Module ID:", MODULE_ID);
  console.log("Module version:", modVersion);
  console.log("Foundry version:", game.version);
  console.log("System:", game.system?.id);
  console.log("World ID:", game.world?.id);
  console.log("World title:", game.world?.title);
  console.log("Is GM:", game.user?.isGM);
  console.log("Settings registered:", game.settings.settings?.has?.(`${MODULE_ID}.tablecodexApiUrl`) ?? "unknown");
  console.log("Template base: ", `modules/${MODULE_ID}/templates/session-panel.hbs`);
  console.groupEnd();

  // Expose a global for console testing
  window.TableCodexSync = { openPanel, refreshPanel, sessionRecorder, apiClient };
  console.log(`[${MODULE_TITLE}] window.TableCodexSync available — try TableCodexSync.openPanel()`);

  // Store world info for payload use
  try {
    await setSetting("foundryWorldId",   game.world?.id    ?? "");
    await setSetting("foundryWorldName", game.world?.title ?? "");
  } catch { /* ignore */ }

  // GM-only: resume or warn about surviving sessions
  if (game.user?.isGM) {
    const buf = getSetting("localSessionBuffer");
    if (buf?.session?.active) {
      await sessionRecorder.resume();
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Notify.SessionResumed"));
    } else if (buf?.session && !buf.session.active) {
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.SessionPendingExport"));
    }
  }

  // Subscribe to session lifecycle events
  Hooks.on(`${MODULE_ID}.sessionStarted`, refreshPanel);
  Hooks.on(`${MODULE_ID}.sessionStopped`, refreshPanel);
  Hooks.on(`${MODULE_ID}.bufferCleared`,  refreshPanel);

  // Warn about pending unsynced sessions
  if (game.user?.isGM) {
    const pending = getPendingSessions();
    debug(`Session store: ${pending.length} pending session(s).`);
    if (pending.length > 0) {
      const label = pending.length === 1 ? "session" : "sessions";
      ui.notifications.warn(
        `TableCodex: You have ${pending.length} unsynced ${label}. ` +
        `Open the TableCodex panel → "Review Unsynced Sessions".`
      );
    }
  }

  // Force scene controls to render so toolbar buttons appear immediately
  if (game.user?.isGM) {
    ui.controls?.render?.();
  }

  _registerCaptureHooks();
});

// ---------------------------------------------------------------------------
// Event capture hooks
// ---------------------------------------------------------------------------

function _registerCaptureHooks() {
  Hooks.on("createChatMessage", (message) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeChat(message);
    if (!data) return;
    sessionRecorder.recordChat(data);
    for (const roll of data.rolls) sessionRecorder.recordRoll(roll);
    debug("Chat captured:", message.id);
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

  Hooks.on("combatRound", (combat, _u, _o) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("round-change", combat, { round: combat.round });
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("combatTurn", (combat, _u, _o) => {
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
    debug("Scene viewed:", scene.name);
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
