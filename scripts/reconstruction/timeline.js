// @ts-check
/**
 * @file timeline.js
 * Pure reducers + data structures for reconstruction. No Foundry globals — this
 * module is fully unit-testable in plain Node, which is important because
 * reconstruction is derived data we must be able to rebuild deterministically
 * from the raw event log.
 */

import { EVENT_TYPES } from "../core/constants.js";

/**
 * @typedef {import("../bus/event-envelope.js").TelemetryEvent} TelemetryEvent
 */

/**
 * @typedef {Object} ActorState
 * @property {string} actorId
 * @property {string|null} name
 * @property {{value:number|null,temp:number|null,max:number|null}} hp
 * @property {string[]} conditions   active condition/status names
 * @property {number} damageTaken    running total
 * @property {number} healingTaken    running total
 */

/** Order events deterministically: by seq, then epochMs, then id. */
export function sortEvents(events) {
  return events.slice().sort((a, b) => {
    if (a.seq !== b.seq) return a.seq - b.seq;
    if (a.epochMs !== b.epochMs) return a.epochMs - b.epochMs;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Create a fresh actor-state map. */
export function createStateMap() {
  return new Map();
}

/** Get-or-create an actor's running state. */
function ensureActor(stateMap, actorId, name) {
  let s = stateMap.get(actorId);
  if (!s) {
    s = {
      actorId,
      name: name ?? null,
      hp: { value: null, temp: null, max: null },
      conditions: [],
      damageTaken: 0,
      healingTaken: 0,
    };
    stateMap.set(actorId, s);
  }
  if (name && !s.name) s.name = name;
  return s;
}

/**
 * Apply a single event to the running actor-state map. Returns a shallow record
 * of the affected actor's before/after (used by the combat reconstructor to
 * annotate actions). Mutates `stateMap` in place for efficiency.
 * @param {Map<string,ActorState>} stateMap
 * @param {TelemetryEvent} event
 * @returns {{ actorId: string|null, before: any, after: any }|null}
 */
export function applyEvent(stateMap, event) {
  const { actorId, eventType, metadata } = event;
  if (!actorId) return null;

  switch (eventType) {
    case EVENT_TYPES.HP_CHANGE: {
      const s = ensureActor(stateMap, actorId, metadata?.docName);
      const before = { ...s.hp };
      s.hp = { ...s.hp, ...(metadata?.after ?? {}) };
      const delta = metadata?.valueDelta ?? 0;
      if (delta < 0) s.damageTaken += -delta;
      else if (delta > 0) s.healingTaken += delta;
      return { actorId, before, after: { ...s.hp } };
    }
    case EVENT_TYPES.CONDITION_ADD: {
      const s = ensureActor(stateMap, actorId);
      const names = metadata?.statuses?.length ? metadata.statuses : [metadata?.name];
      for (const n of names) if (n && !s.conditions.includes(n)) s.conditions.push(n);
      return { actorId, before: null, after: s.conditions.slice() };
    }
    case EVENT_TYPES.CONDITION_REMOVE: {
      const s = ensureActor(stateMap, actorId);
      const names = metadata?.statuses?.length ? metadata.statuses : [metadata?.name];
      s.conditions = s.conditions.filter((c) => !names.includes(c));
      return { actorId, before: null, after: s.conditions.slice() };
    }
    default:
      return null;
  }
}

/** Snapshot the state map to a plain serializable object. */
export function snapshotState(stateMap) {
  /** @type {Record<string, ActorState>} */
  const out = {};
  for (const [id, s] of stateMap) {
    out[id] = { ...s, hp: { ...s.hp }, conditions: s.conditions.slice() };
  }
  return out;
}
