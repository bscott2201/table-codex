// @ts-check
/**
 * @file dnd5e.js
 * D&D5e system detection and version gating. Phase 3 capture is dnd5e-specific;
 * everything here is defensive so a future dnd5e version (or its absence) never
 * breaks the module. The dnd5e system emits rich, non-deprecated hooks in 4.x:
 *   dnd5e.useActivity / dnd5e.postUseActivity, dnd5e.rollAttackV2,
 *   dnd5e.rollDamageV2, dnd5e.rollSavingThrow, dnd5e.restCompleted, ...
 * We prefer those and only fall back to a libWrapper wrap when a needed hook is
 * absent (see activity-capture `maybeRegisterActivityFallback`).
 */

import { logger } from "../core/logger.js";

let _detected = {
  isDnd5e: false,
  version: null,
  /** Major version number (e.g. 4 for "4.1.2"). */
  major: 0,
  /** True if the Activity API (dnd5e 3.2+/4.x) is present. */
  hasActivities: false,
};

/** Run detection. Called in `setup` (localization ready). */
export function detectSystem() {
  try {
    const sys = globalThis.game?.system;
    const isDnd = sys?.id === "dnd5e";
    const version = sys?.version ?? null;
    const major = version ? Number.parseInt(String(version).split(".")[0], 10) || 0 : 0;
    // The Activity API replaced item "use" in dnd5e 3.2; firmly present in 4.x.
    const hasActivities = Boolean(globalThis.CONFIG?.DND5E?.activityTypes) || major >= 4;
    _detected = { isDnd5e: isDnd, version, major, hasActivities };
    logger.info(
      `dnd5e: detected=${isDnd} version=${version} activities=${hasActivities}`,
    );
  } catch (err) {
    logger.error("dnd5e: detection failed", err);
  }
  return _detected;
}

/** @returns {boolean} */
export function isDnd5e() {
  return _detected.isDnd5e;
}

/** @returns {boolean} whether the dnd5e Activity API is available. */
export function hasActivities() {
  return _detected.hasActivities;
}

/** @returns {{isDnd5e:boolean,version:string|null,major:number,hasActivities:boolean}} */
export function systemInfo() {
  return { ..._detected };
}

/**
 * Does a named dnd5e hook exist in this version? We can't truly introspect the
 * system's emitters, so we gate by version heuristics. Used to decide whether a
 * libWrapper fallback is needed.
 * @param {string} hookName
 * @returns {boolean}
 */
export function emitsHook(hookName) {
  if (!_detected.isDnd5e) return false;
  // dnd5e 4.x emits the modern activity/roll hooks. 3.x emits useItem/rollAttack.
  const modern = [
    "dnd5e.postUseActivity",
    "dnd5e.useActivity",
    "dnd5e.rollAttackV2",
    "dnd5e.rollDamageV2",
    "dnd5e.rollSavingThrow",
    "dnd5e.restCompleted",
  ];
  if (modern.includes(hookName)) return _detected.major >= 4;
  return true;
}

/**
 * Resolve a normalized context from a dnd5e Activity (or item-like) object.
 * Defensive across dnd5e 3.x/4.x shapes.
 * @param {*} activityOrItem
 * @returns {{ activity: any, item: any, actor: any, actorId: string|null, tokenId: string|null }}
 */
export function resolveActivityContext(activityOrItem) {
  const activity = activityOrItem?.type && activityOrItem?.item ? activityOrItem : null;
  const item = activity?.item ?? activityOrItem?.item ?? activityOrItem ?? null;
  const actor = activity?.actor ?? item?.actor ?? item?.parent ?? null;
  const token = actor?.token ?? actor?.getActiveTokens?.()?.[0]?.document ?? null;
  return {
    activity,
    item,
    actor,
    actorId: actor?.id ?? null,
    tokenId: token?.id ?? actor?.getActiveTokens?.()?.[0]?.id ?? null,
  };
}

/**
 * Stable correlation id for one item's use, shared by EVERY capture module that
 * observes the same activity (activity-use, spell, weapon, feature) and by the
 * Midi enrichment layer. This is what lets the best-effort dnd5e events and the
 * high-fidelity Midi workflow events for a single action be joined downstream
 * (the "supersede" design): they all carry the same key.
 *
 * It is derived from the ITEM id rather than a per-use nonce on purpose. The
 * dnd5e activity hooks (`postUseActivity`, `rollAttackV2`, …) and the Midi
 * workflow hooks fire from independent dispatches with no shared per-use token,
 * so an item-stable key is the most reliable thing both sides can compute. The
 * tradeoff: multiple uses of the SAME item within a session share a correlation
 * group — downstream can split them by `seq`/timestamp proximity. This matches
 * Midi's own scheme, so aligning everyone to it keeps the whole pipeline
 * consistent rather than inventing a competing id.
 * @param {*} activityOrItem  An Activity, item, or Midi workflow (anything
 *   `resolveActivityContext` understands).
 * @returns {string|null} `act_<itemId>` or null when no item id is resolvable.
 */
export function activityCorrelationId(activityOrItem) {
  const ctx = resolveActivityContext(activityOrItem);
  const id = ctx.item?.id ?? null;
  return id ? `act_${id}` : null;
}

/** Classify a dnd5e item by its type into our coarse buckets. */
export function classifyItem(item) {
  const type = item?.type ?? null;
  switch (type) {
    case "spell":
      return "spell";
    case "weapon":
      return "weapon";
    case "feat":
      return "feature";
    case "consumable":
    case "equipment":
    case "tool":
    case "loot":
      return "equipment";
    default:
      return type ?? "unknown";
  }
}
