// @ts-check
/**
 * @file session-manager.js
 * Owns the session lifecycle: start / stop / resume. A "session" is a bounded
 * window of telemetry capture identified by a `sessionId`. The manager assigns
 * the id, records a world/system/user snapshot, drives the sequence counter,
 * and emits lifecycle events both onto the telemetry bus and the Foundry Hooks
 * bus (for UI refresh).
 *
 * The active sessionId is published on `globalThis.TableCodexSync.sessionManager`
 * so the envelope factory can stamp it without an import cycle.
 */

import { MODULE_ID, MODULE_VERSION, SETTINGS, EVENT_TYPES, HOOKS } from "../core/constants.js";
import { randomId, isActiveGM } from "../core/util.js";
import { logger } from "../core/logger.js";
import { eventBus } from "../bus/event-bus.js";
import { buildEvent, resetSeq, currentSeq } from "../bus/event-envelope.js";
import { eventStore } from "../bus/event-store.js";

/**
 * @typedef {Object} SessionMeta
 * @property {string} id
 * @property {boolean} active
 * @property {number} startedAt        epoch ms
 * @property {number|null} endedAt     epoch ms
 * @property {string} worldId
 * @property {string} worldName
 * @property {string} systemId
 * @property {string} systemVersion
 * @property {string} foundryVersion
 * @property {string} moduleVersion
 * @property {string|null} campaignId
 * @property {{id:string,name:string}[]} users
 */

class SessionManager {
  constructor() {
    /** @type {SessionMeta|null} */
    this.meta = null;
  }

  /** Active session id, or "unbound" when no session is running. */
  get sessionId() {
    return this.meta?.active ? this.meta.id : "unbound";
  }

  /** Is a session currently capturing? */
  get isActive() {
    return Boolean(this.meta?.active);
  }

  /**
   * Begin a new capture session. GM-only (the GM is the authoritative writer).
   * @param {{ campaignId?: string|null }} [opts]
   * @returns {Promise<SessionMeta|null>}
   */
  async start(opts = {}) {
    if (!isActiveGM()) {
      ui.notifications?.warn("TableCodex: only the GM can start a session.");
      return null;
    }
    if (this.isActive) {
      logger.warn("session: start ignored — a session is already active");
      return this.meta;
    }

    // Fresh sequence space for the new session.
    resetSeq(0);

    const g = globalThis.game;
    this.meta = {
      id: `s_${Date.now().toString(36)}_${randomId(8)}`,
      active: true,
      startedAt: Date.now(),
      endedAt: null,
      worldId: g?.world?.id ?? "no-world",
      worldName: g?.world?.title ?? "",
      systemId: g?.system?.id ?? "",
      systemVersion: g?.system?.version ?? "",
      foundryVersion: g?.version ?? "",
      moduleVersion: g?.modules?.get?.(MODULE_ID)?.version ?? MODULE_VERSION,
      campaignId: opts.campaignId ?? this._settingCampaignId(),
      users: (g?.users?.contents ?? [])
        .filter((u) => u.active)
        .map((u) => ({ id: u.id, name: u.name })),
    };

    // Start fresh: clear any prior buffer so this session's log is clean.
    await eventStore.clear();

    eventBus.emit(buildEvent(EVENT_TYPES.SESSION_START, { metadata: { ...this.meta } }));
    await eventStore.forceFlush();

    // Mirror state to every other client so player captures stamp the right
    // sessionId and know capture is live.
    this._broadcast();
    Hooks.callAll?.(HOOKS.SESSION_STARTED, this.meta);
    logger.info(`session: started ${this.meta.id}`);
    return this.meta;
  }

  /**
   * End the active session. Finalizes the meta, force-flushes the buffer, and
   * appends a summary to the session index.
   * @returns {Promise<SessionMeta|null>}
   */
  async stop() {
    if (!isActiveGM()) return null;
    if (!this.isActive || !this.meta) {
      logger.warn("session: stop ignored — no active session");
      return null;
    }
    this.meta.active = false;
    this.meta.endedAt = Date.now();

    eventBus.emit(
      buildEvent(EVENT_TYPES.SESSION_STOP, {
        metadata: { id: this.meta.id, endedAt: this.meta.endedAt, seq: currentSeq() },
      }),
    );
    await eventStore.forceFlush();
    await this._appendToIndex(this.meta, eventStore.size);

    this._broadcast();
    Hooks.callAll?.(HOOKS.SESSION_STOPPED, this.meta);
    logger.info(`session: stopped ${this.meta.id} (${eventStore.size} events)`);
    return this.meta;
  }

  /**
   * Resume an interrupted session after a page reload. Reads the persisted
   * buffer's sessionId and rehydrates the sequence counter. Called on `ready`.
   * @returns {Promise<boolean>} true if a session was resumed.
   */
  async resume() {
    if (!isActiveGM() || !globalThis.game?.settings) return false;
    /** @type {import("../bus/event-store.js").StoredBuffer|null} */
    const stored = game.settings.get(MODULE_ID, SETTINGS.RAW_EVENT_BUFFER);
    if (!stored?.events?.length || !stored.sessionId) return false;

    // Find the session-start event to rebuild meta.
    const startEvt = stored.events.find((e) => e.eventType === EVENT_TYPES.SESSION_START);
    const stopEvt = stored.events.find((e) => e.eventType === EVENT_TYPES.SESSION_STOP);
    if (!startEvt) return false;

    resetSeq(stored.seq ?? stored.events.length);
    this.meta = /** @type {SessionMeta} */ ({
      ...startEvt.metadata,
      id: stored.sessionId,
      active: !stopEvt, // if a stop event exists, the session is finished (pending export)
    });

    if (this.meta.active) {
      eventBus.emit(buildEvent(EVENT_TYPES.SESSION_RESUME, { metadata: { id: this.meta.id } }));
      Hooks.callAll?.(HOOKS.SESSION_RESUMED, this.meta);
      logger.info(`session: resumed ${this.meta.id}`);
    } else {
      logger.info(`session: found finished-but-unexported session ${this.meta.id}`);
    }
    return this.meta.active;
  }

  /**
   * Apply session state mirrored from the GM (non-GM clients only). Lets player
   * captures stamp the correct sessionId and gate on active state.
   * @param {{ active: boolean, id: string, campaignId: string|null }|null} state
   */
  applyRemoteState(state) {
    if (isActiveGM()) return; // the GM is the source of truth
    if (!state || !state.active) {
      this.meta = null;
      return;
    }
    this.meta = /** @type {SessionMeta} */ ({
      ...(this.meta ?? {}),
      id: state.id,
      active: true,
      campaignId: state.campaignId ?? null,
    });
    logger.debug(`session: mirrored remote state (active ${state.id})`);
  }

  /** @private Broadcast the minimal session state to other clients. */
  _broadcast() {
    const state = this.meta
      ? { active: this.meta.active, id: this.meta.id, campaignId: this.meta.campaignId }
      : null;
    globalThis.TableCodexSync?.socket?.broadcastSession?.(state);
  }

  /** @private */
  _settingCampaignId() {
    try {
      return game.settings.get(MODULE_ID, SETTINGS.CAMPAIGN_ID) || null;
    } catch {
      return null;
    }
  }

  /** @private Append a finalized session summary to the world session index. */
  async _appendToIndex(meta, eventCount) {
    try {
      const index = game.settings.get(MODULE_ID, SETTINGS.SESSION_INDEX) ?? [];
      index.push({
        id: meta.id,
        startedAt: meta.startedAt,
        endedAt: meta.endedAt,
        worldId: meta.worldId,
        campaignId: meta.campaignId,
        eventCount,
        exported: false,
        synced: false,
      });
      await game.settings.set(MODULE_ID, SETTINGS.SESSION_INDEX, index);
    } catch (err) {
      logger.error("session: failed to append to index", err);
    }
  }
}

export const sessionManager = new SessionManager();
export { SessionManager };
