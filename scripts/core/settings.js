import { MODULE_ID, DEFAULT_API_BASE_URL } from "../constants.js";
import { logger } from "./logger.js";

let _registered = false;

export function registerSettings() {
  if (_registered) return;
  _registered = true;

  game.settings.register(MODULE_ID, "apiBaseUrl", {
    name: "TableCodex API URL",
    hint: "Base URL for the TableCodex API server.",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_API_BASE_URL,
  });

  game.settings.register(MODULE_ID, "apiKey", {
    name: "TableCodex API Key",
    hint: "Your TableCodex API key. Keep this secret.",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "campaignId", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "sessionId", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "sessionTitle", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "captureId", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  game.settings.register(MODULE_ID, "captureMode", {
    name: "Capture Mode",
    hint: "Controls how much detail is captured per event.",
    scope: "world",
    config: true,
    type: String,
    choices: {
      safe: "Safe — minimal data only",
      standard: "Standard — balanced detail",
      detailed: "Detailed — full payloads",
    },
    default: "standard",
  });

  game.settings.register(MODULE_ID, "captureWhispers", {
    name: "Capture Whispers",
    hint: "Include whispered chat messages in the session capture.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "captureHiddenNames", {
    name: "Capture Hidden Token Names",
    hint: "Include hidden token names in actor events.",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "isCapturing", {
    scope: "world",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "connectionVerifiedAt", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  logger.log("Settings registered.");
}

export function getSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    logger.error(`getSetting("${key}") failed:`, err);
    return undefined;
  }
}

export async function setSetting(key, value) {
  try {
    await game.settings.set(MODULE_ID, key, value);
  } catch (err) {
    logger.error(`setSetting("${key}") failed:`, err);
  }
}
