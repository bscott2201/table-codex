// @ts-check
/**
 * @file condition-capture.js
 * Captures status/condition changes via ActiveEffect create/update/delete. Maps
 * to status ids (statuses set) and effect names. System-agnostic — works for any
 * system that uses ActiveEffects for conditions (dnd5e does).
 */

import { EVENT_TYPES } from "../core/constants.js";
import { resolveActorToken } from "../core/util.js";
import { canCapture, emit } from "./base.js";

/** Extract a stable descriptor from an ActiveEffect document. */
function effectInfo(effect) {
  const statuses = effect.statuses ? Array.from(effect.statuses) : [];
  return {
    effectId: effect.id ?? null,
    name: effect.name ?? effect.label ?? null,
    statuses,
    disabled: Boolean(effect.disabled),
    durationRounds: effect.duration?.rounds ?? null,
    durationSeconds: effect.duration?.seconds ?? null,
    origin: effect.origin ?? null,
  };
}

/** The parent of an ActiveEffect is the actor (or an item on the actor). */
function effectActorToken(effect) {
  const parent = effect.parent;
  // Effect on an item → climb to the actor.
  const actor = parent?.documentName === "Actor" ? parent : parent?.actor ?? parent?.parent ?? null;
  return resolveActorToken(actor ?? effect);
}

export function onCreateActiveEffect(effect, _options, userId) {
  if (!canCapture(userId)) return;
  const { actorId, tokenId } = effectActorToken(effect);
  emit(EVENT_TYPES.CONDITION_ADD, {
    userId,
    actorId,
    tokenId,
    metadata: effectInfo(effect),
  });
}

export function onUpdateActiveEffect(effect, changes, _options, userId) {
  if (!canCapture(userId)) return;
  const { actorId, tokenId } = effectActorToken(effect);
  emit(EVENT_TYPES.CONDITION_UPDATE, {
    userId,
    actorId,
    tokenId,
    metadata: { ...effectInfo(effect), changedKeys: Object.keys(changes ?? {}) },
  });
}

export function onDeleteActiveEffect(effect, _options, userId) {
  if (!canCapture(userId)) return;
  const { actorId, tokenId } = effectActorToken(effect);
  emit(EVENT_TYPES.CONDITION_REMOVE, {
    userId,
    actorId,
    tokenId,
    metadata: effectInfo(effect),
  });
}
