// @ts-check
/**
 * @file constants.js
 * Single source of truth for module identity, flags, setting keys, socket ops,
 * and the canonical telemetry event-type enum. Pure data — no Foundry globals
 * are referenced here, so this module is safe to import at any time.
 */

/** Module id — must match the folder name and module.json `id`. */
export const MODULE_ID = "tablecodex-sync";

/** Human-readable title for notifications and window chrome. */
export const MODULE_TITLE = "TableCodex Sync";

/**
 * Module version. Kept in sync with module.json by convention (the project
 * bumps module.json, this constant, and CHANGELOG.md on every change).
 */
export const MODULE_VERSION = "0.7.5";

/** Envelope schema version. Bump when the event envelope shape changes. */
export const ENVELOPE_SCHEMA = 1;

/** Persisted-state schema version for the raw event store buffer. */
export const STORE_SCHEMA = 1;

/**
 * Setting keys (world or client scoped). Centralized so capture/store/UI code
 * never hardcodes a string twice.
 * @readonly
 */
export const SETTINGS = Object.freeze({
  // Connection / campaign linking
  API_URL: "apiUrl",
  API_TOKEN: "apiToken",
  CAMPAIGN_ID: "campaignId",
  CAMPAIGN_NAME: "campaignName",

  // World identity (auto-populated)
  WORLD_ID: "foundryWorldId",
  WORLD_NAME: "foundryWorldName",

  // Capture toggles
  ENABLED: "captureEnabled",
  CAPTURE_MOVEMENT: "captureMovement",
  CAPTURE_ROLLS: "captureRolls",
  CAPTURE_DND5E: "captureDnd5e",
  CAPTURE_MIDI: "captureMidi",

  // Diagnostics
  LOG_LEVEL: "logLevel",

  // Durable state (hidden settings, world scope)
  RAW_EVENT_BUFFER: "rawEventBuffer", // write-ahead buffer for the active session
  SESSION_INDEX: "sessionIndex", // list of finalized session summaries
  UPLOAD_QUEUE: "uploadQueue", // durable sync queue
});

/**
 * Document flag scopes used to stamp data we create (e.g. correlation ids).
 * @readonly
 */
export const FLAGS = Object.freeze({
  CORRELATION_ID: "correlationId",
});

/**
 * socketlib operation names. The GM is the authoritative writer; players send
 * their captured envelopes to the GM via these ops.
 * @readonly
 */
export const SOCKET_OPS = Object.freeze({
  FORWARD_EVENT: "forwardEvent", // player -> GM: persist this envelope
  FORWARD_BATCH: "forwardBatch", // player -> GM: persist a batch of envelopes
  SESSION_SYNC: "sessionSync", // GM -> everyone: active session id + state mirror
});

/**
 * Internal Hook names emitted on the global Foundry Hooks bus (namespaced by
 * module id). External code / UI listens to these for lifecycle changes.
 * @readonly
 */
export const HOOKS = Object.freeze({
  SESSION_STARTED: `${MODULE_ID}.sessionStarted`,
  SESSION_STOPPED: `${MODULE_ID}.sessionStopped`,
  SESSION_RESUMED: `${MODULE_ID}.sessionResumed`,
  EVENT_STORED: `${MODULE_ID}.eventStored`,
  BUFFER_FLUSHED: `${MODULE_ID}.bufferFlushed`,
  QUEUE_CHANGED: `${MODULE_ID}.queueChanged`,
});

/**
 * Canonical telemetry event types. This is the ONLY place `eventType` strings
 * are defined; capture modules and the reconstruction engine both reference it.
 * Grouped by phase for readability. Values are stable wire identifiers — never
 * rename without versioning the envelope schema.
 * @readonly
 */
export const EVENT_TYPES = Object.freeze({
  // ── Session lifecycle ──────────────────────────────────────────────
  SESSION_START: "session.start",
  SESSION_STOP: "session.stop",
  SESSION_RESUME: "session.resume",

  // ── Phase 2: core telemetry ────────────────────────────────────────
  HP_CHANGE: "actor.hp.change",
  MOVEMENT: "token.movement",
  CONDITION_ADD: "condition.add",
  CONDITION_UPDATE: "condition.update",
  CONDITION_REMOVE: "condition.remove",
  COMBAT_START: "combat.start",
  COMBAT_END: "combat.end",
  COMBAT_ROUND: "combat.round",
  COMBAT_TURN: "combat.turn",
  COMBATANT_UPDATE: "combat.combatant.update",
  ROLL: "roll",
  SCENE_VIEW: "scene.view",
  TOKEN_CREATE: "token.create",
  TOKEN_DELETE: "token.delete",

  // ── Phase 3: dnd5e activity layer ─────────────────────────────────
  ACTIVITY_USE: "dnd5e.activity.use",
  SPELL_CAST: "dnd5e.spell.cast",
  WEAPON_ATTACK: "dnd5e.weapon.attack",
  FEATURE_USE: "dnd5e.feature.use",
  RESOURCE_CONSUME: "dnd5e.resource.consume",
  REST: "dnd5e.rest",

  // ── Phase 4: Midi-QOL enriched ─────────────────────────────────────
  MIDI_ATTACK: "midi.attack",
  MIDI_DAMAGE: "midi.damage",
  MIDI_SAVE: "midi.save",
  MIDI_WORKFLOW: "midi.workflow",
});

/**
 * Required envelope fields. The envelope factory validates against this list.
 * `actorId`/`tokenId` are required *keys* but may legitimately be null.
 * @readonly
 */
export const REQUIRED_ENVELOPE_FIELDS = Object.freeze([
  "id",
  "seq",
  "timestamp",
  "epochMs",
  "sessionId",
  "worldId",
  "actorId",
  "tokenId",
  "userId",
  "eventType",
  "metadata",
]);
