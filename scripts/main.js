import { MODULE_ID, MODULE_TITLE, registerSettings, getSetting, setSetting } from "./settings.js";
import { log, debug } from "./logger.js";
import { sessionRecorder } from "./session-recorder.js";
import { normalizeChat, normalizeCombatEvent, normalizeSceneView, normalizeActorEvent, normalizeItemEvent, normalizeJournalEvent } from "./event-normalizer.js";
import { openPanel, refreshPanel, injectSceneControls, openUnsyncedDialog } from "./ui.js";
import { getPendingSessions } from "./session-store.js";

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  console.log(`[TableCodex Sync] init — loading module`);

  try {
    registerSettings();
    console.log("[TableCodex Sync] settings registered OK");
  } catch (err) {
    console.error("[TableCodex Sync] registerSettings() FAILED:", err);
  }

  Handlebars.registerHelper("eq", (a, b) => a === b);
  Handlebars.registerHelper("gt", (a, b) => a > b);
});

// Inject an "Open TableCodex" button directly into the settings sidebar.
// This approach requires no FormApplication subclass and works in all V13/V14 builds.
Hooks.on("renderSettings", (_app, html) => {
  if (!game.user?.isGM) return;
  if (html.find(".tc-settings-btn").length) return; // already injected

  const btn = $(`
    <div class="tc-settings-btn-wrap">
      <button type="button" class="tc-settings-btn">
        <i class="fas fa-scroll"></i> Open TableCodex Sync
      </button>
    </div>
  `);
  btn.find("button").on("click", () => openPanel());

  // Insert after the "Game Settings" heading or at the top of the settings list
  const target = html.find("#settings-game, .settings-list").first();
  if (target.length) {
    target.before(btn);
  } else {
    html.prepend(btn);
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

Hooks.once("ready", async () => {
  log("Ready.");

  // Store world info in settings for payload use
  try {
    await setSetting("foundryWorldId", game.world?.id ?? "");
    await setSetting("foundryWorldName", game.world?.title ?? "");
  } catch { /* ignore */ }

  // GM-only: check for an active session that survived a page reload
  if (game.user?.isGM) {
    const buf = getSetting("localSessionBuffer");
    if (buf?.session?.active) {
      await sessionRecorder.resume();
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Notify.SessionResumed"));
    } else if (buf?.session && !buf.session.active) {
      ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.SessionPendingExport"));
    }
  }

  // Subscribe to session events to keep UI in sync
  Hooks.on(`${MODULE_ID}.sessionStarted`, refreshPanel);
  Hooks.on(`${MODULE_ID}.sessionStopped`, refreshPanel);
  Hooks.on(`${MODULE_ID}.bufferCleared`,  refreshPanel);

  // Warn GM about any sessions that need attention
  if (game.user?.isGM) {
    const pending = getPendingSessions();
    debug(`Unsynced session store: ${pending.length} pending session(s).`);
    if (pending.length > 0) {
      const label = pending.length === 1 ? "session" : "sessions";
      // Show as a persistent warning with a clickable action
      ui.notifications.warn(
        `TableCodex: You have ${pending.length} unsynced ${label}. ` +
        `Open the TableCodex panel and click "Review Unsynced Sessions" to retry or export.`
      );
    }
  }

  _registerCaptureHooks();
});

// ---------------------------------------------------------------------------
// Scene controls
// ---------------------------------------------------------------------------

Hooks.on("getSceneControlButtons", injectSceneControls);

// ---------------------------------------------------------------------------
// Event capture hooks
// ---------------------------------------------------------------------------

function _registerCaptureHooks() {
  // --- Chat ---
  Hooks.on("createChatMessage", (message) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeChat(message);
    if (!data) return; // filtered by privacy settings
    sessionRecorder.recordChat(data);
    // Also record any embedded rolls
    for (const roll of data.rolls) {
      sessionRecorder.recordRoll(roll);
    }
    debug("Chat captured:", message.id);
  });

  // --- Combat ---
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

  Hooks.on("combatRound", (combat, _updateData, _options) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("round-change", combat, { round: combat.round });
    if (data) sessionRecorder.recordCombat(data);
  });

  Hooks.on("combatTurn", (combat, _updateData, _options) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeCombatEvent("turn-change", combat, {
      round: combat.round,
      turn: combat.turn,
      activeCombatant: combat.combatant
        ? { id: combat.combatant.id, name: combat.combatant.name }
        : null,
    });
    if (data) sessionRecorder.recordCombat(data);
  });

  // --- Scenes ---
  Hooks.on("canvasReady", (canvas) => {
    if (!sessionRecorder.isActive) return;
    const scene = canvas?.scene;
    if (!scene) return;
    const data = normalizeSceneView(scene);
    if (data) sessionRecorder.recordScene(data);
    debug("Scene viewed:", scene.name);
  });

  // --- Actors ---
  Hooks.on("createActor", (actor) => {
    if (!sessionRecorder.isActive) return;
    if (!getSetting("captureActorSnapshots")) return;
    const data = normalizeActorEvent("created", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  Hooks.on("updateActor", (actor) => {
    if (!sessionRecorder.isActive) return;
    if (!getSetting("captureActorSnapshots")) return;
    const data = normalizeActorEvent("updated", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  Hooks.on("deleteActor", (actor) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeActorEvent("deleted", actor);
    if (data) sessionRecorder.recordActor(data);
  });

  // --- Items ---
  Hooks.on("createItem", (item) => {
    if (!sessionRecorder.isActive) return;
    if (!getSetting("captureItemSnapshots")) return;
    const data = normalizeItemEvent("created", item);
    if (data) sessionRecorder.recordItem(data);
  });

  Hooks.on("updateItem", (item) => {
    if (!sessionRecorder.isActive) return;
    if (!getSetting("captureItemSnapshots")) return;
    const data = normalizeItemEvent("updated", item);
    if (data) sessionRecorder.recordItem(data);
  });

  Hooks.on("deleteItem", (item) => {
    if (!sessionRecorder.isActive) return;
    const data = normalizeItemEvent("deleted", item);
    if (data) sessionRecorder.recordItem(data);
  });

  // --- Journals ---
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

  // --- Tokens (lightweight) ---
  Hooks.on("createToken", (token) => {
    if (!sessionRecorder.isActive) return;
    debug("Token created:", token.name);
    sessionRecorder.recordScene({
      subtype: "token-created",
      timestamp: new Date().toISOString(),
      sceneId: token.parent?.id ?? token.sceneId ?? null,
      name: token.parent?.name ?? null,
      token: {
        id: token.id,
        name: token.name,
        actorId: token.actorId,
        x: token.x,
        y: token.y,
        hidden: token.hidden,
      },
    });
  });

  Hooks.on("deleteToken", (token) => {
    if (!sessionRecorder.isActive) return;
    sessionRecorder.recordScene({
      subtype: "token-deleted",
      timestamp: new Date().toISOString(),
      sceneId: token.parent?.id ?? token.sceneId ?? null,
      name: token.parent?.name ?? null,
      token: { id: token.id, name: token.name, actorId: token.actorId },
    });
  });
}
