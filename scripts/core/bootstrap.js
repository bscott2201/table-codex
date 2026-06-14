// @ts-check
/**
 * @file bootstrap.js
 * The single owner of Foundry lifecycle registration. This is where "how the
 * module is initiated and when the scripts fire" is made explicit and correct.
 *
 * Ordering (see also the plan):
 *   module-scope eval  → placeholder global, pre-update hooks, scene controls
 *   init               → settings, settings menu, libWrapper wraps, helpers
 *   socketlib.ready    → socket registration (fires before `ready`)
 *   setup              → localization-dependent prep, integration detection
 *   ready              → diagnostics, full global API, store init + resume,
 *                        capture wiring, Midi detection, GM housekeeping
 */

import { MODULE_ID, MODULE_TITLE, MODULE_VERSION, SETTINGS, HOOKS } from "./constants.js";
import { logger, setFallbackLevel, LEVEL } from "./logger.js";
import { isActiveGM } from "./util.js";
import { registerSettings, registerSettingsMenu, getSetting, setSetting } from "./settings.js";
import { registerSocket } from "./socket.js";
import { registerLibWrapperHooks } from "./libwrapper-hooks.js";

import { eventBus } from "../bus/event-bus.js";
import { eventStore } from "../bus/event-store.js";
import { sessionManager } from "../session/session-manager.js";

import { registerPreUpdateHooks, registerCaptureModules } from "../capture/index.js";
import { detectSystem } from "../integrations/dnd5e.js";
import { detectAndWireMidi } from "../integrations/midi-qol.js";

import { reconstructionEngine } from "../reconstruction/reconstruction-engine.js";
import { jsonExporter } from "../export/json-exporter.js";
import { markdownExporter } from "../export/markdown-exporter.js";
import { uploadQueue } from "../export/upload-queue.js";
import { apiClient } from "../export/api-client.js";

import { openPanel, refreshPanel } from "../ui/panel.js";
import { openCampaignLink } from "../ui/campaign-link.js";
import { injectSceneControls } from "../ui/scene-controls.js";

/**
 * Install the early global, pre-update hooks, and scene controls. Runs at module
 * evaluation time (before `init`). Touches NO game globals — only Hooks.
 */
export function installModuleScope() {
  // Placeholder global so console helpers work before `ready`.
  globalThis.TableCodexSync = {
    status: "loading",
    sessionManager, // sessionId is read by the envelope factory from here
    openPanel: () => logger.warn("Not ready yet — wait for the ready hook"),
  };

  // Pre-update hooks MUST be registered before `ready` so the "before" snapshot
  // exists for the very first actor/token/effect update of the session.
  registerPreUpdateHooks();

  // Scene controls hook must be at module scope (not inside ready).
  Hooks.on("getSceneControlButtons", (controls) => {
    try {
      injectSceneControls(controls);
    } catch (err) {
      logger.error("getSceneControlButtons: injection failed", err);
    }
  });

  logger.debug("bootstrap: module-scope installed");
}

/** Register all lifecycle hooks. Called once from the entry module. */
export function registerLifecycle() {
  Hooks.once("init", _onInit);
  Hooks.once("socketlib.ready", _onSocketReady);
  Hooks.once("setup", _onSetup);
  Hooks.once("ready", _onReady);
}

// ── init ──────────────────────────────────────────────────────────────

function _onInit() {
  try {
    logger.info(`init — ${MODULE_TITLE} v${MODULE_VERSION}`);

    // Register Handlebars helpers FIRST so template rendering never lacks them,
    // even if a later registration step throws.
    Handlebars.registerHelper("tcEq", (a, b) => a === b);
    Handlebars.registerHelper("tcDate", (ms) => (ms ? new Date(ms).toLocaleString() : ""));

    registerSettings();

    // The settings-menu launcher must be a valid ApplicationV2 subclass in V13+;
    // isolate it so a registration failure can't cascade.
    try {
      registerSettingsMenu(openPanel);
    } catch (err) {
      logger.error("init: settings menu registration failed (non-fatal)", err);
    }
  } catch (err) {
    logger.error("init hook failed", err);
  }
}

// ── socketlib.ready ───────────────────────────────────────────────────

function _onSocketReady() {
  try {
    const socket = registerSocket();
    if (globalThis.TableCodexSync) globalThis.TableCodexSync.socket = socket;
    logger.debug("socketlib.ready — socket wired");
  } catch (err) {
    logger.error("socketlib.ready hook failed", err);
  }
}

// ── setup ─────────────────────────────────────────────────────────────

function _onSetup() {
  try {
    // System detection (dnd5e gating for Phase 3). Localization is ready here.
    detectSystem();
    // libWrapper wraps run AFTER detection so hook-presence checks are valid and
    // the dnd5e fallback is only attempted on dnd5e. Safe no-op otherwise.
    registerLibWrapperHooks();
    logger.debug("setup — system detected, libWrapper wired");
  } catch (err) {
    logger.error("setup hook failed", err);
  }
}

// ── ready ─────────────────────────────────────────────────────────────

async function _onReady() {
  try {
    logger.info("ready — wiring telemetry pipeline");
    _diagnostics();

    // Promote the global to its full API surface.
    globalThis.TableCodexSync = {
      status: "ready",
      // pipeline
      eventBus,
      eventStore,
      sessionManager,
      reconstructionEngine,
      // export/sync
      jsonExporter,
      markdownExporter,
      uploadQueue,
      apiClient,
      // settings
      getSetting,
      setSetting,
      // ui
      openPanel,
      refreshPanel,
      openCampaignLink,
      // socket (set during socketlib.ready)
      socket: globalThis.TableCodexSync?.socket,
      // convenience console helpers
      startSession: (opts) => sessionManager.start(opts),
      stopSession: () => sessionManager.stop(),
      exportJson: () => jsonExporter.download(),
      exportMarkdown: () => markdownExporter.download(),
    };

    // Persist world identity for export payloads.
    try {
      await setSetting(SETTINGS.WORLD_ID, game.world?.id ?? "");
      await setSetting(SETTINGS.WORLD_NAME, game.world?.title ?? "");
    } catch {
      /* ignore */
    }

    // Initialize the durable store (loads any persisted buffer).
    eventStore.init();

    // GM: resume an interrupted session that survived a reload.
    if (isActiveGM()) {
      const resumed = await sessionManager.resume();
      if (resumed) {
        ui.notifications?.warn("TableCodex: a session in progress was resumed after reload.");
      }
    }

    // Wire post-ready capture hooks (create/update/delete telemetry).
    registerCaptureModules();

    // Optional Midi-QOL enrichment (runtime-detected; no hard dependency).
    detectAndWireMidi();

    // Initialize the durable upload queue (retry/backoff loop).
    uploadQueue.init();

    // UI refresh on session lifecycle changes.
    Hooks.on(HOOKS.SESSION_STARTED, refreshPanel);
    Hooks.on(HOOKS.SESSION_STOPPED, refreshPanel);
    Hooks.on(HOOKS.SESSION_RESUMED, refreshPanel);

    // GM housekeeping: forward any buffered player events, repaint controls.
    if (isActiveGM()) {
      ui.controls?.render?.(true);
    } else {
      // A player coming online: flush anything captured while no GM was present.
      eventStore.flushPendingForward();
    }

    logger.info("ready — pipeline online");
  } catch (err) {
    logger.error("ready hook failed", err);
  }
}

/** Always-on startup diagnostics block. */
function _diagnostics() {
  const g = globalThis.game;
  setFallbackLevel(LEVEL.INFO);
  logger.group("Startup Diagnostics", () => {
    /* eslint-disable no-console */
    console.log("Module ID:      ", MODULE_ID);
    console.log("Module version: ", g?.modules?.get?.(MODULE_ID)?.version ?? MODULE_VERSION);
    console.log("Foundry:        ", g?.version);
    console.log("System:         ", `${g?.system?.id}@${g?.system?.version}`);
    console.log("World:          ", g?.world?.id, `(${g?.world?.title})`);
    console.log("Is active GM:   ", isActiveGM());
    console.log("libWrapper:     ", typeof globalThis.libWrapper !== "undefined");
    console.log("socketlib:      ", typeof globalThis.socketlib !== "undefined");
    console.log("Midi-QOL:       ", Boolean(g?.modules?.get?.("midi-qol")?.active));
    console.log("Module active:  ", Boolean(g?.modules?.get?.(MODULE_ID)?.active));
    /* eslint-enable no-console */
  });
}
