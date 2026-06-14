// @ts-check
/**
 * @file hp-capture.js
 * Captures hit-point changes. Uses the `preUpdate*` hooks where the document
 * still holds the OLD values while `changes` holds the NEW — so we can record a
 * precise before/after delta in a single place without stashing snapshots.
 *
 * Handles both linked actors (preUpdateActor) and unlinked token actors
 * (preUpdateToken → delta.actorData / token-level overrides). The HP path is the
 * generic dnd5e/5e-like `system.attributes.hp`, but the diff is defensive.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { getProp, resolveActorToken, diffTouches } from "../core/util.js";
import { canCapture, emit } from "./base.js";

const HP_ROOT = "system.attributes.hp";

/**
 * Read the hp sub-object {value, temp, max, ...} from a source object using a
 * base ("old") and an overlay ("changes") so we can compute before/after.
 */
function hpFrom(base, changes, path = HP_ROOT) {
  const oldHp = getProp(base, path) ?? {};
  const changeHp = getProp(changes, path) ?? {};
  return {
    before: {
      value: oldHp.value ?? null,
      temp: oldHp.temp ?? null,
      max: oldHp.max ?? null,
    },
    after: {
      value: changeHp.value ?? oldHp.value ?? null,
      temp: changeHp.temp ?? oldHp.temp ?? null,
      max: changeHp.max ?? oldHp.max ?? null,
    },
  };
}

/** Emit an HP change event given before/after and document context. */
function emitHp(doc, before, after, userId) {
  const valueDelta = (after.value ?? 0) - (before.value ?? 0);
  const tempDelta = (after.temp ?? 0) - (before.temp ?? 0);
  if (valueDelta === 0 && tempDelta === 0 && before.max === after.max) return;

  const { actorId, tokenId } = resolveActorToken(doc);
  emit(EVENT_TYPES.HP_CHANGE, {
    userId,
    actorId,
    tokenId,
    metadata: {
      before,
      after,
      valueDelta,
      tempDelta,
      direction: valueDelta < 0 ? "damage" : valueDelta > 0 ? "healing" : "none",
      docName: doc?.name ?? null,
    },
  });
}

/** preUpdateActor — linked actor HP. */
export function onPreUpdateActor(actor, changes, _options, userId) {
  if (!canCapture(userId)) return;
  if (!diffTouches(changes, HP_ROOT)) return;
  const { before, after } = hpFrom(actor, changes);
  emitHp(actor, before, after, userId);
}

/**
 * preUpdateToken — unlinked token actor HP (delta stored on the token's
 * actorData / delta). Linked tokens route through the actor hook instead.
 */
export function onPreUpdateToken(tokenDoc, changes, _options, userId) {
  if (!canCapture(userId)) return;
  // Unlinked tokens carry an actor delta; the HP override lives under it.
  const deltaPath = "delta.system.attributes.hp";
  if (!diffTouches(changes, deltaPath)) return;
  const actor = tokenDoc.actor ?? tokenDoc;
  const before = getProp(actor, HP_ROOT) ?? {};
  const changeHp = getProp(changes, deltaPath) ?? {};
  emitHp(
    tokenDoc,
    { value: before.value ?? null, temp: before.temp ?? null, max: before.max ?? null },
    {
      value: changeHp.value ?? before.value ?? null,
      temp: changeHp.temp ?? before.temp ?? null,
      max: changeHp.max ?? before.max ?? null,
    },
    userId,
  );
}
