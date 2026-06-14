// @ts-check
/**
 * @file socket.js
 * socketlib integration. socketlib is a REQUIRED dependency. The GM is the
 * authoritative event-store writer; player clients forward their captured
 * envelopes to the GM through these socket operations. Registered in the
 * `socketlib.ready` hook (which fires before `ready`).
 */

import { MODULE_ID, SOCKET_OPS } from "./constants.js";
import { isActiveGM } from "./util.js";
import { logger } from "./logger.js";
import { validateEvent } from "../bus/event-envelope.js";
import { eventStore } from "../bus/event-store.js";
import { sessionManager } from "../session/session-manager.js";

/** @type {*} the socketlib module socket handle */
let _socket = null;

/** @returns {boolean} whether socketlib is present. */
export function hasSocketlib() {
  return typeof globalThis.socketlib !== "undefined";
}

/**
 * Register the module with socketlib and wire the GM-side handlers. Safe to call
 * once, from the `socketlib.ready` hook.
 * @returns {object} a small facade exposed on the module global.
 */
export function registerSocket() {
  if (!hasSocketlib()) {
    logger.warn("socket: socketlib not available — running local-only");
    return _facade();
  }
  try {
    _socket = globalThis.socketlib.registerModule(MODULE_ID);
    // GM-side handlers: persist forwarded envelopes authoritatively.
    _socket.register(SOCKET_OPS.FORWARD_EVENT, _onForwardEvent);
    _socket.register(SOCKET_OPS.FORWARD_BATCH, _onForwardBatch);
    _socket.register(SOCKET_OPS.SESSION_SYNC, _onSessionSync);
    logger.info("socket: registered with socketlib");
  } catch (err) {
    logger.error("socket: registration failed", err);
  }
  return _facade();
}

/** GM handler: a single forwarded envelope. */
function _onForwardEvent(event) {
  if (!isActiveGM()) return;
  if (!validateEvent(event)) {
    logger.warn("socket: dropped invalid forwarded event");
    return;
  }
  eventStore.ingestForwarded(event);
}

/** GM handler: a batch of forwarded envelopes (buffered while GM was offline). */
function _onForwardBatch(events) {
  if (!isActiveGM() || !Array.isArray(events)) return;
  for (const event of events) {
    if (validateEvent(event)) eventStore.ingestForwarded(event);
  }
  logger.debug(`socket: ingested forwarded batch of ${events.length}`);
}

/** Everyone handler: mirror the GM's session state onto this client. */
function _onSessionSync(state) {
  sessionManager.applyRemoteState(state);
}

/**
 * The facade exposed on globalThis.TableCodexSync.socket. Player code calls
 * `forwardEvent` / `forwardBatch`; the GM calls `broadcastSession`. These route
 * via socketlib (no-ops gracefully when socketlib is absent).
 * @private
 */
function _facade() {
  return {
    forwardEvent(event) {
      if (_socket) _socket.executeAsGM(SOCKET_OPS.FORWARD_EVENT, event);
    },
    forwardBatch(events) {
      if (_socket) _socket.executeAsGM(SOCKET_OPS.FORWARD_BATCH, events);
    },
    broadcastSession(state) {
      // Notify every other connected client of the new session state.
      if (_socket) _socket.executeForOthers(SOCKET_OPS.SESSION_SYNC, state);
    },
    get ready() {
      return Boolean(_socket);
    },
  };
}
