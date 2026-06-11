import { MODULE_TITLE } from "./settings.js";

export function log(...args) {
  console.log(`[${MODULE_TITLE}]`, ...args);
}

export function debug(...args) {
  try {
    if (game.settings.get("tablecodex-sync", "debugLogging")) {
      console.debug(`[${MODULE_TITLE}]`, ...args);
    }
  } catch { /* settings not ready yet */ }
}
