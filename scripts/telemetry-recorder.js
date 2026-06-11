// TableCodex Sync — telemetry-recorder.js
// Rich session telemetry for Foundry V14.
// Produces structured TableCodexTelemetryEvent objects for gameplay replay.
//
// Design:
//   - All hook handlers are exported functions; main.js registers them.
//   - preUpdate hooks always run (needed for before-snapshot) regardless of
//     session state; actual event emission only happens when _active === true.
//   - No template literals with raw Unicode — plain string concatenation only.

import { MODULE_ID, getSetting } from "./settings.js";
import { log, debug } from "./logger.js";

console.log("[TableCodex Sync] telemetry-recorder.js evaluated");

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

var _sessionId  = null;
var _active     = false;
var _events     = [];
var _sequence   = 0;

// Pre-update snapshots: actorId/tokenDocId -> snapshot before change
var _actorPre = new Map();
var _tokenPre = new Map();

// Per-user target tracking: userId -> Map<tokenId, targetSnapshot>
var _userTargets = new Map();

// Rolling recent-action buffer for HP-delta correlation (last N actions)
var _recentActions = [];
var RECENT_MAX = 20;

// Debug counts — reset on startSession, read by exporter for pre-flight log
var _debugCounts = {
  spellActionCount:    0,
  weaponActionCount:   0,
  featureActionCount:  0,
  damageCardCount:     0,
  hpChangeCount:       0,
  initiativeRollCount: 0,
  sanitizedSpeakerCount: 0,
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export var telemetryRecorder = {
  get isActive()    { return _active; },
  get eventCount()  { return _events.length; },

  startSession: function(sessionId) {
    _sessionId = sessionId;
    _events    = [];
    _sequence  = 0;
    _active    = true;
    _actorPre.clear();
    _tokenPre.clear();
    _userTargets.clear();
    _recentActions.length = 0;
    _debugCounts = {
      spellActionCount:    0,
      weaponActionCount:   0,
      featureActionCount:  0,
      damageCardCount:     0,
      hpChangeCount:       0,
      initiativeRollCount: 0,
      sanitizedSpeakerCount: 0,
    };
    _emit("session_started", "session", game.user && game.user.id);
    log("Telemetry recorder started. sessionId: " + sessionId);
  },

  endSession: function() {
    _emit("session_ended", "session", game.user && game.user.id);
    _active = false;
    log("Telemetry recorder stopped. Events: " + _events.length);
  },

  getEvents:      function() { return _events.slice(); },
  getEventCount:  function() { return _events.length; },
  clearEvents:    function() { _events = []; _sequence = 0; },
  getDebugCounts: function() { return Object.assign({}, _debugCounts); },
};

// ---------------------------------------------------------------------------
// Capture-category guard
// ---------------------------------------------------------------------------

function _shouldCapture(category) {
  switch (category) {
    case "chat":      return getSetting("captureChat") !== false;
    case "combat":    return getSetting("captureCombat") !== false;
    case "actor":     return getSetting("captureActorUpdates") !== false;
    case "inventory": return getSetting("captureActorUpdates") !== false;
    case "token":     return getSetting("captureTokenMovement") !== false;
    case "condition": return getSetting("captureConditions") !== false;
    case "journal":   return getSetting("captureJournals") !== false;
    case "audio":     return getSetting("capturePlaylists") === true;
    case "scene":     return true;
    case "target":    return true;
    default:          return true;
  }
}

// ---------------------------------------------------------------------------
// Hook handlers — registered by main.js
// ---------------------------------------------------------------------------

// ── Chat ────────────────────────────────────────────────────────────────────

export function onCreateChatMessage(message, _opts, userId) {
  if (!_active || !_shouldCapture("chat")) return;

  var html = message.content || "";
  var text = _plainText(html).trim();
  if (!text && !(message.rolls && message.rolls.length)) return;

  var ev = _makeEvent("chat_message", "chat", userId);
  ev.message = _serializeMessage(message);
  ev.targets = _getUserTargets(userId);
  ev.actor   = _actorFromSpeaker(message.speaker);
  ev.action  = _extractAction(message);

  // MIDI-QOL damage card — extract structured damage rows
  var midiDamage = _parseMidiQolDamage(html);
  if (midiDamage) {
    ev.action = ev.action || {};
    ev.action.type = "damage";
    ev.action.name = "HP Updated";
    ev.damage = midiDamage;
    _debugCounts.damageCardCount += 1;
  }

  // Track action type counts for the pre-flight summary
  if (ev.action) {
    var at = ev.action.type || "unknown";
    if (at === "spell")   _debugCounts.spellActionCount   += 1;
    if (at === "weapon")  _debugCounts.weaponActionCount  += 1;
    if (at === "feat")    _debugCounts.featureActionCount += 1;
    if (at === "damage")  _debugCounts.damageCardCount    += 1;
  }

  // Rolls embedded in this chat message
  var rolls = message.rolls || [];
  if (rolls.length > 0) {
    var rollInfo = _classifyRolls(rolls, message);
    ev.roll = rollInfo;

    if (rollInfo.type === "initiative_roll") {
      _debugCounts.initiativeRollCount += 1;
      ev.message.category = "initiative";
    }

    // Emit a dedicated roll event for easier querying
    var rollEv = _makeEvent(rollInfo.type, "roll", userId);
    rollEv.roll    = rollInfo;
    rollEv.actor   = ev.actor;
    rollEv.action  = ev.action;
    rollEv.targets = ev.targets;
    rollEv.message = { id: message.id };

    if (rollInfo.type === "attack_roll" || rollInfo.type === "damage_roll") {
      _addRecentAction({
        eventId:  rollEv.eventId,
        rollType: rollInfo.type,
        actorId:  ev.actor ? ev.actor.id : null,
        targets:  ev.targets.map(function(t) { return t.actorId; }).filter(Boolean),
        ts:       rollEv.timestamp,
      });
    }

    _pushEvent(rollEv);
  }

  _pushEvent(ev);
}

// ── Actors ──────────────────────────────────────────────────────────────────

export function onPreUpdateActor(actor) {
  // Always capture before-state regardless of session active flag
  _actorPre.set(actor.id, _actorStats(actor));
}

export function onUpdateActor(actor, changes, _opts, userId) {
  if (!_active || !_shouldCapture("actor")) return;

  var before = _actorPre.get(actor.id) || null;
  _actorPre.delete(actor.id);

  // Only emit if HP/tempHP actually changed or if there are system changes
  var hpPath = (changes.system && changes.system.attributes && changes.system.attributes.hp) ? changes.system.attributes.hp : null;
  if (!hpPath && !changes.system) return;

  var after    = _actorStats(actor);
  var hpBefore = before ? before.hp   : null;
  var hpAfter  = after.hp;
  var hpDelta  = (hpBefore !== null && hpAfter !== null) ? (hpAfter - hpBefore) : null;
  var tBefore  = before ? before.tempHp : null;
  var tAfter   = after.tempHp;
  var tDelta   = (tBefore !== null && tAfter !== null) ? (tAfter - tBefore) : null;

  var eventType = "actor_updated";
  if (hpDelta !== null && hpDelta < 0)  eventType = "damage_applied";
  else if (hpDelta !== null && hpDelta > 0) eventType = "healing_applied";
  else if (tDelta !== null && tDelta !== 0) eventType = "temp_hp_changed";

  var ev = _makeEvent(eventType, "actor", userId);
  ev.actor = _actorSnap(actor);
  ev.changes = {
    hpBefore:    hpBefore,
    hpAfter:     hpAfter,
    hpDelta:     hpDelta,
    tempHpBefore: tBefore,
    tempHpAfter:  tAfter,
    tempHpDelta:  tDelta,
    updatedFields: Object.keys(changes),
  };
  ev.correlatedAction = _findRecentAction(actor.id);
  if (hpDelta !== null && hpDelta !== 0) _debugCounts.hpChangeCount += 1;
  _pushEvent(ev);
}

// ── Tokens ──────────────────────────────────────────────────────────────────

export function onPreUpdateToken(tokenDoc) {
  _tokenPre.set(tokenDoc.id, { x: tokenDoc.x, y: tokenDoc.y, elevation: tokenDoc.elevation || 0 });
}

export function onUpdateToken(tokenDoc, changes, _opts, userId) {
  if (!_active || !_shouldCapture("token")) return;
  if (changes.x === undefined && changes.y === undefined && changes.elevation === undefined) return;

  var before = _tokenPre.get(tokenDoc.id) || null;
  _tokenPre.delete(tokenDoc.id);

  var ev = _makeEvent("token_moved", "token", userId);
  ev.token = _tokenSnap(tokenDoc);
  ev.changes = {
    positionBefore: before,
    positionAfter: { x: tokenDoc.x, y: tokenDoc.y, elevation: tokenDoc.elevation || 0 },
  };
  _pushEvent(ev);
}

// ── Targets ─────────────────────────────────────────────────────────────────

export function onTargetToken(user, token, targeted) {
  // Always update the target map
  if (!_userTargets.has(user.id)) _userTargets.set(user.id, new Map());
  var map = _userTargets.get(user.id);
  var doc = token.document || token;

  if (targeted) {
    map.set(token.id || doc.id, _targetSnap(doc));
  } else {
    map.delete(token.id || doc.id);
  }

  if (!_active || !_shouldCapture("target")) return;
  var ev = _makeEvent(targeted ? "target_selected" : "target_cleared", "target", user.id);
  ev.token = _tokenSnap(doc);
  _pushEvent(ev);
}

// ── Combat ──────────────────────────────────────────────────────────────────

export function onCreateCombat(combat, _opts, userId) {
  if (!_active || !_shouldCapture("combat")) return;
  var ev = _makeEvent("combat_started", "combat", userId);
  ev.combat = _combatSnap(combat);
  _pushEvent(ev);
}

export function onUpdateCombat(combat, changes, _opts, userId) {
  if (!_active || !_shouldCapture("combat")) return;
  if (changes.round !== undefined) {
    var ev = _makeEvent("combat_round_changed", "combat", userId);
    ev.combat = _combatSnap(combat);
    ev.changes = { round: changes.round, turn: changes.turn !== undefined ? changes.turn : combat.turn };
    _pushEvent(ev);
  } else if (changes.turn !== undefined) {
    var ev2 = _makeEvent("combat_turn_changed", "combat", userId);
    ev2.combat = _combatSnap(combat);
    ev2.changes = { round: combat.round, turn: changes.turn };
    _pushEvent(ev2);
  }
}

export function onDeleteCombat(combat, _opts, userId) {
  if (!_active || !_shouldCapture("combat")) return;
  var ev = _makeEvent("combat_ended", "combat", userId);
  ev.combat = _combatSnap(combat);
  _pushEvent(ev);
}

export function onUpdateCombatant(combatant, changes, _opts, userId) {
  if (!_active || !_shouldCapture("combat")) return;
  if (changes.initiative !== undefined) {
    var ev = _makeEvent("initiative_set", "combat", userId);
    ev.combat = _combatSnapFromCombatant(combatant);
    ev.actor  = { id: combatant.actorId, name: combatant.name };
    ev.changes = { initiative: changes.initiative };
    _pushEvent(ev);
  }
  if (changes.defeated !== undefined) {
    var ev2 = _makeEvent(changes.defeated ? "combatant_defeated" : "combatant_revived", "combat", userId);
    ev2.combat = _combatSnapFromCombatant(combatant);
    ev2.actor  = { id: combatant.actorId, name: combatant.name };
    _pushEvent(ev2);
  }
}

// ── Active Effects / Conditions ──────────────────────────────────────────────

export function onCreateActiveEffect(effect, _opts, userId) {
  if (!_active || !_shouldCapture("condition")) return;
  var ev = _makeEvent("condition_added", "condition", userId);
  ev.actor   = _actorFromEffect(effect);
  ev.changes = { addedEffects: [_effectSnap(effect)] };
  _pushEvent(ev);
}

export function onUpdateActiveEffect(effect, changes, _opts, userId) {
  if (!_active || !_shouldCapture("condition")) return;
  var ev = _makeEvent("condition_updated", "condition", userId);
  ev.actor   = _actorFromEffect(effect);
  ev.changes = { updatedFields: Object.keys(changes) };
  _pushEvent(ev);
}

export function onDeleteActiveEffect(effect, _opts, userId) {
  if (!_active || !_shouldCapture("condition")) return;
  var ev = _makeEvent("condition_removed", "condition", userId);
  ev.actor   = _actorFromEffect(effect);
  ev.changes = { removedEffects: [_effectSnap(effect)] };
  _pushEvent(ev);
}

// ── Items / Inventory ────────────────────────────────────────────────────────

export function onCreateItem(item, _opts, userId) {
  if (!_active || !_shouldCapture("inventory")) return;
  var ev = _makeEvent("item_created", "inventory", userId);
  ev.action = _itemActionSnap(item);
  ev.actor  = item.actor ? { id: item.actor.id, name: item.actor.name } : null;
  _pushEvent(ev);
}

export function onUpdateItem(item, changes, _opts, userId) {
  if (!_active || !_shouldCapture("inventory")) return;
  var ev = _makeEvent("item_updated", "inventory", userId);
  ev.action  = _itemActionSnap(item);
  ev.actor   = item.actor ? { id: item.actor.id, name: item.actor.name } : null;
  ev.changes = { updatedFields: Object.keys(changes) };
  _pushEvent(ev);
}

export function onDeleteItem(item, _opts, userId) {
  if (!_active || !_shouldCapture("inventory")) return;
  var ev = _makeEvent("item_deleted", "inventory", userId);
  ev.action = _itemActionSnap(item);
  ev.actor  = item.actor ? { id: item.actor.id, name: item.actor.name } : null;
  _pushEvent(ev);
}

// ── Scene ────────────────────────────────────────────────────────────────────

export function onCanvasReadyTelemetry(canvas) {
  if (!_active || !_shouldCapture("scene")) return;
  var scene = canvas && canvas.scene;
  if (!scene) return;
  var ev = _makeEvent("scene_viewed", "scene", game.user && game.user.id);
  ev.scene = { id: scene.id, name: scene.name, active: scene.active };
  _pushEvent(ev);
}

export function onUpdateScene(scene, changes, _opts, userId) {
  if (!_active || !_shouldCapture("scene")) return;
  var ev = _makeEvent("scene_updated", "scene", userId);
  ev.scene   = { id: scene.id, name: scene.name, active: scene.active };
  ev.changes = { updatedFields: Object.keys(changes) };
  _pushEvent(ev);
}

// ── Templates ────────────────────────────────────────────────────────────────

export function onCreateMeasuredTemplate(template, _opts, userId) {
  if (!_active) return;
  var ev = _makeEvent("template_placed", "action", userId);
  ev.action = {
    type:   "template",
    name:   null,
    target: { shape: template.t, x: template.x, y: template.y, size: template.distance, angle: template.angle },
  };
  _pushEvent(ev);
}

// ── Journals ─────────────────────────────────────────────────────────────────

export function onCreateJournalEntryTelemetry(journal, _opts, userId) {
  if (!_active || !_shouldCapture("journal")) return;
  var ev = _makeEvent("journal_created", "journal", userId);
  ev.message = { id: journal.id, contentText: journal.name };
  _pushEvent(ev);
}

export function onUpdateJournalEntryTelemetry(journal, changes, _opts, userId) {
  if (!_active || !_shouldCapture("journal")) return;
  var ev = _makeEvent("journal_updated", "journal", userId);
  ev.message = { id: journal.id, contentText: journal.name };
  ev.changes = { updatedFields: Object.keys(changes) };
  _pushEvent(ev);
}

// ── Audio ────────────────────────────────────────────────────────────────────

export function onCreatePlaylistSound(sound, _opts, userId) {
  if (!_active || !_shouldCapture("audio")) return;
  var ev = _makeEvent("audio_cue", "audio", userId);
  ev.message = { id: sound.id, contentText: sound.name || "Audio cue" };
  _pushEvent(ev);
}

export function onUpdatePlaylistSound(sound, changes, _opts, userId) {
  if (!_active || !_shouldCapture("audio")) return;
  if (changes.playing === undefined) return;
  var ev = _makeEvent(changes.playing ? "audio_started" : "audio_stopped", "audio", userId);
  ev.message = { id: sound.id, contentText: sound.name || "Audio cue" };
  _pushEvent(ev);
}

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

function _makeEvent(eventType, eventCategory, userId) {
  _sequence += 1;
  var user   = _userSnap(userId);
  var scene  = _sceneContext();
  var combat = _combatContext();

  var ev = {
    eventId:        _genId(),
    sessionId:      _sessionId || "",
    worldId:        (game.world && game.world.id)      || "",
    worldTitle:     (game.world && game.world.title)   || "",
    foundryVersion: game.version                       || "",
    systemId:       (game.system && game.system.id)    || "",
    systemVersion:  (game.system && game.system.version) || "",
    moduleVersion:  (game.modules && game.modules.get(MODULE_ID) && game.modules.get(MODULE_ID).version) || "",
    timestamp:      new Date().toISOString(),
    sequence:       _sequence,
    eventType:      eventType,
    eventCategory:  eventCategory,
    user:           user,
    scene:          scene,
    combat:         combat,
    actor:          null,
    token:          null,
    action:         null,
    roll:           null,
    targets:        [],
    changes:        null,
    message:        null,
  };

  if (getSetting("includeRawPayloads")) {
    ev.raw = {};
  }

  return ev;
}

function _pushEvent(ev) {
  var max = getSetting("telemetryQueueMaxSize") || 2000;
  if (_events.length >= max) {
    _events.shift(); // drop oldest when full
  }
  _events.push(ev);
}

function _emit(eventType, eventCategory, userId) {
  if (!_active) return;
  _pushEvent(_makeEvent(eventType, eventCategory, userId));
}

// ---------------------------------------------------------------------------
// Context helpers
// ---------------------------------------------------------------------------

function _userSnap(userId) {
  var u = userId ? (game.users && game.users.get(userId)) : (game.user);
  if (!u) return { id: userId || null, name: null, role: null, isGM: false };
  return {
    id:   u.id,
    name: u.name,
    role: u.role,
    isGM: u.isGM || false,
  };
}

function _sceneContext() {
  var scene = game.canvas && game.canvas.scene;
  if (!scene) return null;
  return { id: scene.id, name: scene.name, active: scene.active, viewed: true };
}

function _combatContext() {
  var combat = game.combats && game.combats.active;
  if (!combat) return null;
  var active = combat.combatant;
  return {
    id:                combat.id,
    round:             combat.round,
    turn:              combat.turn,
    activeCombatantId: active ? active.id : null,
    activeActorId:     active ? active.actorId : null,
    activeActorName:   active ? active.name : null,
  };
}

// ---------------------------------------------------------------------------
// Actor / Token snapshot helpers
// ---------------------------------------------------------------------------

function _actorStats(actor) {
  var sys    = actor.system || {};
  var attrs  = sys.attributes || {};
  var hp     = attrs.hp || {};

  var conditions = [];
  try {
    if (actor.statuses) {
      conditions = Array.from(actor.statuses);
    } else {
      conditions = (actor.effects ? Array.from(actor.effects) : [])
        .filter(function(e) { return !e.disabled; })
        .map(function(e) { return e.name || e.label || ""; })
        .filter(Boolean);
    }
  } catch (err) { /* ignore */ }

  return {
    hp:         hp.value !== undefined ? hp.value : null,
    hpMax:      hp.max   !== undefined ? hp.max   : null,
    tempHp:     hp.temp  !== undefined ? hp.temp  : null,
    conditions: conditions,
  };
}

function _actorSnap(actor) {
  var stats  = _actorStats(actor);
  var sys    = actor.system || {};
  var attrs  = sys.attributes || {};
  var ac     = attrs.ac || {};

  return {
    id:         actor.id,
    uuid:       actor.uuid,
    name:       actor.name,
    type:       actor.type,
    hp:         stats.hp,
    hpMax:      stats.hpMax,
    tempHp:     stats.tempHp,
    ac:         ac.value !== undefined ? ac.value : null,
    conditions: stats.conditions,
  };
}

function _tokenSnap(tokenDoc) {
  if (!tokenDoc) return null;
  return {
    id:          tokenDoc.id,
    uuid:        tokenDoc.uuid,
    name:        tokenDoc.name,
    actorId:     tokenDoc.actorId,
    sceneId:     tokenDoc.parent ? tokenDoc.parent.id : null,
    x:           tokenDoc.x,
    y:           tokenDoc.y,
    elevation:   tokenDoc.elevation || 0,
    hidden:      tokenDoc.hidden || false,
    disposition: tokenDoc.disposition !== undefined ? tokenDoc.disposition : null,
  };
}

function _targetSnap(tokenDoc) {
  var actor = tokenDoc.actor;
  var stats = actor ? _actorStats(actor) : null;
  return {
    tokenId:    tokenDoc.id,
    actorId:    tokenDoc.actorId,
    name:       tokenDoc.name,
    hp:         stats ? stats.hp    : null,
    hpMax:      stats ? stats.hpMax : null,
    tempHp:     stats ? stats.tempHp : null,
    ac:         actor ? ((actor.system && actor.system.attributes && actor.system.attributes.ac && actor.system.attributes.ac.value) || null) : null,
    x:          tokenDoc.x,
    y:          tokenDoc.y,
    disposition: tokenDoc.disposition !== undefined ? tokenDoc.disposition : null,
  };
}

function _getUserTargets(userId) {
  var map = _userTargets.get(userId);
  if (!map || map.size === 0) return [];
  return Array.from(map.values());
}

function _actorFromSpeaker(speaker) {
  if (!speaker) return null;
  var actorId = speaker.actor;
  if (!actorId) return null;
  var actor = game.actors && game.actors.get(actorId);
  if (!actor) return { id: actorId, name: speaker.alias || null };
  return _actorSnap(actor);
}

// ---------------------------------------------------------------------------
// Combat snapshot helpers
// ---------------------------------------------------------------------------

function _combatSnap(combat) {
  var active = combat.combatant;
  return {
    id:                combat.id,
    round:             combat.round,
    turn:              combat.turn,
    activeCombatantId: active ? active.id : null,
    activeActorId:     active ? active.actorId : null,
    activeActorName:   active ? active.name : null,
    combatants: (Array.from(combat.combatants || [])).map(function(c) {
      return {
        id:         c.id,
        name:       c.name,
        actorId:    c.actorId,
        tokenId:    c.tokenId,
        initiative: c.initiative,
        defeated:   c.defeated || false,
        hidden:     c.hidden   || false,
      };
    }),
  };
}

function _combatSnapFromCombatant(combatant) {
  var combat = combatant.parent;
  if (!combat) return { id: null, round: null, turn: null, activeCombatantId: null, activeActorId: null, activeActorName: null, combatants: [] };
  return _combatSnap(combat);
}

// ---------------------------------------------------------------------------
// Active effect helpers
// ---------------------------------------------------------------------------

function _effectSnap(effect) {
  return {
    id:       effect.id,
    name:     effect.name || effect.label || "",
    icon:     effect.icon,
    disabled: effect.disabled || false,
    origin:   effect.origin   || null,
  };
}

function _actorFromEffect(effect) {
  var parent = effect.parent;
  if (!parent) return null;
  if (parent.documentName === "Actor") return _actorSnap(parent);
  if (parent.documentName === "Item" && parent.actor) return _actorSnap(parent.actor);
  return null;
}

// ---------------------------------------------------------------------------
// Item action snapshot
// ---------------------------------------------------------------------------

function _itemActionSnap(item) {
  var sys = item.system || {};
  var dmg = sys.damage  || {};

  return {
    type:       item.type,
    name:       item.name,
    itemId:     item.id,
    itemUuid:   item.uuid,
    itemType:   item.type,
    actorId:    item.actor ? item.actor.id : null,
    actionType: sys.actionType || null,
    activation: sys.activation ? sys.activation.type : null,
    spellLevel: sys.level  || null,
    damageParts: (dmg.parts && dmg.parts.length > 0) ? dmg.parts.map(function(p) {
      return Array.isArray(p) ? { formula: p[0], type: p[1] } : p;
    }) : null,
  };
}

// ---------------------------------------------------------------------------
// Chat message serialization
// ---------------------------------------------------------------------------

function _serializeMessage(message) {
  var spk  = message.speaker || {};
  var user = game.users && game.users.get(message.user || message.author);
  var html = message.content || "";

  // Sanitized speaker — only primitive string/number fields, never the User document
  var speaker = {
    userId:    (typeof (message.user || message.author) === "string") ? (message.user || message.author) : null,
    userName:  user ? user.name : null,
    actorId:   spk.actor  || null,
    actorName: spk.alias  || null,
    tokenId:   spk.token  || null,
    sceneId:   spk.scene  || null,
    sceneName: spk.scene  ? ((game.scenes && game.scenes.get(spk.scene) && game.scenes.get(spk.scene).name) || null) : null,
  };

  var title    = _extractHtmlTitle(html);
  var subtitle = _extractHtmlSubtitle(html);

  return {
    id:          message.id,
    speaker:     speaker,
    contentText: _plainText(html),
    contentHtml: getSetting("includeRawHtml") !== false ? html : undefined,
    flavor:      message.flavor  || "",
    title:       title,
    subtitle:    subtitle,
    category:    _chatCategory(message, (message.whisper || []).length > 0),
    isWhisper:   (message.whisper || []).length > 0,
    isBlind:     message.blind || false,
    whisper:     message.whisper || [],
    rolls:       [],
  };
}

// ---------------------------------------------------------------------------
// Roll classification
// ---------------------------------------------------------------------------

function _classifyRolls(rolls, message) {
  var roll    = rolls[0];
  var flags   = (message.flags && message.flags.dnd5e) ? message.flags.dnd5e : {};
  var rollMeta = flags.roll || {};
  var rollType = rollMeta.type || "";
  var flavor   = (message.flavor || "").toLowerCase();

  var type = "roll";
  if      (rollType === "attack")                                        type = "attack_roll";
  else if (rollType === "damage")                                        type = "damage_roll";
  else if (rollType === "heal" || rollType === "healing")                type = "healing_roll";
  else if (rollType === "save" || rollType === "saving-throw")           type = "saving_throw";
  else if (rollType === "check")                                         type = "ability_check";
  else if (rollType === "skill")                                         type = "skill_check";
  else if (rollType === "tool")                                          type = "tool_check";
  else if (flavor.indexOf("attack") !== -1)                             type = "attack_roll";
  else if (flavor.indexOf("damage") !== -1)                             type = "damage_roll";
  else if (flavor.indexOf("heal") !== -1)                               type = "healing_roll";
  else if (flavor.indexOf("saving throw") !== -1 || flavor.indexOf("save") !== -1) type = "saving_throw";
  else if (flavor.indexOf("ability check") !== -1 || flavor.indexOf(" check") !== -1) type = "ability_check";
  else if (flavor.indexOf("skill") !== -1)                              type = "skill_check";
  else if (flavor.indexOf("initiative") !== -1)                         type = "initiative_roll";

  var terms = (roll.terms || []).map(function(t) {
    return {
      type:    (t.constructor && t.constructor.name) ? t.constructor.name : "Term",
      formula: t.formula || "",
      results: (t.results || []).map(function(r) {
        return r.result !== undefined ? r.result : r;
      }),
    };
  });

  return {
    id:         _genId(),
    type:       type,
    formula:    roll.formula || "",
    total:      roll.total !== undefined ? roll.total : null,
    terms:      terms,
    flavor:     message.flavor || "",
    isCritical: roll.isCritical || false,
    isFumble:   roll.isFumble   || false,
    dc:         rollMeta.dc || null,
    result:     _rollResult(roll, type),
  };
}

function _rollResult(roll, type) {
  if (type === "attack_roll") {
    if (roll.isCritical) return "critical";
    if (roll.isFumble)   return "fumble";
  }
  if (roll.total !== undefined && roll.total !== null) {
    return String(roll.total);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Action extraction (dnd5e flags + HTML fallback + item document resolution)
// ---------------------------------------------------------------------------

function _extractAction(message) {
  if (!message) return null;
  var flags    = message.flags || {};
  var dnd5e    = flags.dnd5e   || {};
  var itemMeta = dnd5e.item    || {};
  var html     = message.content || "";

  // -- Start with flag data (most reliable) --
  var itemId   = itemMeta.id   || null;
  var itemUuid = itemMeta.uuid || null;
  var itemName = itemMeta.name || null;
  var itemType = itemMeta.type || null;

  // -- Try embedded item document (dnd5e 3.x) --
  var spellLevel  = null;
  var school      = null;
  var activation  = null;
  var range       = null;
  var dc          = null;
  var damageParts = null;

  try {
    var embed = message.item;
    if (embed) {
      itemName = itemName || embed.name || null;
      itemType = itemType || embed.type || null;

      var sys  = embed.system || {};
      var dmg  = sys.damage   || {};

      spellLevel = sys.level || sys.preparation?.level || null;
      school     = (sys.school) ? sys.school : null;
      activation = sys.activation ? sys.activation.type : null;
      range      = sys.range ? (sys.range.value ? (sys.range.value + (sys.range.units ? " " + sys.range.units : "")) : sys.range.units || null) : null;

      // Save DC
      dc = (sys.save && sys.save.dc) ? sys.save.dc
         : (dnd5e.roll && dnd5e.roll.dc) ? dnd5e.roll.dc
         : null;

      // Damage parts (dnd5e 2.x array, 3.x may differ)
      if (dmg.parts && dmg.parts.length > 0) {
        damageParts = dmg.parts.map(function(p) {
          return Array.isArray(p) ? { formula: p[0], type: p[1] } : p;
        });
      }
    }
  } catch (err) { /* system-specific — ignore */ }

  // -- HTML fallback: extract title and subtitle when flags are absent --
  var htmlTitle    = _extractHtmlTitle(html);
  var htmlSubtitle = _extractHtmlSubtitle(html);
  itemName = itemName || htmlTitle || null;

  // -- Parse subtitle for spell level + school --
  if (htmlSubtitle) {
    var parsed = _parseSubtitle(htmlSubtitle);
    if (spellLevel === null) spellLevel = parsed.spellLevel;
    if (school     === null) school     = parsed.school;
  }

  // -- Classify action type --
  var actionType = _classifyActionType(itemType, itemName, htmlSubtitle, html);

  // -- Try to resolve item document for extra metadata --
  if (itemId || itemUuid) {
    var resolved = _resolveItemMeta(itemId, itemUuid, message.speaker);
    if (resolved) {
      itemName    = itemName    || resolved.name;
      itemType    = itemType    || resolved.type;
      spellLevel  = spellLevel  !== null ? spellLevel  : resolved.spellLevel;
      school      = school      !== null ? school      : resolved.school;
      activation  = activation  !== null ? activation  : resolved.activation;
      range       = range       !== null ? range       : resolved.range;
      dc          = dc          !== null ? dc          : resolved.dc;
      damageParts = damageParts !== null ? damageParts : resolved.damageParts;
    }
  }

  if (!itemName && !itemId && actionType === "unknown") return null;

  return {
    type:        actionType,
    name:        itemName,
    itemId:      itemId,
    itemUuid:    itemUuid,
    itemType:    itemType,
    spellLevel:  spellLevel,
    school:      school,
    activation:  activation,
    range:       range,
    dc:          dc,
    damageParts: damageParts,
  };
}

// Classify an action into spell / weapon / feat / damage / unknown
function _classifyActionType(itemType, name, subtitle, html) {
  var t = (subtitle || "").toLowerCase();
  var h = (html || "").toLowerCase();
  var n = (name || "").toLowerCase();

  if (itemType === "spell") return "spell";
  if (itemType === "weapon" || itemType === "equipment") return "weapon";
  if (itemType === "feat" || itemType === "feature") return "feat";

  // Subtitle: spell school or level keyword
  var schools = ["evocation", "conjuration", "transmutation", "abjuration", "divination", "enchantment", "illusion", "necromancy"];
  var hasSchool = schools.some(function(s) { return t.indexOf(s) !== -1; });
  if (hasSchool) return "spell";
  if (t.indexOf("level") !== -1) return "spell";
  if (t.indexOf("cantrip") !== -1) return "spell";

  // Subtitle: weapon keywords
  if (t.indexOf("natural") !== -1 || t.indexOf("melee") !== -1 || t.indexOf("ranged") !== -1 || t.indexOf("martial") !== -1 || t.indexOf("simple") !== -1) return "weapon";

  // Subtitle: feature
  if (t.indexOf("feature") !== -1 || t.indexOf("trait") !== -1) return "feat";

  // HTML: MIDI-QOL damage card or HP Updated text
  if (h.indexOf("midi-qol-damage-card") !== -1 || h.indexOf("midi-qol-dmg-row") !== -1 || n.indexOf("hp updated") !== -1) return "damage";

  return "unknown";
}

// Parse subtitle text for spell level and school
function _parseSubtitle(subtitle) {
  var result = { spellLevel: null, school: null };
  if (!subtitle) return result;

  var levelMatch = subtitle.match(/(\d+)(?:st|nd|rd|th)\s+[Ll]evel/);
  if (levelMatch) result.spellLevel = parseInt(levelMatch[1], 10);
  if (/cantrip/i.test(subtitle)) result.spellLevel = 0;

  var schools = ["Evocation", "Conjuration", "Transmutation", "Abjuration", "Divination", "Enchantment", "Illusion", "Necromancy"];
  for (var i = 0; i < schools.length; i++) {
    if (subtitle.toLowerCase().indexOf(schools[i].toLowerCase()) !== -1) {
      result.school = schools[i];
      break;
    }
  }
  return result;
}

// Resolve a live item document from the game collection to get extra metadata
function _resolveItemMeta(itemId, itemUuid, speaker) {
  try {
    var item = null;

    // Try by UUID first (most precise)
    if (itemUuid && typeof fromUuidSync === "function") {
      item = fromUuidSync(itemUuid);
    }

    // Fallback: look in the speaking actor's items
    if (!item && itemId && speaker && speaker.actor) {
      var actor = game.actors && game.actors.get(speaker.actor);
      if (actor) item = actor.items && actor.items.get(itemId);
    }

    // Fallback: look in world items
    if (!item && itemId) {
      item = game.items && game.items.get(itemId);
    }

    if (!item) return null;

    var sys   = item.system || {};
    var dmg   = sys.damage  || {};
    var parsed = _parseSubtitle("");

    return {
      name:       item.name,
      type:       item.type,
      spellLevel: sys.level || null,
      school:     sys.school || null,
      activation: sys.activation ? sys.activation.type : null,
      range:      sys.range ? (sys.range.value ? String(sys.range.value) + (sys.range.units ? " " + sys.range.units : "") : sys.range.units || null) : null,
      dc:         (sys.save && sys.save.dc) ? sys.save.dc : null,
      damageParts: (dmg.parts && dmg.parts.length > 0) ? dmg.parts.map(function(p) {
        return Array.isArray(p) ? { formula: p[0], type: p[1] } : p;
      }) : null,
    };
  } catch (err) {
    return null;
  }
}

// Parse MIDI-QOL damage card HTML into structured damage rows
function _parseMidiQolDamage(html) {
  if (!html) return null;
  if (html.indexOf("midi-qol-damage-card") === -1 && html.indexOf("midi-qol-dmg-row") === -1 && html.toLowerCase().indexOf("hp updated") === -1) return null;

  try {
    var div = document.createElement("div");
    div.innerHTML = html;

    var rows = div.querySelectorAll(".midi-qol-dmg-row, .midi-qol-damage-row, [class*='midi-qol-dmg']");
    var result = [];

    rows.forEach(function(row) {
      var imgEl = row.querySelector("img[alt], img[data-actor-uuid], img[data-actor-id], [data-actor-uuid], [data-actor-id]");
      var targetName    = null;
      var targetActorId = null;

      if (imgEl) {
        targetName = imgEl.getAttribute("alt") || imgEl.getAttribute("data-tooltip") || null;
        var uuid = imgEl.getAttribute("data-actor-uuid") || "";
        var m = uuid.match(/Actor\.([^.]+)$/);
        if (m) targetActorId = m[1];
        if (!targetActorId) targetActorId = imgEl.getAttribute("data-actor-id") || null;
      }

      // Try data attributes for HP values
      var hpEl     = row.querySelector("[data-hp-before], [data-old-hp], [data-hp]");
      var hpBefore = null;
      var hpAfter  = null;
      if (hpEl) {
        hpBefore = parseFloat(hpEl.getAttribute("data-hp-before") || hpEl.getAttribute("data-old-hp") || "");
        hpAfter  = parseFloat(hpEl.getAttribute("data-hp-after")  || hpEl.getAttribute("data-new-hp") || "");
      }

      var amountEl = row.querySelector(".midi-qol-dmg-value, .damage-value, [class*='damage']");
      var amount   = amountEl ? parseFloat(amountEl.textContent.trim()) : null;

      if (targetName || targetActorId || amount !== null) {
        result.push({
          targetName:    targetName,
          targetActorId: targetActorId,
          hpBefore:      isNaN(hpBefore) ? null : hpBefore,
          hpAfter:       isNaN(hpAfter)  ? null : hpAfter,
          hpDelta:       (!isNaN(hpBefore) && !isNaN(hpAfter)) ? (hpAfter - hpBefore) : null,
          tempHpBefore:  null,
          tempHpAfter:   null,
          tempHpDelta:   null,
          amount:        isNaN(amount) ? null : amount,
          damageType:    null,
        });
      }
    });

    return result.length > 0 ? result : null;
  } catch (err) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Recent action buffer (for HP-delta correlation)
// ---------------------------------------------------------------------------

function _addRecentAction(action) {
  _recentActions.push(action);
  if (_recentActions.length > RECENT_MAX) _recentActions.shift();
}

function _findRecentAction(actorId) {
  // Walk backwards, find the most recent damage roll that targeted this actor
  for (var i = _recentActions.length - 1; i >= 0; i--) {
    var a = _recentActions[i];
    if (a.rollType === "damage_roll") {
      if (a.actorId === actorId) return a;
      if (a.targets && a.targets.indexOf(actorId) !== -1) return a;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

var _idCounter = 0;
function _genId() {
  _idCounter += 1;
  return "te-" + Date.now() + "-" + _idCounter;
}

function _plainText(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
  } catch (e) {
    return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
}

// Extract the primary heading/title from a chat card HTML string
function _extractHtmlTitle(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    // dnd5e card hierarchy: .item-name, .action, h3, h4
    var el = div.querySelector(".item-name, .action, .card-header h3, h3, h4, .title");
    return el ? el.textContent.trim() : "";
  } catch (e) {
    return "";
  }
}

// Extract the subtitle (spell level, weapon type, feature, etc.)
function _extractHtmlSubtitle(html) {
  if (!html) return "";
  try {
    var div = document.createElement("div");
    div.innerHTML = html;
    // dnd5e 2.x card has <span class="subtitle"> inside .card-header
    var el = div.querySelector(".subtitle, .card-subtitle, .item-type, [class*='subtitle']");
    return el ? el.textContent.trim() : "";
  } catch (e) {
    return "";
  }
}

// Classify the chat category (roll / emote / ooc / whisper / initiative / ic)
function _chatCategory(message, isWhisper) {
  if (isWhisper) return "whisper";
  var typeConst = (CONST && CONST.CHAT_MESSAGE_TYPES) ? CONST.CHAT_MESSAGE_TYPES : {};
  var t = message.type;
  if (t === typeConst.ROLL   || t === "roll")  return "roll";
  if (t === typeConst.EMOTE  || t === "emote") return "emote";
  if (t === typeConst.OOC    || t === "ooc")   return "ooc";
  // Check flavor for initiative
  if (message.flavor && message.flavor.toLowerCase().indexOf("initiative") !== -1) return "initiative";
  return "ic";
}
