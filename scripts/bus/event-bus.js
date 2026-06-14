// @ts-check
/**
 * @file event-bus.js
 * A tiny synchronous publish/subscribe bus that decouples capture modules from
 * the event store. Capture code calls `eventBus.emit(envelope)`; the store and
 * any other consumers subscribe. Every subscriber is isolated in try/catch so a
 * single misbehaving consumer can never block capture or cause the event to be
 * lost for the other subscribers (data-safety invariant #5).
 */

import { logger } from "../core/logger.js";

/**
 * @typedef {import("./event-envelope.js").TelemetryEvent} TelemetryEvent
 * @typedef {(event: TelemetryEvent) => void} Subscriber
 */

class EventBus {
  constructor() {
    /** @type {Map<string, Set<Subscriber>>} type -> subscribers */
    this._byType = new Map();
    /** @type {Set<Subscriber>} wildcard subscribers (every event) */
    this._wildcard = new Set();
  }

  /**
   * Subscribe to a specific event type, or "*" for every event.
   * @param {string} type
   * @param {Subscriber} fn
   * @returns {() => void} unsubscribe function
   */
  on(type, fn) {
    if (type === "*") {
      this._wildcard.add(fn);
      return () => this._wildcard.delete(fn);
    }
    let set = this._byType.get(type);
    if (!set) {
      set = new Set();
      this._byType.set(type, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  /**
   * Emit an event to all matching subscribers. Synchronous and total: a thrown
   * subscriber is logged and skipped, never propagated.
   * @param {TelemetryEvent} event
   */
  emit(event) {
    if (!event || typeof event.eventType !== "string") {
      logger.warn("event-bus: refusing to emit malformed event", event);
      return;
    }
    const typed = this._byType.get(event.eventType);
    if (typed) {
      for (const fn of typed) this._safe(fn, event);
    }
    for (const fn of this._wildcard) this._safe(fn, event);
  }

  /** @private */
  _safe(fn, event) {
    try {
      fn(event);
    } catch (err) {
      logger.error(`event-bus: subscriber threw for ${event.eventType}`, err);
    }
  }

  /** Remove all subscribers (used in teardown/tests). */
  clear() {
    this._byType.clear();
    this._wildcard.clear();
  }
}

/** Singleton bus shared across the module. */
export const eventBus = new EventBus();
export { EventBus };
