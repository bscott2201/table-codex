// @ts-check
/**
 * @file spell-capture.js
 * Phase 3: records spell casts with level, slot, school, and scaling. Hooks the
 * same activity-use signal as the umbrella but filters to spell items and emits
 * the specialized SPELL_CAST event.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { emitsHook, resolveActivityContext } from "../integrations/dnd5e.js";
import { canCapture, emit } from "./base.js";
import { getProp } from "../core/util.js";

function recordCast(activity, usageConfig) {
  if (!canCapture(undefined)) return;
  const ctx = resolveActivityContext(activity);
  const item = ctx.item;
  if (item?.type !== "spell") return;

  const baseLevel = getProp(item, "system.level") ?? null;
  const castLevel =
    usageConfig?.spell?.level ??
    getProp(usageConfig, "spell.slot") ??
    baseLevel;

  emit(EVENT_TYPES.SPELL_CAST, {
    actorId: ctx.actorId,
    tokenId: ctx.tokenId,
    metadata: {
      itemId: item?.id ?? null,
      spellName: item?.name ?? null,
      baseLevel,
      castLevel,
      upcast: castLevel != null && baseLevel != null ? castLevel - baseLevel : 0,
      school: getProp(item, "system.school") ?? null,
      prepared: Boolean(getProp(item, "system.preparation.prepared")),
      ritual: Boolean(getProp(item, "system.properties")?.has?.("ritual")),
      actorName: ctx.actor?.name ?? null,
    },
  });
}

export function register() {
  if (emitsHook("dnd5e.postUseActivity")) {
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig) => {
      try {
        recordCast(activity, usageConfig);
      } catch (err) {
        logger.error("spell-capture: handler failed", err);
      }
    });
  } else {
    Hooks.on("dnd5e.useItem", (item, config) => {
      try {
        recordCast({ item }, config);
      } catch (err) {
        logger.error("spell-capture: legacy handler failed", err);
      }
    });
  }
}
