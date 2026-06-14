// @ts-check
/**
 * @file libwrapper-hooks.js
 * Central place to register libWrapper wraps. We strongly prefer real Hooks; a
 * wrap is only registered when the installed system/version emits no usable hook
 * for something we must capture. Called from the `init` hook.
 *
 * Currently the only conditional wrap is the dnd5e Activity-use fallback, which
 * the activity capture module decides whether to install based on detected hook
 * availability. Keeping this seam explicit documents exactly what we monkey-wrap
 * and why.
 */

import { logger } from "./logger.js";
import { maybeRegisterActivityFallback } from "../capture/activity-capture.js";

/** Register all libWrapper wraps owned by the module. */
export function registerLibWrapperHooks() {
  try {
    maybeRegisterActivityFallback();
  } catch (err) {
    logger.error("libwrapper-hooks: registration failed", err);
  }
}
