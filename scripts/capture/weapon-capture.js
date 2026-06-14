// @ts-check
/**
 * @file weapon-capture.js
 * Phase 3: records weapon attack and damage rolls. Prefers the modern
 * `dnd5e.rollAttackV2` / `dnd5e.rollDamageV2` hooks (4.x); falls back to the
 * legacy `dnd5e.rollAttack` / `dnd5e.rollDamage`. Without Midi we can't know
 * hit/miss — that enrichment arrives in Phase 4 and supersedes via correlation.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { emitsHook, resolveActivityContext } from "../integrations/dnd5e.js";
import { canCapture, emit } from "./base.js";

/** Pull the subject (activity/item) out of a dnd5e roll hook's data arg. */
function subjectFrom(data) {
  return data?.subject ?? data?.activity ?? data?.item ?? data;
}

function rollTotals(rolls) {
  const arr = Array.isArray(rolls) ? rolls : [rolls];
  return arr.filter(Boolean).map((r) => ({
    formula: r.formula ?? null,
    total: r.total ?? null,
  }));
}

function record(kind, rolls, data) {
  if (!canCapture(undefined)) return;
  const ctx = resolveActivityContext(subjectFrom(data));
  const item = ctx.item;
  emit(EVENT_TYPES.WEAPON_ATTACK, {
    actorId: ctx.actorId,
    tokenId: ctx.tokenId,
    metadata: {
      kind, // "attack" | "damage"
      itemId: item?.id ?? null,
      itemName: item?.name ?? null,
      itemType: item?.type ?? null,
      rolls: rollTotals(rolls),
      actorName: ctx.actor?.name ?? null,
    },
  });
}

export function register() {
  const modern = emitsHook("dnd5e.rollAttackV2");
  const attackHook = modern ? "dnd5e.rollAttackV2" : "dnd5e.rollAttack";
  const damageHook = modern ? "dnd5e.rollDamageV2" : "dnd5e.rollDamage";

  Hooks.on(attackHook, (rolls, data) => {
    try {
      record("attack", rolls, data);
    } catch (err) {
      logger.error("weapon-capture: attack handler failed", err);
    }
  });
  Hooks.on(damageHook, (rolls, data) => {
    try {
      record("damage", rolls, data);
    } catch (err) {
      logger.error("weapon-capture: damage handler failed", err);
    }
  });
}
