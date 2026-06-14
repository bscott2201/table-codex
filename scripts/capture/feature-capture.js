// @ts-check
/**
 * @file feature-capture.js
 * Phase 3: records feature/feat usage (class features, racial traits, etc.).
 * Filters the activity-use signal to `feat` items and emits FEATURE_USE.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { emitsHook, resolveActivityContext } from "../integrations/dnd5e.js";
import { canCapture, emit } from "./base.js";
import { getProp } from "../core/util.js";

function recordFeature(activity) {
  if (!canCapture(undefined)) return;
  const ctx = resolveActivityContext(activity);
  const item = ctx.item;
  if (item?.type !== "feat") return;

  emit(EVENT_TYPES.FEATURE_USE, {
    actorId: ctx.actorId,
    tokenId: ctx.tokenId,
    metadata: {
      itemId: item?.id ?? null,
      featureName: item?.name ?? null,
      featureType: getProp(item, "system.type.value") ?? null,
      requirements: getProp(item, "system.requirements") ?? null,
      activityType: activity?.type ?? null,
      actorName: ctx.actor?.name ?? null,
    },
  });
}

export function register() {
  if (emitsHook("dnd5e.postUseActivity")) {
    Hooks.on("dnd5e.postUseActivity", (activity) => {
      try {
        recordFeature(activity);
      } catch (err) {
        logger.error("feature-capture: handler failed", err);
      }
    });
  } else {
    Hooks.on("dnd5e.useItem", (item) => {
      try {
        recordFeature({ item });
      } catch (err) {
        logger.error("feature-capture: legacy handler failed", err);
      }
    });
  }
}
