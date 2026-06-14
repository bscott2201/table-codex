// @ts-check
/**
 * @file combat-reconstructor.js
 * Pure: folds a sorted event stream into per-combat timelines. Structure:
 *   combat → rounds[] → turns[] → actions[]
 * Each action carries the running actor state before/after it (HP, conditions),
 * computed by replaying the timeline reducers in order. No Foundry globals.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { sortEvents, createStateMap, applyEvent } from "./timeline.js";

/** Event types that constitute an "action" slotted into the current turn. */
const ACTION_TYPES = new Set([
  EVENT_TYPES.HP_CHANGE,
  EVENT_TYPES.CONDITION_ADD,
  EVENT_TYPES.CONDITION_UPDATE,
  EVENT_TYPES.CONDITION_REMOVE,
  EVENT_TYPES.ROLL,
  EVENT_TYPES.ACTIVITY_USE,
  EVENT_TYPES.SPELL_CAST,
  EVENT_TYPES.WEAPON_ATTACK,
  EVENT_TYPES.FEATURE_USE,
  EVENT_TYPES.RESOURCE_CONSUME,
  EVENT_TYPES.MIDI_ATTACK,
  EVENT_TYPES.MIDI_DAMAGE,
  EVENT_TYPES.MIDI_SAVE,
  EVENT_TYPES.MIDI_WORKFLOW,
]);

/**
 * @param {import("../bus/event-envelope.js").TelemetryEvent[]} events
 * @returns {object[]} array of reconstructed combats
 */
export function reconstructCombats(events) {
  const sorted = sortEvents(events);
  const stateMap = createStateMap();

  /** @type {Map<string, any>} combatId -> combat record */
  const combats = new Map();
  /** Currently-open combat id (null when out of combat). */
  let activeCombatId = null;

  const newRound = (n) => ({ round: n, turns: [] });
  const newTurn = (combatant, round) => ({
    round,
    combatantId: combatant?.id ?? null,
    actorId: combatant?.actorId ?? null,
    name: combatant?.name ?? null,
    actions: [],
  });

  const currentCombat = () => (activeCombatId ? combats.get(activeCombatId) : null);
  const currentRound = () => {
    const c = currentCombat();
    return c?.rounds?.[c.rounds.length - 1] ?? null;
  };
  const currentTurn = () => {
    const r = currentRound();
    return r?.turns?.[r.turns.length - 1] ?? null;
  };

  for (const event of sorted) {
    // Always advance running actor state first.
    const stateChange = applyEvent(stateMap, event);

    switch (event.eventType) {
      case EVENT_TYPES.COMBAT_START: {
        const id = event.metadata?.combatId ?? event.id;
        activeCombatId = id;
        combats.set(id, {
          combatId: id,
          sceneId: event.metadata?.sceneId ?? null,
          startedAt: event.timestamp,
          endedAt: null,
          combatants: event.metadata?.combatants ?? [],
          rounds: [newRound(event.metadata?.round ?? 1)],
        });
        break;
      }
      case EVENT_TYPES.COMBAT_ROUND: {
        const c = currentCombat();
        if (c) c.rounds.push(newRound(event.metadata?.round ?? c.rounds.length + 1));
        break;
      }
      case EVENT_TYPES.COMBAT_TURN: {
        const c = currentCombat();
        const r = currentRound();
        if (c && r) {
          const combatant = event.metadata?.activeCombatant
            ? {
                id: event.metadata.activeCombatant.id,
                name: event.metadata.activeCombatant.name,
                actorId: event.actorId,
              }
            : { id: null, name: null, actorId: event.actorId };
          r.turns.push(newTurn(combatant, r.round));
        }
        break;
      }
      case EVENT_TYPES.COMBAT_END: {
        const c = currentCombat();
        if (c) c.endedAt = event.timestamp;
        activeCombatId = null;
        break;
      }
      default: {
        // Slot action-type events into the current turn (if in combat).
        if (ACTION_TYPES.has(event.eventType)) {
          const turn = currentTurn();
          const action = {
            seq: event.seq,
            timestamp: event.timestamp,
            eventType: event.eventType,
            actorId: event.actorId,
            tokenId: event.tokenId,
            metadata: event.metadata,
            stateBefore: stateChange?.before ?? null,
            stateAfter: stateChange?.after ?? null,
          };
          if (turn) turn.actions.push(action);
          // Out-of-combat actions are captured by the session timeline, not here.
        }
        break;
      }
    }
  }

  return Array.from(combats.values());
}
