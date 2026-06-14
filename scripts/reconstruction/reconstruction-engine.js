// @ts-check
/**
 * @file reconstruction-engine.js
 * Phase 5 orchestrator. Reads the raw event log (never mutating it — invariant
 * #2) and produces a derived, recomputable reconstruction object: session
 * summary, final actor states, a flat session timeline, and structured combats.
 *
 * `reconstruct(events)` is pure (defaults to the live store but accepts an
 * explicit array for testing/export of historical sessions).
 */

import { EVENT_TYPES } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { eventStore } from "../bus/event-store.js";
import { sortEvents, createStateMap, applyEvent, snapshotState } from "./timeline.js";
import { reconstructCombats } from "./combat-reconstructor.js";

class ReconstructionEngine {
  /**
   * Build a full reconstruction from a raw event log.
   * @param {import("../bus/event-envelope.js").TelemetryEvent[]} [events]
   * @returns {object}
   */
  reconstruct(events) {
    const raw = events ?? eventStore.getEvents();
    const sorted = sortEvents(raw);

    const stateMap = createStateMap();
    const timeline = [];
    const counts = {};

    for (const event of sorted) {
      applyEvent(stateMap, event);
      counts[event.eventType] = (counts[event.eventType] ?? 0) + 1;
      timeline.push({
        seq: event.seq,
        timestamp: event.timestamp,
        eventType: event.eventType,
        actorId: event.actorId,
        tokenId: event.tokenId,
        summary: this._summarize(event),
      });
    }

    const startEvt = sorted.find((e) => e.eventType === EVENT_TYPES.SESSION_START);
    const stopEvt = sorted.find((e) => e.eventType === EVENT_TYPES.SESSION_STOP);

    const result = {
      generatedAt: new Date().toISOString(),
      sessionId: sorted[0]?.sessionId ?? null,
      worldId: sorted[0]?.worldId ?? null,
      startedAt: startEvt?.timestamp ?? sorted[0]?.timestamp ?? null,
      endedAt: stopEvt?.timestamp ?? sorted[sorted.length - 1]?.timestamp ?? null,
      summary: {
        eventCount: sorted.length,
        byType: counts,
        actorCount: stateMap.size,
      },
      actors: snapshotState(stateMap),
      timeline,
      combats: reconstructCombats(sorted),
    };

    logger.debug(`reconstruction: ${sorted.length} events → ${result.combats.length} combat(s)`);
    return result;
  }

  /** Short human-readable summary string per event (for the flat timeline). */
  _summarize(event) {
    const m = event.metadata ?? {};
    switch (event.eventType) {
      case EVENT_TYPES.HP_CHANGE:
        return `${m.docName ?? "actor"} ${m.direction} ${Math.abs(m.valueDelta ?? 0)} HP`;
      case EVENT_TYPES.MOVEMENT:
        return `${m.tokenName ?? "token"} moved ${Math.round(m.distance ?? 0)} units`;
      case EVENT_TYPES.CONDITION_ADD:
        return `gained ${m.name ?? (m.statuses ?? []).join(", ")}`;
      case EVENT_TYPES.CONDITION_REMOVE:
        return `lost ${m.name ?? (m.statuses ?? []).join(", ")}`;
      case EVENT_TYPES.SPELL_CAST:
        return `cast ${m.spellName} (lvl ${m.castLevel})`;
      case EVENT_TYPES.WEAPON_ATTACK:
        return `${m.kind} with ${m.itemName ?? "weapon"}`;
      case EVENT_TYPES.FEATURE_USE:
        return `used feature ${m.featureName}`;
      case EVENT_TYPES.ACTIVITY_USE:
        return `used ${m.itemName ?? m.activityName ?? "activity"}`;
      case EVENT_TYPES.RESOURCE_CONSUME:
        return `${m.direction} ${Math.abs(m.delta ?? 0)} ${m.resource}`;
      case EVENT_TYPES.ROLL:
        return `rolled ${m.formula} = ${m.total}`;
      case EVENT_TYPES.MIDI_WORKFLOW:
        return `midi: ${m.itemName} (${(m.targets ?? []).length} target[s])`;
      case EVENT_TYPES.COMBAT_START:
        return "combat started";
      case EVENT_TYPES.COMBAT_END:
        return "combat ended";
      case EVENT_TYPES.COMBAT_ROUND:
        return `round ${m.round}`;
      case EVENT_TYPES.COMBAT_TURN:
        return `turn: ${m.activeCombatant?.name ?? "?"}`;
      default:
        return event.eventType;
    }
  }
}

export const reconstructionEngine = new ReconstructionEngine();
export { ReconstructionEngine };
