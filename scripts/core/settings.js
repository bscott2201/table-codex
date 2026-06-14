// @ts-check
/**
 * @file settings.js
 * Registers all module settings and exposes typed get/set helpers. Hidden
 * settings (config:false) hold durable runtime state (raw event buffer, session
 * index, upload queue). Called from the `init` hook.
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS } from "./constants.js";
import { logger } from "./logger.js";

/**
 * Typed read of a module setting. Returns undefined (not a throw) if settings
 * are not yet registered.
 * @param {string} key  One of SETTINGS.*
 */
export function getSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return undefined;
  }
}

/**
 * Typed write of a module setting.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<*>}
 */
export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

/** Register every setting. Idempotent within a session (Foundry dedupes). */
export function registerSettings() {
  const reg = (key, data) => game.settings.register(MODULE_ID, key, data);

  // ── Connection / campaign linking (visible) ────────────────────────
  reg(SETTINGS.API_URL, {
    name: "TABLECODEX.Settings.ApiUrl.Name",
    hint: "TABLECODEX.Settings.ApiUrl.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  reg(SETTINGS.API_TOKEN, {
    name: "TABLECODEX.Settings.ApiToken.Name",
    hint: "TABLECODEX.Settings.ApiToken.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  // ── Capture toggles (visible) ──────────────────────────────────────
  reg(SETTINGS.ENABLED, {
    name: "TABLECODEX.Settings.Enabled.Name",
    hint: "TABLECODEX.Settings.Enabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  reg(SETTINGS.CAPTURE_MOVEMENT, {
    name: "TABLECODEX.Settings.CaptureMovement.Name",
    hint: "TABLECODEX.Settings.CaptureMovement.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  reg(SETTINGS.CAPTURE_ROLLS, {
    name: "TABLECODEX.Settings.CaptureRolls.Name",
    hint: "TABLECODEX.Settings.CaptureRolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  reg(SETTINGS.CAPTURE_DND5E, {
    name: "TABLECODEX.Settings.CaptureDnd5e.Name",
    hint: "TABLECODEX.Settings.CaptureDnd5e.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });
  reg(SETTINGS.CAPTURE_MIDI, {
    name: "TABLECODEX.Settings.CaptureMidi.Name",
    hint: "TABLECODEX.Settings.CaptureMidi.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  reg(SETTINGS.LOG_LEVEL, {
    name: "TABLECODEX.Settings.LogLevel.Name",
    hint: "TABLECODEX.Settings.LogLevel.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      error: "Error",
      warn: "Warn",
      info: "Info",
      debug: "Debug",
      trace: "Trace",
    },
    default: "info",
  });

  // ── Hidden world identity (auto-populated) ─────────────────────────
  reg(SETTINGS.WORLD_ID, { scope: "world", config: false, type: String, default: "" });
  reg(SETTINGS.WORLD_NAME, { scope: "world", config: false, type: String, default: "" });
  reg(SETTINGS.CAMPAIGN_ID, { scope: "world", config: false, type: String, default: "" });
  reg(SETTINGS.CAMPAIGN_NAME, { scope: "world", config: false, type: String, default: "" });

  // ── Hidden durable runtime state ───────────────────────────────────
  reg(SETTINGS.RAW_EVENT_BUFFER, { scope: "world", config: false, type: Object, default: null });
  reg(SETTINGS.SESSION_INDEX, { scope: "world", config: false, type: Array, default: [] });
  reg(SETTINGS.UPLOAD_QUEUE, { scope: "world", config: false, type: Array, default: [] });

  logger.debug("settings: registered");
}

/**
 * Register the settings-menu button that opens the main panel. The panel class
 * is provided lazily to avoid referencing ApplicationV2 at module-parse time.
 * @param {() => void} openPanel
 */
export function registerSettingsMenu(openPanel) {
  // A minimal FormApplication-free launcher: registerMenu requires a class with
  // a render method. We use an ApplicationV2-compatible thunk via a tiny shim.
  class PanelLauncher {
    constructor() {}
    render() {
      openPanel();
      return this;
    }
  }
  game.settings.registerMenu(MODULE_ID, "openPanel", {
    name: MODULE_TITLE,
    label: "TABLECODEX.Menu.OpenPanel",
    hint: "TABLECODEX.Menu.OpenPanelHint",
    icon: "fa-solid fa-scroll",
    type: PanelLauncher,
    restricted: true,
  });
}
