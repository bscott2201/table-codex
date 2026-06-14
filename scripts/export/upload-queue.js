// @ts-check
/**
 * @file upload-queue.js
 * Phase 6: a durable upload queue for syncing session payloads to TableCodex.
 * Entries are persisted in a world setting so a queued upload survives reloads
 * and offline periods (never lose data). Processing uses exponential backoff and
 * is GM-only (the GM owns world settings and the authoritative event log).
 */

import { MODULE_ID, SETTINGS, HOOKS } from "../core/constants.js";
import { randomId, isActiveGM } from "../core/util.js";
import { logger } from "../core/logger.js";
import { getSetting, setSetting } from "../core/settings.js";
import { apiClient } from "./api-client.js";
import { buildPayload } from "./payload.js";
import { eventStore } from "../bus/event-store.js";

const MAX_ATTEMPTS = 6;
const BASE_BACKOFF_MS = 5000;

/**
 * @typedef {Object} QueueEntry
 * @property {string} id
 * @property {string} sessionId
 * @property {object} payload
 * @property {"pending"|"failed"|"done"} status
 * @property {number} attempts
 * @property {number} nextAttemptAt   epoch ms
 * @property {string|null} lastError
 * @property {number} createdAt
 */

class UploadQueue {
  constructor() {
    this._processing = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._timer = null;
    /** Session ids enqueued this client-session (dedup; resets on reload). */
    this._enqueued = new Set();
  }

  /** Start the periodic processing loop (GM only). */
  init() {
    if (!isActiveGM()) return;
    // Attempt to drain on a gentle interval; backoff is per-entry.
    this._timer = setInterval(() => this.process(), 30000);
    // Kick once shortly after ready.
    setTimeout(() => this.process(), 4000);
    logger.debug("upload-queue: initialized");
  }

  /** @returns {QueueEntry[]} the persisted queue. */
  _read() {
    return getSetting(SETTINGS.UPLOAD_QUEUE) ?? [];
  }

  /** @param {QueueEntry[]} queue */
  async _write(queue) {
    await setSetting(SETTINGS.UPLOAD_QUEUE, queue);
    Hooks.callAll?.(HOOKS.QUEUE_CHANGED, this.snapshot());
  }

  /**
   * Build a payload from the current event store and enqueue it. Used on session
   * stop and by the "Sync now" button. No-op if there are no events.
   * @returns {Promise<QueueEntry|null>}
   */
  async enqueueCurrentSession() {
    if (!isActiveGM()) return null;
    if (eventStore.size === 0) {
      logger.debug("upload-queue: nothing to enqueue (empty event store)");
      return null;
    }
    const payload = buildPayload();
    const sid = payload.session?.id;
    // Dedup: skip if this session is already queued or was already synced.
    if (sid) {
      if (this._enqueued.has(sid)) return null;
      if (this._read().some((e) => e.sessionId === sid)) return null;
      const index = getSetting(SETTINGS.SESSION_INDEX) ?? [];
      if (index.find((s) => s.id === sid && s.synced)) return null;
    }
    logger.info(`upload-queue: enqueuing session ${sid} (${payload.rawEvents.length} events)`);
    const entry = await this.enqueue(payload);
    if (sid) this._enqueued.add(sid);
    return entry;
  }

  /**
   * "Sync now": ensure the current session is queued (dedup-guarded), then
   * process. This is what the panel button calls so a sync works even when
   * nothing was auto-enqueued yet.
   * @returns {Promise<{ snapshot: ReturnType<UploadQueue["snapshot"]>, error?: string }>}
   */
  async syncNow() {
    if (!isActiveGM()) return { snapshot: this.snapshot(), error: "GM only" };
    if (!apiClient.baseUrl) return { snapshot: this.snapshot(), error: "API URL not configured" };
    await this.enqueueCurrentSession();
    await this.process();
    return { snapshot: this.snapshot() };
  }

  /**
   * Enqueue a session payload for upload.
   * @param {object} payload  Output of buildPayload().
   * @returns {Promise<QueueEntry|null>}
   */
  async enqueue(payload) {
    if (!isActiveGM()) return null;
    const queue = this._read();
    /** @type {QueueEntry} */
    const entry = {
      id: randomId(12),
      sessionId: payload?.session?.id ?? "unknown",
      payload,
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      lastError: null,
      createdAt: Date.now(),
    };
    queue.push(entry);
    await this._write(queue);
    logger.info(`upload-queue: enqueued session ${entry.sessionId}`);
    this.process();
    return entry;
  }

  /** Process all due entries with backoff. */
  async process() {
    if (this._processing || !isActiveGM()) return;
    if (!apiClient.baseUrl) return; // nothing configured yet
    this._processing = true;
    try {
      const queue = this._read();
      let changed = false;
      const now = Date.now();

      for (const entry of queue) {
        if (entry.status === "done") continue;
        if (entry.nextAttemptAt > now) continue;

        entry.attempts += 1;
        const result = await apiClient.syncSession(entry.payload);
        if (result.ok) {
          entry.status = "done";
          entry.lastError = null;
          changed = true;
          await this._markSessionSynced(entry.sessionId);
          logger.info(`upload-queue: synced session ${entry.sessionId}`);
        } else {
          entry.lastError = result.error ?? "unknown error";
          if (entry.attempts >= MAX_ATTEMPTS) {
            entry.status = "failed";
            logger.error(`upload-queue: session ${entry.sessionId} permanently failed`, entry.lastError);
          } else {
            entry.status = "pending";
            const backoff = BASE_BACKOFF_MS * 2 ** (entry.attempts - 1);
            entry.nextAttemptAt = Date.now() + backoff;
            logger.warn(`upload-queue: retry ${entry.attempts} in ${backoff}ms — ${entry.lastError}`);
          }
          changed = true;
        }
      }

      // Drop completed entries (their data lives server-side now).
      const remaining = queue.filter((e) => e.status !== "done");
      if (changed || remaining.length !== queue.length) await this._write(remaining);
    } catch (err) {
      logger.error("upload-queue: process failed", err);
    } finally {
      this._processing = false;
    }
  }

  /** Mark a session as synced in the session index. */
  async _markSessionSynced(sessionId) {
    try {
      const index = getSetting(SETTINGS.SESSION_INDEX) ?? [];
      const row = index.find((s) => s.id === sessionId);
      if (row) {
        row.synced = true;
        await setSetting(SETTINGS.SESSION_INDEX, index);
      }
    } catch (err) {
      logger.error("upload-queue: failed to mark session synced", err);
    }
  }

  /** Counts for the UI. */
  snapshot() {
    const queue = this._read();
    return {
      total: queue.length,
      pending: queue.filter((e) => e.status === "pending").length,
      failed: queue.filter((e) => e.status === "failed").length,
    };
  }
}

export const uploadQueue = new UploadQueue();
export { UploadQueue };
