import { MODULE_ID, EVENT_BATCH_SIZE, EVENT_FLUSH_INTERVAL_MS } from "../constants.js";
import { logger } from "../core/logger.js";
import { getJson, setJson } from "../core/storage.js";
import { apiClient } from "../api/api-client.js";
import { getSetting } from "../core/settings.js";
import { getFoundryWorldContext } from "../core/foundry-context.js";

const QUEUE_STORAGE_KEY = `${MODULE_ID}.syncQueue`;

function safeUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export class EventBuffer {
  constructor() {
    this._queue = [];
    this._flushTimer = null;
    this._flushing = false;
  }

  start() {
    this.restore();
    this._startTimer();
    logger.log("EventBuffer started.");
  }

  stop() {
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    logger.log("EventBuffer stopped.");
  }

  add(event) {
    this._queue.push(event);
    this.persist();
    if (this._queue.length >= EVENT_BATCH_SIZE) {
      this.flush();
    }
  }

  async flush() {
    if (this._flushing || this._queue.length === 0) return;

    const apiKey = getSetting("apiKey");
    if (!apiKey) {
      logger.log("No API key — skipping sync flush (local-only mode).");
      return;
    }

    const sessionId = getSetting("sessionId");
    if (!sessionId) {
      logger.log("No sessionId — skipping sync flush.");
      return;
    }

    this._flushing = true;
    const batch = this._queue.splice(0, EVENT_BATCH_SIZE);
    this.persist();

    try {
      const payload = {
        batchId: safeUuid(),
        captureId: getSetting("captureId") || null,
        world: getFoundryWorldContext(),
        events: batch,
      };
      await apiClient.sendEventBatch(sessionId, payload);
      logger.log(`Flushed ${batch.length} events.`);
    } catch (err) {
      logger.warn("Batch sync failed — requeueing events:", err);
      this._queue.unshift(...batch);
      this.persist();
    } finally {
      this._flushing = false;
    }
  }

  restore() {
    const saved = getJson(QUEUE_STORAGE_KEY, []);
    this._queue = Array.isArray(saved) ? saved : [];
    logger.log(`Restored ${this._queue.length} queued events from storage.`);
  }

  persist() {
    setJson(QUEUE_STORAGE_KEY, this._queue);
  }

  getQueueCount() {
    return this._queue.length;
  }

  // Returns all events currently in the sync queue.
  // Note: this may be empty after a successful API sync. Use session-archive for full export.
  getAllEvents() {
    return [...this._queue];
  }

  // Clears only the sync queue (not the session archive).
  clearAllEvents() {
    this._queue = [];
    this.persist();
  }

  _startTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this.flush(), EVENT_FLUSH_INTERVAL_MS);
  }
}

export const eventBuffer = new EventBuffer();
