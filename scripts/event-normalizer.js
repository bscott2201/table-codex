import { getSetting } from "./settings.js";
import { _snapshotActor, _snapshotItem, _snapshotScene } from "./session-recorder.js";

// ---------------------------------------------------------------------------
// Chat / Roll normalization
// ---------------------------------------------------------------------------

export function normalizeChat(message) {
  const privacy = {
    captureWhispers: getSetting("captureWhispers"),
    capturePrivateRolls: getSetting("capturePrivateRolls"),
  };

  const whisperIds = message.whisper ?? [];
  const isWhisper = whisperIds.length > 0;
  const isBlind = message.blind ?? false;
  const rollMode = message.rollMode ?? message.type;

  // Private roll: GMROLL or BLINDROLL
  const privateRollModes = ["gmroll", "blindroll", CONST.DICE_ROLL_MODES?.PRIVATE, CONST.DICE_ROLL_MODES?.BLIND].filter(Boolean);
  const isPrivateRoll = privateRollModes.includes(rollMode);

  if (isWhisper && !privacy.captureWhispers) return null;
  if (isPrivateRoll && !privacy.capturePrivateRolls) return null;

  const speaker = message.speaker ?? {};
  const user = game.users?.get(message.user) ?? game.users?.get(message.author);
  const actor = speaker.actor ? game.actors?.get(speaker.actor) : null;

  const out = {
    messageId: message.id,
    timestamp: message.timestamp ? new Date(message.timestamp).toISOString() : new Date().toISOString(),
    speaker: {
      userId: message.user ?? message.author ?? null,
      userName: user?.name ?? null,
      actorId: speaker.actor ?? null,
      actorName: speaker.alias ?? actor?.name ?? null,
      tokenId: speaker.token ?? null,
      scene: speaker.scene ?? null,
    },
    content: message.content ?? "",
    flavor: message.flavor ?? "",
    isWhisper,
    isBlind,
    isPrivateRoll,
    whisperTargetIds: whisperIds,
    rolls: [],
  };

  // Attach roll data if present
  const rolls = message.rolls ?? [];
  for (const roll of rolls) {
    out.rolls.push(_normalizeRoll(roll, out.speaker, out.timestamp));
  }

  return out;
}

export function normalizeRoll(roll, speaker, timestamp) {
  return _normalizeRoll(roll, speaker, timestamp ?? new Date().toISOString());
}

function _normalizeRoll(roll, speaker, timestamp) {
  const terms = (roll.terms ?? []).map((t) => ({
    type: t.constructor?.name ?? "Term",
    formula: t.formula ?? "",
    results: t.results?.map((r) => r.result ?? r) ?? [],
  }));

  return {
    rollId: `roll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp,
    formula: roll.formula ?? "",
    total: roll.total ?? null,
    result: roll.result ?? null,
    terms,
    speaker: speaker ?? null,
  };
}

// ---------------------------------------------------------------------------
// Combat normalization
// ---------------------------------------------------------------------------

export function normalizeCombatEvent(subtype, combat, extra = {}) {
  if (!combat) return null;

  const combatants = (combat.combatants ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    actorId: c.actorId,
    tokenId: c.tokenId,
    initiative: c.initiative,
    defeated: c.defeated ?? false,
    hidden: c.hidden ?? false,
  }));

  return {
    subtype,
    timestamp: new Date().toISOString(),
    combatId: combat.id,
    scene: combat.scene?.id ?? combat.sceneId ?? null,
    sceneName: combat.scene?.name ?? null,
    round: combat.round ?? 0,
    turn: combat.turn ?? 0,
    active: combat.active ?? false,
    combatants,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Scene normalization
// ---------------------------------------------------------------------------

export function normalizeSceneView(scene) {
  if (!scene) return null;
  const ts = new Date().toISOString();
  return _snapshotScene(scene, ts, "viewed");
}

// ---------------------------------------------------------------------------
// Actor / Item normalization for live events
// ---------------------------------------------------------------------------

export function normalizeActorEvent(subtype, actor) {
  if (!actor) return null;
  const ts = new Date().toISOString();
  return _snapshotActor(actor, ts, subtype);
}

export function normalizeItemEvent(subtype, item) {
  if (!item) return null;
  const ts = new Date().toISOString();
  return _snapshotItem(item, ts, subtype);
}

// ---------------------------------------------------------------------------
// Journal normalization
// ---------------------------------------------------------------------------

export function normalizeJournalEvent(subtype, journal) {
  if (!journal) return null;
  const captureText = getSetting("captureJournalText");

  const pages = (journal.pages ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    text: captureText ? (p.text?.content ?? "") : undefined,
  }));

  return {
    subtype,
    timestamp: new Date().toISOString(),
    journalId: journal.id,
    name: journal.name,
    folder: journal.folder?.name ?? null,
    pages,
  };
}
