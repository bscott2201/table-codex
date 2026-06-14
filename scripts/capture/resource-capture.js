// @ts-check
/**
 * @file resource-capture.js
 * Phase 3: records consumption of limited resources — item uses, spell slots,
 * hit dice, and class/custom resources — by diffing on `preUpdate*` (where the
 * document still holds the old value). Also records long/short rests via the
 * `dnd5e.restCompleted` hook.
 */

import { EVENT_TYPES, SETTINGS } from "../core/constants.js";
import { getProp, resolveActorToken, diffTouches } from "../core/util.js";
import { logger } from "../core/logger.js";
import { emitsHook } from "../integrations/dnd5e.js";
import { canCapture, emit } from "./base.js";

/** Emit a resource-consume event. */
function emitConsume(doc, resource, before, after, userId) {
  const delta = (after ?? 0) - (before ?? 0);
  if (delta === 0) return;
  const { actorId, tokenId } = resolveActorToken(doc);
  emit(EVENT_TYPES.RESOURCE_CONSUME, {
    userId,
    actorId,
    tokenId,
    metadata: {
      resource, // descriptor string, e.g. "item.uses", "spell.slot.3", "hd"
      before,
      after,
      delta,
      direction: delta < 0 ? "spent" : "recovered",
      docName: doc?.name ?? null,
    },
  });
}

/** preUpdateActor — spell slots, hit dice, and custom resources. */
export function onPreUpdateActor(actor, changes, _options, userId) {
  if (!canCapture(userId, SETTINGS.CAPTURE_DND5E)) return;

  // Spell slots: system.spells.spellN.value (and pact).
  if (diffTouches(changes, "system.spells")) {
    const spellsChange = getProp(changes, "system.spells") ?? {};
    for (const key of Object.keys(spellsChange)) {
      const before = getProp(actor, `system.spells.${key}.value`);
      const after = spellsChange[key]?.value;
      if (after !== undefined) emitConsume(actor, `spell.slot.${key}`, before, after, userId);
    }
  }

  // Custom resources: system.resources.primary/secondary/tertiary.value
  if (diffTouches(changes, "system.resources")) {
    const resChange = getProp(changes, "system.resources") ?? {};
    for (const key of Object.keys(resChange)) {
      const before = getProp(actor, `system.resources.${key}.value`);
      const after = resChange[key]?.value;
      if (after !== undefined) emitConsume(actor, `resource.${key}`, before, after, userId);
    }
  }
}

/** preUpdateItem — limited uses and per-item hit dice. */
export function onPreUpdateItem(item, changes, _options, userId) {
  if (!canCapture(userId, SETTINGS.CAPTURE_DND5E)) return;

  if (diffTouches(changes, "system.uses.value") || diffTouches(changes, "system.uses.spent")) {
    const beforeVal = getProp(item, "system.uses.value");
    const afterVal = getProp(changes, "system.uses.value");
    if (afterVal !== undefined) {
      emitConsume(item, `item.uses:${item.name}`, beforeVal, afterVal, userId);
    } else {
      // 4.x tracks "spent" instead of "value".
      const beforeSpent = getProp(item, "system.uses.spent");
      const afterSpent = getProp(changes, "system.uses.spent");
      if (afterSpent !== undefined) {
        emitConsume(item, `item.uses.spent:${item.name}`, beforeSpent, afterSpent, userId);
      }
    }
  }
}

/** dnd5e.restCompleted — long/short rest. */
function onRestCompleted(actor, result) {
  if (!canCapture(undefined, SETTINGS.CAPTURE_DND5E)) return;
  const { actorId, tokenId } = resolveActorToken(actor);
  emit(EVENT_TYPES.REST, {
    actorId,
    tokenId,
    metadata: {
      restType: result?.longRest ? "long" : "short",
      hpRecovered: result?.dhp ?? result?.hitPointsRecovered ?? null,
      hdRecovered: result?.dhd ?? result?.hitDiceRecovered ?? null,
      actorName: actor?.name ?? null,
    },
  });
}

export function register() {
  if (emitsHook("dnd5e.restCompleted")) {
    Hooks.on("dnd5e.restCompleted", (actor, result) => {
      try {
        onRestCompleted(actor, result);
      } catch (err) {
        logger.error("resource-capture: restCompleted failed", err);
      }
    });
  }
}
