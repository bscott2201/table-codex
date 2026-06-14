// @ts-check
/**
 * @file libwrapper.js
 * Thin, safe wrapper around the libWrapper API. libWrapper is a REQUIRED
 * dependency, but we still guard against it being missing (e.g. disabled by the
 * user mid-session) so a wrap failure never breaks capture — it degrades to "no
 * wrap" and logs loudly.
 *
 * We prefer non-deprecated system/core Hooks everywhere a hook exists; this
 * helper is only used to wrap methods that emit no usable hook.
 */

import { MODULE_ID } from "./constants.js";
import { logger } from "./logger.js";

/** @returns {boolean} whether the libWrapper API is present. */
export function hasLibWrapper() {
  return typeof globalThis.libWrapper !== "undefined";
}

/** @type {{ target: string, type: string }[]} registered wraps, for diagnostics */
const _registered = [];

/**
 * Register a libWrapper wrap with guards and bookkeeping.
 * @param {string} target  Dotted path to the method, e.g.
 *   "CONFIG.Item.documentClass.prototype.use".
 * @param {Function} fn     Wrapper function (wrapped, ...args) => result.
 * @param {"WRAPPER"|"MIXED"|"OVERRIDE"} [type="MIXED"]
 * @returns {number|null} the libWrapper registration id, or null on failure.
 */
export function wrap(target, fn, type = "MIXED") {
  if (!hasLibWrapper()) {
    logger.warn(`libwrapper: not available, skipping wrap of ${target}`);
    return null;
  }
  try {
    const id = globalThis.libWrapper.register(MODULE_ID, target, fn, type);
    _registered.push({ target, type });
    logger.debug(`libwrapper: wrapped ${target} (${type})`);
    return id;
  } catch (err) {
    logger.error(`libwrapper: failed to wrap ${target}`, err);
    return null;
  }
}

/** Unregister all wraps owned by this module (teardown/tests). */
export function unwrapAll() {
  if (!hasLibWrapper()) return;
  try {
    globalThis.libWrapper.unregister_all?.(MODULE_ID);
    _registered.length = 0;
  } catch (err) {
    logger.error("libwrapper: unregister_all failed", err);
  }
}

/** Snapshot of registered wraps (diagnostics). */
export function registeredWraps() {
  return _registered.slice();
}
