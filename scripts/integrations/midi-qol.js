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
import { resolveActorToken } from "../core/util.js";
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

/** Extract the correlation id Midi/our roll-capture share (item-derived). */
function correlationFrom(workflow) {
  const item = workflow?.item;
  return item?.id ? `act_${item.id}` : workflow?.uuid ?? null;
}

/** Summarize targets and per-target outcome from a Midi workflow. */
function targetSummary(workflow) {
  const out = [];
  const targets = workflow?.targets ? Array.from(workflow.targets) : [];
  for (const t of targets) {
    const tokenDoc = t.document ?? t;
    out.push({
      tokenId: tokenDoc?.id ?? null,
      actorId: tokenDoc?.actorId ?? t.actor?.id ?? null,
      name: tokenDoc?.name ?? t.name ?? null,
      hit: workflow?.hitTargets?.has?.(t) ?? null,
      saved: workflow?.saves?.has?.(t) ?? null,
    });
  }
  return out;
}

function _onWorkflowComplete(workflow) {
  if (!canCapture(undefined, SETTINGS.CAPTURE_MIDI)) return;
  const { actorId, tokenId } = resolveActorToken(workflow?.actor);
  emit(EVENT_TYPES.MIDI_WORKFLOW, {
    actorId,
    tokenId,
    metadata: {
      correlationId: correlationFrom(workflow),
      itemId: workflow?.item?.id ?? null,
      itemName: workflow?.item?.name ?? null,
      damageTotal: workflow?.damageTotal ?? null,
      attackTotal: workflow?.attackTotal ?? null,
      targets: targetSummary(workflow),
      isCritical: Boolean(workflow?.isCritical),
      isFumble: Boolean(workflow?.isFumble),
    },
  });
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
      attackTotal: workflow?.attackTotal ?? workflow?.attackRoll?.total ?? null,
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
