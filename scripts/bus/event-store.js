// @ts-check
/**
 * @file event-store.js
 * The durable, write-ahead raw event store. This is where the "never lose data"
 * guarantee lives.
 *
 * Recording model (exactly-once + GM-authoritative):
 *  - Capture modules only fire on the client whose user *triggered* the change
 *    (see `isTriggeringUser`), so each real-world event is emitted to the bus
 *    exactly once across the whole table.
 *  - The store persists only on the active GM (the sole world-settings writer).
 *    If the originating client is a player, the envelope is forwarded to the GM
 *    over socketlib; the GM's socket handler calls `ingestForwarded`.
 *  - If no GM is connected, player events are buffered locally and flushed to the
 *    GM when one appears (see socket.js `flushPending`).
 *
 * Persistence:
 *  - In-memory append is immediate.
 *  - A debounced flush writes the buffer to a world setting (write-ahead log).
 *  - Forced flushes happen at high-value checkpoints (combat end, session stop,
 *    beforeunload) so an interrupted session loses at most the last debounce
 *    window.
 *  - Reconstruction reads this log but NEVER writes it (invariant #2).
 */

import { MODULE_ID, SETTINGS, STORE_SCHEMA, HOOKS } from "../core/constants.js";
import { isActiveGM, gmConnected } from "../core/util.js";
import { logger } from "../core/logger.js";
import { eventBus } from "./event-bus.js";
import { currentSeq } from "./event-envelope.js";

const FLUSH_DEBOUNCE_MS = 1500;

class EventStore {
  constructor() {
    /** @type {import("./event-envelope.js").TelemetryEvent[]} */
    this._buffer = [];
    /** Envelopes captured locally while no GM was connected. */
    this._pendingForward = [];
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._flushTimer = null;
    this._unsubscribe = null;
    this._initialized = false;
  }

  /**
   * Subscribe to the bus and load any persisted buffer. Idempotent.
   */
  init() {
    if (this._initialized) return;
    this._initialized = true;
    // Wildcard subscription: the store records every event type.
    this._unsubscribe = eventBus.on("*", (event) => this.ingest(event));
    this.load();
    // Best-effort flush on page unload (async set may not complete, but the
    // debounced flush will usually have run already).
    globalThis.window?.addEventListener?.("beforeunload", () => {
      try {
        this.forceFlush();
      } catch {
        /* ignore */
      }
    });
    logger.debug("event-store: initialized");
  }

  /**
   * Ingest an envelope emitted on THIS client. Decides whether to persist
   * locally (GM) or forward to the GM (player).
   * @param {import("./event-envelope.js").TelemetryEvent} event
   */
  ingest(event) {
    if (!event) return;
    if (isActiveGM()) {
      this._record(event);
      return;
    }
    // Player client: forward to the authoritative GM.
    if (gmConnected()) {
      this._forward(event);
    } else {
      // No GM online — buffer locally and flush when one connects.
      this._pendingForward.push(event);
      logger.debug("event-store: no GM connected, buffering for forward", event.eventType);
    }
  }

  /**
   * GM-side entry point for envelopes forwarded from player clients over the
   * socket. Always records (the GM is the authoritative writer).
   * @param {import("./event-envelope.js").TelemetryEvent} event
   */
  ingestForwarded(event) {
    if (!isActiveGM()) return; // safety: only the GM persists
    this._record(event);
  }

  /** @private Append to the durable buffer and schedule a flush. */
  _record(event) {
    this._buffer.push(event);
    Hooks.callAll?.(HOOKS.EVENT_STORED, event);
    this._scheduleFlush();
  }

  /** @private Forward a single envelope to the GM via socketlib. */
  _forward(event) {
    const socket = globalThis.TableCodexSync?.socket;
    if (socket?.forwardEvent) {
      socket.forwardEvent(event);
    } else {
      // Socket not ready yet — fall back to the pending buffer.
      this._pendingForward.push(event);
    }
  }

  /** Flush any locally-buffered player events to the GM (called on GM connect). */
  flushPendingForward() {
    if (this._pendingForward.length === 0) return;
    const socket = globalThis.TableCodexSync?.socket;
    if (!socket?.forwardBatch || !gmConnected()) return;
    const batch = this._pendingForward.splice(0, this._pendingForward.length);
    socket.forwardBatch(batch);
    logger.info(`event-store: forwarded ${batch.length} buffered event(s) to GM`);
  }

  /** @private Debounced persistence. */
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
  }

  /**
   * Write the in-memory buffer to the world setting. Only the active GM can
   * write world settings; players are no-ops here (their data lives on the GM).
   * @returns {Promise<void>}
   */
  async flush() {
    if (!isActiveGM()) return;
    if (!globalThis.game?.settings) return;
    try {
      /** @type {StoredBuffer} */
      const payload = {
        schema: STORE_SCHEMA,
        sessionId: globalThis.TableCodexSync?.sessionManager?.sessionId ?? null,
        seq: currentSeq(),
        updatedAt: Date.now(),
        events: this._buffer,
      };
      await game.settings.set(MODULE_ID, SETTINGS.RAW_EVENT_BUFFER, payload);
      Hooks.callAll?.(HOOKS.BUFFER_FLUSHED, this._buffer.length);
      logger.trace(`event-store: flushed ${this._buffer.length} event(s)`);
    } catch (err) {
      logger.error("event-store: flush failed", err);
    }
  }

  /** Immediate flush (used at high-value checkpoints). */
  forceFlush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    return this.flush();
  }

  /**
   * Load a persisted buffer from the world setting into memory (resume support).
   */
  load() {
    if (!globalThis.game?.settings) return;
    try {
      /** @type {StoredBuffer|null} */
      const stored = game.settings.get(MODULE_ID, SETTINGS.RAW_EVENT_BUFFER);
      if (stored?.events?.length) {
        this._buffer = stored.events.slice();
        logger.info(`event-store: loaded ${this._buffer.length} persisted event(s)`);
      }
    } catch (err) {
      logger.error("event-store: load failed", err);
    }
  }

  /** Read-only copy of the current raw event log (for reconstruction/export). */
  getEvents() {
    return this._buffer.slice();
  }

  /** Number of buffered events. */
  get size() {
    return this._buffer.length;
  }

  /**
   * Clear the buffer and persisted setting. Called after a session is finalized
   * and its raw events have been moved into the session index/export.
   */
  async clear() {
    this._buffer = [];
    if (isActiveGM() && globalThis.game?.settings) {
      try {
        await game.settings.set(MODULE_ID, SETTINGS.RAW_EVENT_BUFFER, null);
      } catch (err) {
        logger.error("event-store: clear failed", err);
      }
    }
  }
}

/**
 * @typedef {Object} StoredBuffer
 * @property {number} schema
 * @property {string|null} sessionId
 * @property {number} seq
 * @property {number} updatedAt
 * @property {import("./event-envelope.js").TelemetryEvent[]} events
 */

export const eventStore = new EventStore();
export { EventStore };
