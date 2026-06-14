// @ts-check
/**
 * @file logger.js
 * Leveled logger + diagnostics. Extracted into its own module so every other
 * module can import it without creating circular dependencies. Reads the log
 * level lazily from settings (falling back to INFO before settings register).
 */

import { MODULE_ID, MODULE_TITLE, SETTINGS } from "./constants.js";

/** @enum {number} */
export const LEVEL = Object.freeze({
  ERROR: 0,
  WARN: 1,
  INFO: 2,
  DEBUG: 3,
  TRACE: 4,
});

/** Maps a level name string (as stored in settings) to a numeric level. */
const LEVEL_BY_NAME = {
  error: LEVEL.ERROR,
  warn: LEVEL.WARN,
  info: LEVEL.INFO,
  debug: LEVEL.DEBUG,
  trace: LEVEL.TRACE,
};

const PREFIX = `[${MODULE_TITLE}]`;

/** In-memory fallback before settings are available. */
let _fallbackLevel = LEVEL.INFO;

/**
 * Resolve the active numeric log level from settings, with a safe fallback.
 * Never throws even if settings are not yet registered.
 * @returns {number}
 */
function activeLevel() {
  try {
    if (globalThis.game?.settings?.settings?.has?.(`${MODULE_ID}.${SETTINGS.LOG_LEVEL}`)) {
      const name = game.settings.get(MODULE_ID, SETTINGS.LOG_LEVEL);
      return LEVEL_BY_NAME[name] ?? _fallbackLevel;
    }
  } catch {
    /* settings not ready */
  }
  return _fallbackLevel;
}

/** Override the fallback level used before settings register. */
export function setFallbackLevel(level) {
  _fallbackLevel = level;
}

/* eslint-disable no-console */
export const logger = {
  error(...args) {
    if (activeLevel() >= LEVEL.ERROR) console.error(PREFIX, ...args);
  },
  warn(...args) {
    if (activeLevel() >= LEVEL.WARN) console.warn(PREFIX, ...args);
  },
  info(...args) {
    if (activeLevel() >= LEVEL.INFO) console.log(PREFIX, ...args);
  },
  debug(...args) {
    if (activeLevel() >= LEVEL.DEBUG) console.debug(PREFIX, ...args);
  },
  trace(...args) {
    if (activeLevel() >= LEVEL.TRACE) console.debug(PREFIX, "(trace)", ...args);
  },
  /** Always-on grouped block, regardless of level. Used for startup diagnostics. */
  group(label, fn) {
    try {
      console.group(`${PREFIX} ${label}`);
      fn?.();
    } finally {
      console.groupEnd();
    }
  },
};
/* eslint-enable no-console */

// Convenience named exports (some modules prefer `log`/`debug` shorthands).
export const log = (...a) => logger.info(...a);
export const debug = (...a) => logger.debug(...a);
