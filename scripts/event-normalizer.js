import { getSetting } from "./settings.js";
import { _snapshotActor, _snapshotItem, _snapshotScene } from "./session-recorder.js";

// ---------------------------------------------------------------------------
// Chat normalization
// ---------------------------------------------------------------------------

export function normalizeChat(message) {
  const captureWhispers    = getSetting("captureWhispers");
  const capturePrivateRolls = getSetting("capturePrivateRolls");
  const includeRawHtml     = getSetting("includeRawHtml") !== false;

  const whisperIds  = message.whisper ?? [];
  const isWhisper   = whisperIds.length > 0;
  const isBlind     = message.blind ?? false;
  const rollMode    = message.rollMode ?? message.type;

  const privateRollModes = [
    "gmroll", "blindroll",
    CONST.DICE_ROLL_MODES?.PRIVATE,
    CONST.DICE_ROLL_MODES?.BLIND,
  ].filter(Boolean);
  const isPrivateRoll = privateRollModes.includes(rollMode);

  if (isWhisper && !captureWhispers)     return null;
  if (isPrivateRoll && !capturePrivateRolls) return null;

  const spk = message.speaker ?? {};

  // Look up user by name only — never include the full User document
  const user  = game.users?.get(message.user) ?? game.users?.get(message.author);
  const actor = spk.actor ? game.actors?.get(spk.actor) : null;

  // Sanitized speaker — only string/primitive fields, no nested documents
  const speaker = {
    userId:    message.user ?? message.author ?? null,
    userName:  user?.name  ?? null,
    actorId:   spk.actor   ?? null,
    actorName: spk.alias   ?? actor?.name ?? null,
    tokenId:   spk.token   ?? null,
    sceneId:   spk.scene   ?? null,
    sceneName: spk.scene   ? (game.scenes?.get(spk.scene)?.name ?? null) : null,
  };

  const contentRaw  = message.content ?? "";
  const contentText = _extractPlainText(contentRaw);
  const title       = _extractChatTitle(contentRaw);
  const subtitle    = _extractChatSubtitle(contentRaw);
  const category    = _extractChatCategory(message, isWhisper);

  // Extract referenced entity IDs from HTML data attributes
  const referencedActorIds = _extractReferencedActors(contentRaw, speaker);
  const referencedItemIds  = _extractReferencedItems(contentRaw);

  const out = {
    messageId:   message.id,
    id:          message.id,
    timestamp:   message.timestamp
      ? new Date(message.timestamp).toISOString()
      : new Date().toISOString(),
    speaker,
    contentText,
    title,
    subtitle,
    category,
    flavor:          message.flavor ?? "",
    isWhisper,
    isBlind,
    isPrivateRoll,
    whisperTargetIds: whisperIds,
    rolls:            [],
    referencedActorIds,
    referencedItemIds,
  };

  // Include raw HTML only when the setting allows it
  if (includeRawHtml) {
    out.contentRaw = contentRaw;
  }

  // Attach normalised roll data
  const rolls = message.rolls ?? [];
  for (const roll of rolls) {
    out.rolls.push(_normalizeRoll(roll, speaker, out.timestamp));
  }

  return out;
}

export function normalizeRoll(roll, speaker, timestamp) {
  return _normalizeRoll(roll, speaker, timestamp ?? new Date().toISOString());
}

function _normalizeRoll(roll, speaker, timestamp) {
  const terms = (roll.terms ?? []).map(function(t) {
    return {
      type:    t.constructor?.name ?? "Term",
      formula: t.formula ?? "",
      results: (t.results ?? []).map(function(r) { return r.result ?? r; }),
    };
  });

  return {
    rollId:    "roll-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
    timestamp,
    formula:   roll.formula ?? "",
    total:     roll.total   ?? null,
    result:    roll.result  ?? null,
    terms,
    speaker:   speaker ?? null,
  };
}

// ---------------------------------------------------------------------------
// Combat normalization
// ---------------------------------------------------------------------------

export function normalizeCombatEvent(subtype, combat, extra) {
  if (!combat) return null;
  extra = extra || {};

  const combatants = (combat.combatants ?? []).map(function(c) {
    return {
      id:         c.id,
      name:       c.name,
      actorId:    c.actorId,
      tokenId:    c.tokenId,
      initiative: c.initiative,
      defeated:   c.defeated ?? false,
      hidden:     c.hidden   ?? false,
    };
  });

  return Object.assign({
    subtype,
    timestamp: new Date().toISOString(),
    combatId:  combat.id,
    scene:     combat.scene?.id  ?? combat.sceneId ?? null,
    sceneName: combat.scene?.name ?? null,
    round:     combat.round ?? 0,
    turn:      combat.turn  ?? 0,
    active:    combat.active ?? false,
    combatants,
  }, extra);
}

// ---------------------------------------------------------------------------
// Scene normalization
// ---------------------------------------------------------------------------

export function normalizeSceneView(scene) {
  if (!scene) return null;
  return _snapshotScene(scene, new Date().toISOString(), "viewed");
}

// ---------------------------------------------------------------------------
// Actor / Item live event normalization
// ---------------------------------------------------------------------------

export function normalizeActorEvent(subtype, actor) {
  if (!actor) return null;
  return _snapshotActor(actor, new Date().toISOString(), subtype);
}

export function normalizeItemEvent(subtype, item) {
  if (!item) return null;
  return _snapshotItem(item, new Date().toISOString(), subtype);
}

// ---------------------------------------------------------------------------
// Journal normalization
// ---------------------------------------------------------------------------

export function normalizeJournalEvent(subtype, journal) {
  if (!journal) return null;
  const captureText = getSetting("captureJournalText");

  const pages = (journal.pages ?? []).map(function(p) {
    return {
      id:   p.id,
      name: p.name,
      type: p.type,
      text: captureText ? (p.text?.content ?? "") : undefined,
    };
  });

  return {
    subtype,
    timestamp: new Date().toISOString(),
    journalId: journal.id,
    name:      journal.name,
    folder:    journal.folder?.name ?? null,
    pages,
  };
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

function _extractPlainText(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
  } catch (e) {
    // Fallback: strip tags with regex
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
}

function _extractChatTitle(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    var el = div.querySelector(".item-name, .action, .card-header h3, h3, h4, .title");
    return el ? el.textContent.trim() : "";
  } catch (e) {
    return "";
  }
}

function _extractChatSubtitle(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    var el = div.querySelector(".subtitle, .card-subtitle, .item-type, [class*='subtitle']");
    return el ? el.textContent.trim() : "";
  } catch (e) {
    return "";
  }
}

function _extractChatCategory(message, isWhisper) {
  if (isWhisper) return "whisper";
  var typeConst = (CONST && CONST.CHAT_MESSAGE_TYPES) ? CONST.CHAT_MESSAGE_TYPES : {};
  var t = message.type;
  if (t === typeConst.ROLL   || t === "roll")  return "roll";
  if (t === typeConst.EMOTE  || t === "emote") return "emote";
  if (t === typeConst.OOC    || t === "ooc")   return "ooc";
  return "ic";
}

// ---------------------------------------------------------------------------
// Reference extraction helpers
// ---------------------------------------------------------------------------

function _extractReferencedActors(html, speaker) {
  var ids = new Set();

  // Always include the speaker's actor
  if (speaker && speaker.actorId) ids.add(speaker.actorId);

  if (!html) return Array.from(ids);

  try {
    var div = document.createElement("div");
    div.innerHTML = html;

    // data-actor-id attributes (dnd5e item cards, etc.)
    div.querySelectorAll("[data-actor-id]").forEach(function(el) {
      var id = el.dataset.actorId;
      if (id) ids.add(id);
    });

    // data-actor-uuid attributes — "Actor.XXXX" format
    div.querySelectorAll("[data-actor-uuid]").forEach(function(el) {
      var uuid = el.dataset.actorUuid || "";
      var m = uuid.match(/^Actor\.([^.]+)$/);
      if (m) ids.add(m[1]);
    });
  } catch (e) { /* ignore DOM errors */ }

  return Array.from(ids);
}

function _extractReferencedItems(html) {
  var ids = new Set();
  if (!html) return [];

  try {
    var div = document.createElement("div");
    div.innerHTML = html;

    div.querySelectorAll("[data-item-id]").forEach(function(el) {
      var id = el.dataset.itemId;
      if (id) ids.add(id);
    });

    div.querySelectorAll("[data-item-uuid]").forEach(function(el) {
      var uuid = el.dataset.itemUuid || "";
      var m = uuid.match(/^Item\.([^.]+)$/);
      if (m) ids.add(m[1]);
    });
  } catch (e) { /* ignore DOM errors */ }

  return Array.from(ids);
}
