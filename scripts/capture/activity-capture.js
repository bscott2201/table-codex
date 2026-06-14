// @ts-check
/**
 * @file activity-capture.js
 * Phase 3 umbrella: records "an activity was used" for every dnd5e activity
 * (attack, save, damage, heal, utility, summon, ...). Prefers the modern
 * `dnd5e.postUseActivity` hook (4.x); falls back to `dnd5e.useItem` (3.x). If
 * neither hook is emitted by the installed version, `maybeRegisterActivityFallback`
 * installs a libWrapper wrap on the Activity#use method — the only place we
 * monkey-wrap, and only when no hook exists.
 *
 * Specialized records (spell/weapon/feature) live in their own modules and hook
 * independently; this module emits the generic ACTIVITY_USE envelope.
 */

import { EVENT_TYPES, MODULE_ID, FLAGS } from "../core/constants.js";
import { randomId } from "../core/util.js";
import { logger } from "../core/logger.js";
import { wrap } from "../core/libwrapper.js";
import { isDnd5e, emitsHook, resolveActivityContext, classifyItem } from "../integrations/dnd5e.js";
import { canCapture, emit } from "./base.js";

/** Stamp/read a correlation id so Midi/roll events can be tied together. */
function correlationId(activity) {
  const item = activity?.item;
  // Best-effort stable id; falls back to a fresh random id.
  return item?.uuid ? `act_${item.id}_${Date.now().toString(36)}` : randomId(12);
}

/** Build + emit the generic activity-use envelope. */
export function recordActivityUse(activity, usageConfig, results) {
  if (!canCapture(undefined)) return null;
  const ctx = resolveActivityContext(activity);
  const item = ctx.item;
  const corr = correlationId(activity);

  return emit(EVENT_TYPES.ACTIVITY_USE, {
    actorId: ctx.actorId,
    tokenId: ctx.tokenId,
    metadata: {
      correlationId: corr,
      activityType: activity?.type ?? null,
      activityName: activity?.name ?? null,
      itemId: item?.id ?? null,
      itemName: item?.name ?? null,
      itemType: item?.type ?? null,
      category: classifyItem(item),
      actorName: ctx.actor?.name ?? null,
      hasAttack: Boolean(results?.hasAttack ?? activity?.attack),
      consumedResources: _summarizeConsumption(usageConfig, results),
    },
  });
}

/** Best-effort summary of what the activity consumed (slots, uses, etc.). */
function _summarizeConsumption(usageConfig, results) {
  const out = {};
  try {
    const spent = usageConfig?.spell?.slot ?? usageConfig?.consume ?? null;
    if (spent) out.requested = spent;
    if (results?.updates) out.applied = true;
  } catch {
    /* ignore */
  }
  return out;
}

/** Register the dnd5e activity-use hooks (modern preferred, legacy fallback). */
export function register() {
  if (emitsHook("dnd5e.postUseActivity")) {
    Hooks.on("dnd5e.postUseActivity", (activity, usageConfig, results) => {
      try {
        recordActivityUse(activity, usageConfig, results);
      } catch (err) {
        logger.error("activity-capture: postUseActivity handler failed", err);
      }
    });
    logger.debug("activity-capture: using dnd5e.postUseActivity");
  } else {
    // dnd5e 3.x legacy: item-level use hook.
    Hooks.on("dnd5e.useItem", (item, _config, _options) => {
      try {
        // Synthesize a minimal activity-like object from the item.
        recordActivityUse({ type: "legacy", name: item?.name, item }, {}, {});
      } catch (err) {
        logger.error("activity-capture: useItem handler failed", err);
      }
    });
    logger.debug("activity-capture: using legacy dnd5e.useItem");
  }
}

/**
 * Install a libWrapper fallback ONLY when the installed dnd5e emits no usable
 * activity hook. Called from `init` via libwrapper-hooks. In modern dnd5e this
 * is a no-op (the hook path above is used instead).
 */
export function maybeRegisterActivityFallback() {
  if (!isDnd5e()) return; // non-dnd5e systems have no activity API to wrap
  if (emitsHook("dnd5e.postUseActivity") || emitsHook("dnd5e.useItem")) {
    return; // a real hook exists — no wrap needed
  }
  // Last-resort wrap of the Activity use method.
  const target = "CONFIG.DND5E.activityTypes.utility.documentClass.prototype.use";
  wrap(
    target,
    function (wrapped, ...args) {
      const result = wrapped(...args);
      try {
        recordActivityUse(this, args?.[0] ?? {}, {});
      } catch (err) {
        logger.error("activity-capture: libWrapper fallback failed", err);
      }
      return result;
    },
    "WRAPPER",
  );
  logger.warn("activity-capture: installed libWrapper fallback (no activity hook found)");
}
