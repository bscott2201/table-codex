// @ts-check
/**
 * @file midi-qol.js
 * Phase 4: optional Midi-QOL enrichment. Midi-QOL is NOT a dependency — this
 * layer is detected at runtime and cleanly no-ops when absent. When present, it
 * subscribes to Midi's workflow hooks to emit high-fidelity attack/damage/save
 * events (hit/miss, targets, damage actually applied) that *supersede* the
 * best-effort Phase 2/3 roll events via a shared correlation id.
 *
 * Midi emits (names vary slightly by Midi version):
 *   "midi-qol.RollComplete"          — the whole workflow finished
 *   "midi-qol.AttackRollComplete"    — attack resolved (hits computed)
 *   "midi-qol.DamageRollComplete"    — damage rolled
 *   "midi-qol.preCheckSaves"/"..."   — saves
 * We bind defensively and tolerate missing hooks.
 */

import { EVENT_TYPES, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { getSetting } from "../core/settings.js";
import { resolveActorToken, getProp } from "../core/util.js";
import { activityCorrelationId } from "./dnd5e.js";
import { canCapture, emit } from "./../capture/base.js";

let _wired = false;

/** @returns {boolean} whether Midi-QOL is installed and active. */
export function isMidiActive() {
  return Boolean(globalThis.game?.modules?.get?.("midi-qol")?.active);
}

/**
 * Detect Midi-QOL and wire its workflow hooks. Called from `ready`. No-op (with
 * a log line) when Midi is absent or disabled by setting.
 */
export function detectAndWireMidi() {
  if (_wired) return;
  if (!isMidiActive()) {
    logger.info("midi-qol: not active — enrichment disabled");
    return;
  }
  if (getSetting(SETTINGS.CAPTURE_MIDI) === false) {
    logger.info("midi-qol: present but disabled by setting");
    return;
  }
  _wired = true;

  _safeOn("midi-qol.RollComplete", _onWorkflowComplete);
  _safeOn("midi-qol.AttackRollComplete", _onAttackComplete);
  _safeOn("midi-qol.DamageRollComplete", _onDamageComplete);
  logger.info("midi-qol: enrichment wired");
}

/** Register a hook with a per-handler try/catch. */
function _safeOn(hookName, handler) {
  Hooks.on(hookName, (...args) => {
    try {
      handler(...args);
    } catch (err) {
      logger.error(`midi-qol: ${hookName} handler failed`, err);
    }
  });
}

/**
 * Correlation id for a Midi workflow — derived through the SHARED helper so it is
 * byte-for-byte identical to the id stamped by activity/spell/weapon/feature
 * capture for the same item use. That identity is what lets the server supersede
 * the best-effort dnd5e events with this enriched workflow. Falls back to the
 * workflow uuid only when no item id is resolvable.
 */
function correlationFrom(workflow) {
  return activityCorrelationId(workflow) ?? workflow?.uuid ?? null;
}

/**
 * Midi's "no attack roll" sentinel leaks through as a large negative number
 * (typically -100) for save-only spells. Normalize it to null so downstream never
 * mistakes a save spell for an attack that rolled -100.
 */
export function normAttackTotal(v) {
  if (v == null) return null;
  return v <= -100 ? null : v;
}

/** Does this workflow involve a saving throw? */
export function isSaveWorkflow(workflow) {
  return Boolean(
    workflow?.saveDC ??
      workflow?.activity?.save ??
      getProp(workflow, "item.system.save.dc") ??
      (workflow?.saves && (workflow.saves.size || workflow.failedSaves?.size)),
  );
}

/**
 * Resolve the save DC and ability behind a workflow. dnd5e 5.x carries the save on
 * the Activity (`activity.save.dc.value` / `save.ability`); older shapes use the
 * item (`item.system.save.{dc,ability}`); Midi sometimes exposes `workflow.saveDC`.
 * We probe all three. Field paths verified against dnd5e 5.x + Midi-QOL — if a
 * future version moves them, inspect a live `midi-qol.RollComplete` workflow
 * (see the hook-discovery skill's inspection recipes) to find the new path.
 */
export function saveSpec(workflow) {
  const a = workflow?.activity;
  const item = workflow?.item;
  const dc =
    getProp(a, "save.dc.value") ??
    getProp(item, "system.save.dc") ??
    workflow?.saveDC ??
    null;
  let ability =
    getProp(a, "save.ability") ??
    getProp(item, "system.save.ability") ??
    workflow?.saveAbility ??
    null;
  // 5.x can express the ability as a Set/array of options — take the first.
  if (ability && typeof ability === "object") ability = Array.from(ability)[0] ?? null;
  return { dc: dc ?? null, ability: ability ?? null };
}

/**
 * Summarize per-target outcome. `workflow.damageList` is the richest source: it
 * carries the APPLIED damage per token (after resistance/vulnerability AND
 * save-for-half), HP before/after, and the save flag — which is exactly what the
 * old `hit`/`saved`-only summary was missing (a Fireball that deals 26 to a failed
 * target and 13 to one that saved looked identical before). We key off it when
 * present and fall back to the target/hit/save Sets otherwise.
 */
export function targetSummary(workflow) {
  const dmgBy = new Map();
  for (const d of workflow?.damageList ?? []) {
    const tid = d.tokenId ?? d.tokenUuid ?? d.actorId ?? null;
    if (tid) dmgBy.set(tid, d);
  }
  const out = [];
  const targets = workflow?.targets ? Array.from(workflow.targets) : [];
  for (const t of targets) {
    const tokenDoc = t.document ?? t;
    const tid = tokenDoc?.id ?? null;
    const d = dmgBy.get(tid) ?? dmgBy.get(t.actor?.id) ?? null;
    out.push({
      tokenId: tid,
      actorId: tokenDoc?.actorId ?? t.actor?.id ?? null,
      name: tokenDoc?.name ?? t.name ?? null,
      hit: workflow?.hitTargets?.has?.(t) ?? null,
      saved: workflow?.saves?.has?.(t) ?? null,
      saveTotal: getProp(d, "saveRoll.total") ?? d?.saveTotal ?? null,
      appliedDamage: d?.appliedDamage ?? d?.hpDamage ?? d?.totalDamage ?? null,
      oldHP: d?.oldHP ?? null,
      newHP: d?.newHP ?? null,
    });
  }
  // AoE on tokens that weren't "targeted" still show up in damageList — surface them.
  if (!out.length && dmgBy.size) {
    for (const d of dmgBy.values()) {
      out.push({
        tokenId: d.tokenId ?? null,
        actorId: d.actorId ?? null,
        name: d.tokenName ?? d.name ?? null,
        hit: null,
        saved: d.saved ?? null,
        saveTotal: getProp(d, "saveRoll.total") ?? null,
        appliedDamage: d.appliedDamage ?? d.hpDamage ?? d.totalDamage ?? null,
        oldHP: d.oldHP ?? null,
        newHP: d.newHP ?? null,
      });
    }
  }
  return out;
}

function _onWorkflowComplete(workflow) {
  if (!canCapture(undefined, SETTINGS.CAPTURE_MIDI)) return;
  const { actorId, tokenId } = resolveActorToken(workflow?.actor);
  const corr = correlationFrom(workflow);
  const targets = targetSummary(workflow);
  const save = isSaveWorkflow(workflow);

  emit(EVENT_TYPES.MIDI_WORKFLOW, {
    actorId,
    tokenId,
    metadata: {
      correlationId: corr,
      itemId: workflow?.item?.id ?? null,
      itemName: workflow?.item?.name ?? null,
      damageTotal: workflow?.damageTotal ?? null,
      attackTotal: normAttackTotal(workflow?.attackTotal),
      hasAttack: Boolean(getProp(workflow, "activity.attack") ?? getProp(workflow, "item.system.hasAttack")),
      isSave: save,
      targets,
      isCritical: Boolean(workflow?.isCritical),
      isFumble: Boolean(workflow?.isFumble),
    },
  });

  // Dedicated save event (MIDI_SAVE was declared but never emitted). It answers
  // "who passed/failed, against what DC, and what did they roll" — none of which
  // the boolean-only target summary could express before.
  if (save) {
    const { dc, ability } = saveSpec(workflow);
    emit(EVENT_TYPES.MIDI_SAVE, {
      actorId,
      tokenId,
      metadata: {
        correlationId: corr,
        itemName: workflow?.item?.name ?? null,
        saveDC: dc,
        saveAbility: ability,
        targets: targets.map((t) => ({
          tokenId: t.tokenId,
          actorId: t.actorId,
          name: t.name,
          saved: t.saved,
          saveTotal: t.saveTotal,
        })),
      },
    });
  }
}

function _onAttackComplete(workflow) {
  if (!canCapture(undefined, SETTINGS.CAPTURE_MIDI)) return;
  const { actorId, tokenId } = resolveActorToken(workflow?.actor);
  emit(EVENT_TYPES.MIDI_ATTACK, {
    actorId,
    tokenId,
    metadata: {
      correlationId: correlationFrom(workflow),
      itemName: workflow?.item?.name ?? null,
      attackTotal: normAttackTotal(workflow?.attackTotal ?? workflow?.attackRoll?.total),
      isCritical: Boolean(workflow?.isCritical),
      isFumble: Boolean(workflow?.isFumble),
      targets: targetSummary(workflow),
    },
  });
}

function _onDamageComplete(workflow) {
  if (!canCapture(undefined, SETTINGS.CAPTURE_MIDI)) return;
  const { actorId, tokenId } = resolveActorToken(workflow?.actor);
  emit(EVENT_TYPES.MIDI_DAMAGE, {
    actorId,
    tokenId,
    metadata: {
      correlationId: correlationFrom(workflow),
      itemName: workflow?.item?.name ?? null,
      damageTotal: workflow?.damageTotal ?? null,
      damageDetail: workflow?.damageDetail ?? null,
      targets: targetSummary(workflow),
    },
  });
}
