// @ts-check
/**
 * @file combat-capture.js
 * Captures combat structure: start, end, round and turn changes, and combatant
 * updates (initiative, defeated). Combat is GM-authoritative, so these mostly
 * fire on the GM client; the triggering-user guard still dedupes correctly.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { canCapture, emit } from "./base.js";

/** Snapshot the combatant order for context. */
function combatantList(combat) {
  return (combat.combatants?.contents ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    actorId: c.actorId ?? null,
    tokenId: c.tokenId ?? null,
    initiative: c.initiative ?? null,
    defeated: Boolean(c.isDefeated ?? c.defeated),
    hidden: Boolean(c.hidden),
  }));
}

/** Resolve the currently-active combatant's ids for the envelope. */
function activeActorToken(combat) {
  const c = combat.combatant;
  return { actorId: c?.actorId ?? null, tokenId: c?.tokenId ?? null };
}

export function onCombatStart(combat, _updateData) {
  if (!canCapture(undefined)) return; // GM/system-driven → active GM owns it
  emit(EVENT_TYPES.COMBAT_START, {
    metadata: {
      combatId: combat.id,
      sceneId: combat.scene?.id ?? combat.sceneId ?? null,
      round: combat.round ?? 0,
      combatants: combatantList(combat),
    },
  });
}

export function onDeleteCombat(combat, _options, userId) {
  if (!canCapture(userId)) return;
  emit(EVENT_TYPES.COMBAT_END, {
    userId,
    metadata: {
      combatId: combat.id,
      finalRound: combat.round ?? 0,
      combatants: combatantList(combat),
    },
  });
}

export function onCombatRound(combat, _updateData, _options) {
  if (!canCapture(undefined)) return;
  emit(EVENT_TYPES.COMBAT_ROUND, {
    metadata: { combatId: combat.id, round: combat.round ?? 0 },
  });
}

export function onCombatTurn(combat, _updateData, _options) {
  if (!canCapture(undefined)) return;
  const { actorId, tokenId } = activeActorToken(combat);
  emit(EVENT_TYPES.COMBAT_TURN, {
    actorId,
    tokenId,
    metadata: {
      combatId: combat.id,
      round: combat.round ?? 0,
      turn: combat.turn ?? 0,
      activeCombatant: combat.combatant
        ? { id: combat.combatant.id, name: combat.combatant.name }
        : null,
    },
  });
}

export function onUpdateCombatant(combatant, changes, _options, userId) {
  if (!canCapture(userId)) return;
  emit(EVENT_TYPES.COMBATANT_UPDATE, {
    userId,
    actorId: combatant.actorId ?? null,
    tokenId: combatant.tokenId ?? null,
    metadata: {
      combatId: combatant.parent?.id ?? null,
      combatantId: combatant.id,
      name: combatant.name,
      changedKeys: Object.keys(changes ?? {}),
      initiative: combatant.initiative ?? null,
      defeated: Boolean(combatant.isDefeated ?? combatant.defeated),
    },
  });
}
