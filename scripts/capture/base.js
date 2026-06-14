// @ts-check
/**
 * @file base.js
 * Shared helpers for capture modules. Every capture handler funnels through
 * `capture()` which enforces the universal gates:
 *   1. capture globally enabled (setting)
 *   2. a session is active (mirrored to all clients)
 *   3. THIS client is the one whose user triggered the change (exactly-once)
 * then builds a validated envelope and emits it onto the bus. A capture handler
 * must never throw into a Foundry hook, so everything is wrapped.
 */

import { SETTINGS } from "../core/constants.js";
import { isTriggeringUser } from "../core/util.js";
import { logger } from "../core/logger.js";
import { getSetting } from "../core/settings.js";
import { sessionManager } from "../session/session-manager.js";
import { eventBus } from "../bus/event-bus.js";
import { buildEvent } from "../bus/event-envelope.js";

/**
 * Whether capture should proceed for a hook triggered by `userId`.
 * @param {string} [userId]  Triggering user id from the hook (4th arg).
 * @param {string} [toggleKey]  Optional per-feature SETTINGS toggle.
 * @returns {boolean}
 */
export function canCapture(userId, toggleKey) {
  if (getSetting(SETTINGS.ENABLED) === false) return false;
  if (!sessionManager.isActive) return false;
  if (toggleKey && getSetting(toggleKey) === false) return false;
  return isTriggeringUser(userId);
}

/**
 * Build + emit a telemetry envelope. Returns the event (or null) for callers
 * that want to correlate.
 * @param {string} eventType
 * @param {import("../bus/event-envelope.js").BuildOptions} opts
 * @returns {import("../bus/event-envelope.js").TelemetryEvent|null}
 */
export function emit(eventType, opts) {
  try {
    const event = buildEvent(eventType, opts);
    if (event) eventBus.emit(event);
    return event;
  } catch (err) {
    logger.error(`capture: emit failed for ${eventType}`, err);
    return null;
  }
}

/**
 * Wrap a capture handler so a thrown error is logged, never propagated into the
 * Foundry hook dispatcher.
 * @template {any[]} A
 * @param {string} label
 * @param {(...args: A) => void} fn
 * @returns {(...args: A) => void}
 */
export function guard(label, fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      logger.error(`capture: ${label} threw`, err);
    }
  };
}
