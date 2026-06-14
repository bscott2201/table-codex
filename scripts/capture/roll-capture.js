// @ts-check
/**
 * @file roll-capture.js
 * Captures dice rolls from chat messages — system-agnostic. Extracts every Roll
 * attached to a created ChatMessage (formula, total, dice terms, flavor) plus a
 * correlation id so a later Midi/dnd5e enrichment event can supersede this
 * best-effort record (see Phase 4 dedupe).
 */

import { EVENT_TYPES, FLAGS, MODULE_ID, SETTINGS } from "../core/constants.js";
import { resolveActorToken, randomId } from "../core/util.js";
import { canCapture, emit } from "./base.js";

/** Flatten a Roll's dice terms into a serializable summary. */
function diceSummary(roll) {
  const dice = [];
  for (const term of roll.dice ?? []) {
    dice.push({
      faces: term.faces ?? null,
      number: term.number ?? null,
      results: (term.results ?? []).map((r) => r.result),
    });
  }
  return dice;
}

/**
 * Resolve actor/token from a chat message's speaker.
 * @param {*} message
 */
function speakerActorToken(message) {
  const speaker = message.speaker ?? {};
  const actor = speaker.actor ? game.actors?.get(speaker.actor) : null;
  if (actor) return resolveActorToken(actor);
  return { actorId: speaker.actor ?? null, tokenId: speaker.token ?? null };
}

export function onCreateChatMessage(message, _options, userId) {
  if (!canCapture(userId, SETTINGS.CAPTURE_ROLLS)) return;
  const rolls = message.rolls ?? [];
  if (!rolls.length) return;

  const { actorId, tokenId } = speakerActorToken(message);
  // A correlation id ties best-effort rolls to later enriched events.
  const correlationId = message.getFlag?.(MODULE_ID, FLAGS.CORRELATION_ID) ?? randomId(12);

  for (const roll of rolls) {
    emit(EVENT_TYPES.ROLL, {
      userId,
      actorId,
      tokenId,
      metadata: {
        correlationId,
        messageId: message.id,
        flavor: message.flavor ?? null,
        formula: roll.formula ?? null,
        total: roll.total ?? null,
        dice: diceSummary(roll),
        rollType:
          message.getFlag?.("dnd5e", "roll")?.type ??
          message.flags?.dnd5e?.roll?.type ??
          null,
        speakerAlias: message.speaker?.alias ?? null,
      },
    });
  }
}
