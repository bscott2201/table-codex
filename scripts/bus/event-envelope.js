// @ts-check
/**
 * @file event-envelope.js
 * The telemetry envelope factory. Every event in the system is constructed here
 * so that the required-field contract (timestamp, sessionId, worldId, actorId,
 * tokenId, eventType, metadata, plus id/seq/epochMs/userId/schema) is enforced
 * at a single choke point. Fidelity is guaranteed by construction.
 */

import { ENVELOPE_SCHEMA, REQUIRED_ENVELOPE_FIELDS } from "../core/constants.js";
import { randomId, nowIso, worldId, currentUserId } from "../core/util.js";
import { logger } from "../core/logger.js";

/**
 * @typedef {Object} TelemetryEvent
 * @property {string} id          Unique event id.
 * @property {number} seq         Monotonic per-session sequence number.
 * @property {string} timestamp   ISO 8601 timestamp.
 * @property {number} epochMs     Date.now() for precise ordering.
 * @property {string} sessionId   Active session id ("unbound" pre-session).
 * @property {string} worldId     Foundry world id.
 * @property {string|null} actorId
 * @property {string|null} tokenId
 * @property {string} userId      Triggering user id.
 * @property {string} eventType   One of EVENT_TYPES.
 * @property {object} metadata    Event-specific payload.
 * @property {number} schema      Envelope schema version.
 */

/** Monotonic sequence counter; reset by session-manager on session start. */
let _seq = 0;

/** Reset the sequence counter (called when a new session starts). */
export function resetSeq(value = 0) {
  _seq = value;
}

/** Read the current sequence value (for persistence on stop). */
export function currentSeq() {
  return _seq;
}

/**
 * @typedef {Object} BuildOptions
 * @property {string|null} [actorId]
 * @property {string|null} [tokenId]
 * @property {string} [userId]
 * @property {object} [metadata]
 * @property {string} [sessionId]  Override (used when reconstructing/forwarding).
 * @property {number} [seq]        Override (used when re-hydrating forwarded events).
 * @property {string} [timestamp]
 * @property {number} [epochMs]
 * @property {string} [id]
 */

/**
 * Build a fully-formed, validated telemetry envelope.
 * @param {string} eventType  One of EVENT_TYPES.
 * @param {BuildOptions} [opts]
 * @returns {TelemetryEvent|null} null if validation fails (logged, never thrown
 *   to the caller — capture must never crash a Foundry hook).
 */
export function buildEvent(eventType, opts = {}) {
  const epochMs = opts.epochMs ?? Date.now();
  /** @type {TelemetryEvent} */
  const event = {
    id: opts.id ?? randomId(),
    seq: opts.seq ?? ++_seq,
    timestamp: opts.timestamp ?? nowIso(),
    epochMs,
    sessionId: opts.sessionId ?? _activeSessionId(),
    worldId: worldId(),
    actorId: opts.actorId ?? null,
    tokenId: opts.tokenId ?? null,
    userId: opts.userId ?? currentUserId(),
    eventType,
    metadata: opts.metadata ?? {},
    schema: ENVELOPE_SCHEMA,
  };

  if (!validateEvent(event)) return null;
  return event;
}

/**
 * Validate that an event satisfies the required-field contract. `actorId` and
 * `tokenId` are required *keys* but may be null.
 * @param {TelemetryEvent} event
 * @returns {boolean}
 */
export function validateEvent(event) {
  if (!event || typeof event !== "object") {
    logger.error("envelope: event is not an object", event);
    return false;
  }
  for (const field of REQUIRED_ENVELOPE_FIELDS) {
    if (!(field in event)) {
      logger.error(`envelope: missing required field "${field}"`, event);
      return false;
    }
  }
  if (typeof event.eventType !== "string" || !event.eventType) {
    logger.error("envelope: invalid eventType", event);
    return false;
  }
  if (typeof event.metadata !== "object" || event.metadata === null) {
    logger.error("envelope: metadata must be an object", event);
    return false;
  }
  return true;
}

/**
 * Resolve the active session id without creating an import cycle to the session
 * manager. The session manager publishes the id onto the module global.
 * @private
 */
function _activeSessionId() {
  return globalThis.TableCodexSync?.sessionManager?.sessionId ?? "unbound";
}
