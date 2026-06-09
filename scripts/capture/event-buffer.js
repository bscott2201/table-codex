import { MODULE_ID, EVENT_BATCH_SIZE, EVENT_FLUSH_INTERVAL_MS } from "../constants.js";
import { logger } from "../core/logger.js";
import { getJson, setJson } from "../core/storage.js";
import { apiClient } from "../api/api-client.js";
import { getSetting } from "../core/settings.js";
import { toVttEvent } from "./event-normalizer.js";

const QUEUE_STORAGE_KEY = `${MODULE_ID}.syncQueue`;
const SEQ_STORAGE_KEY = `${MODULE_ID}.sequenceCounter`;

export class EventBuffer {
  constructor() {
    this._queue = [];
    this._flushTimer = null;
    this._flushing = false;
    this._sequenceCounter = 0;
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

    const campaignId = getSetting("campaignId");
    const sessionId = getSetting("sessionId");
    if (!campaignId || !sessionId) {
      logger.log("No campaignId/sessionId — skipping sync flush.");
      return;
    }

    this._flushing = true;
    const batch = this._queue.splice(0, EVENT_BATCH_SIZE);
    this.persist();

    try {
      const vttEvents = [];
      for (const event of batch) {
        const vtt = toVttEvent(event, this._sequenceCounter);
        if (vtt) {
          vttEvents.push(vtt);
          this._sequenceCounter++;
        }
      }
      setJson(SEQ_STORAGE_KEY, this._sequenceCounter);

      if (vttEvents.length > 0) {
        await apiClient.sendEventBatch(campaignId, sessionId, vttEvents);
        logger.log(`Flushed ${vttEvents.length} VTT events (${batch.length - vttEvents.length} skipped).`);
      }
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
    this._sequenceCounter = getJson(SEQ_STORAGE_KEY, 0);
    logger.log(`Restored ${this._queue.length} queued events (sequence at ${this._sequenceCounter}).`);
  }

  persist() {
    setJson(QUEUE_STORAGE_KEY, this._queue);
  }

  getQueueCount() {
    return this._queue.length;
  }

  getAllEvents() {
    return [...this._queue];
  }

  clearAllEvents() {
    this._queue = [];
    this._sequenceCounter = 0;
    this.persist();
    setJson(SEQ_STORAGE_KEY, 0);
  }

  _startTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => this.flush(), EVENT_FLUSH_INTERVAL_MS);
  }
}

export const eventBuffer = new EventBuffer();
