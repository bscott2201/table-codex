import { MODULE_ID, getSetting, setSetting, getPrivacySettings } from "./settings.js";
import { log, debug } from "./logger.js";
import { getWorldInfo } from "./world-info.js";
import { saveUnsyncedSession } from "./session-store.js";
import { telemetryRecorder } from "./telemetry-recorder.js";

console.log("[TableCodex Sync] session-recorder.js evaluated");

// ---------------------------------------------------------------------------
// In-memory session state — also persisted to world settings for reload recovery.
// ---------------------------------------------------------------------------

let _session      = null;
let _events       = [];
let _chatMessages = [];
let _rolls        = [];
let _combats      = [];
let _actors       = [];
let _items        = [];
let _scenes       = [];
let _journals     = [];

// Sets of IDs encountered during the session — used to build focused exports
// in minimal/standard capture modes instead of full world snapshots.
let _referencedActorIds = new Set();
let _referencedItemIds  = new Set();
let _referencedSceneIds = new Set();

// ---------------------------------------------------------------------------
// Public recorder
// ---------------------------------------------------------------------------

export const sessionRecorder = {
  get isActive()   { return _session !== null && _session.active; },
  get session()    { return _session; },
  get eventCount() { return _events.length; },

  get stats() {
    return {
      eventCount:           _events.length,
      chatMessageCount:     _chatMessages.length,
      rollCount:            _rolls.length,
      combatEventCount:     _combats.length,
      actorSnapshotCount:   _actors.length,
      itemSnapshotCount:    _items.length,
      sceneSnapshotCount:   _scenes.length,
      journalSnapshotCount: _journals.length,
      referencedActorCount: _referencedActorIds.size,
      referencedItemCount:  _referencedItemIds.size,
    };
  },

  // ── Session lifecycle ─────────────────────────────────────────────────────

  async start(options = {}) {
    if (_session?.active) {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Session.AlreadyActive"));
      return false;
    }

    _session = {
      localSessionId: _generateId(),
      startedAt:      new Date().toISOString(),
      endedAt:        null,
      active:         true,
      synced:         false,
      remoteImportId: null,
      remoteIntakeId: null,
      sessionTitle:   options.sessionTitle ?? "",
    };
    _events       = [];
    _chatMessages = [];
    _rolls        = [];
    _combats      = [];
    _actors       = [];
    _items        = [];
    _scenes       = [];
    _journals     = [];
    _referencedActorIds = new Set();
    _referencedItemIds  = new Set();
    _referencedSceneIds = new Set();

    await _persist();
    _captureOpeningSnapshots();

    // Start the rich telemetry recorder in parallel
    telemetryRecorder.startSession(_session.localSessionId);

    log("Session started: " + _session.localSessionId + " (mode: " + (getSetting("captureMode") || "standard") + ")");
    Hooks.callAll(MODULE_ID + ".sessionStarted", _session);
    ui.notifications.info(game.i18n.localize("TABLECODEX.Session.Started"));
    return true;
  },

  async stop() {
    if (!_session?.active) {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Session.NotActive"));
      return false;
    }

    _captureClosingSnapshots();
    _session.active  = false;
    _session.endedAt = new Date().toISOString();

    // Stop the telemetry recorder before persisting
    telemetryRecorder.endSession();

    await _persist();
    log("Session ended: " + _session.localSessionId);

    _persistToStore();

    Hooks.callAll(MODULE_ID + ".sessionStopped", _session);
    ui.notifications.info(game.i18n.localize("TABLECODEX.Session.Ended"));
    return true;
  },

  async resume() {
    const buf = getSetting("localSessionBuffer");
    if (!buf) return false;

    _session      = buf.session;
    _events       = buf.events       ?? [];
    _chatMessages = buf.chatMessages ?? [];
    _rolls        = buf.rolls        ?? [];
    _combats      = buf.combats      ?? [];
    _actors       = buf.actors       ?? [];
    _items        = buf.items        ?? [];
    _scenes       = buf.scenes       ?? [];
    _journals     = buf.journals     ?? [];

    // Restore reference sets from persisted arrays
    _referencedActorIds = new Set(buf.referencedActorIds ?? []);
    _referencedItemIds  = new Set(buf.referencedItemIds  ?? []);
    _referencedSceneIds = new Set(buf.referencedSceneIds ?? []);

    log("Session resumed: " + (_session?.localSessionId ?? "?"));
    return true;
  },

  async clearBuffer() {
    _session      = null;
    _events       = [];
    _chatMessages = [];
    _rolls        = [];
    _combats      = [];
    _actors       = [];
    _items        = [];
    _scenes       = [];
    _journals     = [];
    _referencedActorIds = new Set();
    _referencedItemIds  = new Set();
    _referencedSceneIds = new Set();
    await setSetting("localSessionBuffer", null);
    Hooks.callAll(MODULE_ID + ".bufferCleared");
    ui.notifications.info(game.i18n.localize("TABLECODEX.Session.BufferCleared"));
  },

  // ── Event recording ───────────────────────────────────────────────────────

  recordChat(data) {
    if (!_session?.active) return;
    _chatMessages.push(data);
    _events.push({ type: "chat", ts: data.timestamp, ref: data.messageId });

    // Track referenced actors/items extracted by the normalizer
    if (data.speaker?.actorId) _referencedActorIds.add(data.speaker.actorId);
    if (Array.isArray(data.referencedActorIds)) {
      for (const id of data.referencedActorIds) _referencedActorIds.add(id);
    }
    if (Array.isArray(data.referencedItemIds)) {
      for (const id of data.referencedItemIds) _referencedItemIds.add(id);
    }

    _maybePersist();
    debug("Recorded chat:", data.messageId);
  },

  recordRoll(data) {
    if (!_session?.active) return;
    _rolls.push(data);
    _events.push({ type: "roll", ts: data.timestamp, ref: data.rollId });

    if (data.speaker?.actorId) _referencedActorIds.add(data.speaker.actorId);

    _maybePersist();
  },

  recordCombat(data) {
    if (!_session?.active) return;
    _combats.push(data);
    _events.push({ type: "combat", ts: data.timestamp, subtype: data.subtype });

    // Track combatant actor IDs
    if (Array.isArray(data.combatants)) {
      for (const c of data.combatants) {
        if (c.actorId) _referencedActorIds.add(c.actorId);
      }
    }

    _maybePersist();
  },

  recordScene(data) {
    if (!_session?.active) return;
    _scenes.push(data);
    _events.push({ type: "scene", ts: data.timestamp, ref: data.sceneId });

    if (data.subtype === "viewed" && data.sceneId) {
      _referencedSceneIds.add(data.sceneId);
    }

    _maybePersist();
  },

  recordActor(data) {
    if (!_session?.active) return;
    _actors.push(data);
    _events.push({ type: "actor", ts: data.timestamp, ref: data.actorId, subtype: data.subtype });

    if (data.actorId) _referencedActorIds.add(data.actorId);

    _maybePersist();
  },

  recordItem(data) {
    if (!_session?.active) return;
    _items.push(data);
    _events.push({ type: "item", ts: data.timestamp, ref: data.itemId, subtype: data.subtype });

    if (data.itemId) _referencedItemIds.add(data.itemId);

    _maybePersist();
  },

  recordJournal(data) {
    if (!_session?.active) return;
    _journals.push(data);
    _events.push({ type: "journal", ts: data.timestamp, ref: data.journalId, subtype: data.subtype });
    _maybePersist();
  },

  // ── Payload builder ───────────────────────────────────────────────────────

  buildPayload() {
    const privacy      = getPrivacySettings();
    const sess         = _session ?? {};
    const wi           = getWorldInfo();
    const campaignId   = getSetting("selectedCampaignId")   ?? "";
    const campaignName = getSetting("selectedCampaignName") ?? "";
    const captureMode  = getSetting("captureMode")          || "standard";
    const isFullSnap   = captureMode === "full_snapshot";

    // ── Build actor/item/scene arrays according to capture mode ─────────────
    let exportActors, exportItems, exportScenes;

    if (isFullSnap) {
      exportActors = _actors;
      exportItems  = _items;
      exportScenes = _scenes;
    } else {
      // Activity actors — keep create/update/delete events; drop world-dump records
      const activityActors = _actors.filter(function(a) {
        return a.subtype !== "session-open" && a.subtype !== "session-close";
      });
      // Minimal snapshots for referenced actors not already in activity records
      const inActivity = new Set(activityActors.map(function(a) { return a.actorId; }).filter(Boolean));
      const refActors = [];
      for (const id of _referencedActorIds) {
        if (!inActivity.has(id)) {
          const actor = game.actors?.get(id);
          if (actor) refActors.push(_minimalActorSnapshot(actor, new Date().toISOString(), "referenced"));
        }
      }
      exportActors = activityActors.concat(refActors);

      // Same logic for items
      const activityItems = _items.filter(function(i) {
        return i.subtype !== "session-open" && i.subtype !== "session-close";
      });
      const inActivityItems = new Set(activityItems.map(function(i) { return i.itemId; }).filter(Boolean));
      const refItems = [];
      for (const id of _referencedItemIds) {
        if (!inActivityItems.has(id)) {
          const item = game.items?.get(id);
          if (item) refItems.push(_minimalItemSnapshot(item, new Date().toISOString(), "referenced"));
        }
      }
      exportItems = activityItems.concat(refItems);

      // Scenes: keep everything except session-open world dumps
      exportScenes = _scenes.filter(function(s) { return s.subtype !== "session-open"; });
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    const summary = {
      captureMode,
      eventCount:           _events.length,
      chatMessageCount:     _chatMessages.length,
      rollCount:            _rolls.length,
      combatEventCount:     _combats.length,
      actorReferenceCount:  exportActors.length,
      itemReferenceCount:   exportItems.length,
      sceneVisitedCount:    exportScenes.filter(function(s) { return s.subtype === "viewed"; }).length,
      journalReferenceCount: _journals.length,
    };
    if (isFullSnap) {
      summary.snapshotActorCount = _actors.filter(function(a) { return a.subtype === "session-open"; }).length;
      summary.snapshotItemCount  = _items.filter(function(i)  { return i.subtype === "session-open"; }).length;
      summary.snapshotSceneCount = _scenes.filter(function(s) { return s.subtype === "session-open"; }).length;
    }

    debug("buildPayload —",
      "mode:", captureMode,
      "| events:", _events.length,
      "| chat:", _chatMessages.length,
      "| rolls:", _rolls.length,
      "| exportActors:", exportActors.length,
      "| exportItems:", exportItems.length,
      "| exportScenes:", exportScenes.length
    );

    return {
      schemaVersion: "1.2.0",
      captureMode,
      source:        "foundry_vtt",
      moduleId:      MODULE_ID,
      moduleVersion: wi.moduleVersion,

      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
      foundryVersion:   wi.foundryVersion,
      systemId:         wi.systemId,
      campaignId,
      campaignName,
      localSessionId: sess.localSessionId ?? "",
      startedAt:      sess.startedAt      ?? "",
      endedAt:        sess.endedAt        ?? "",

      world:      { id: wi.foundryWorldId, name: wi.foundryWorldName },
      tablecodex: { campaignId, campaignName },

      session: {
        localSessionId: sess.localSessionId ?? "",
        sessionTitle:   sess.sessionTitle   ?? "",
        startedAt:      sess.startedAt      ?? "",
        endedAt:        sess.endedAt        ?? "",
        timezone:       Intl.DateTimeFormat().resolvedOptions().timeZone,
        active:         sess.active         ?? false,
        synced:         sess.synced         ?? false,
        remoteImportId: sess.remoteImportId ?? null,
        remoteIntakeId: sess.remoteIntakeId ?? null,
      },

      settings: Object.assign({}, privacy, { captureMode }),
      summary,
      // Rich structured telemetry events (primary data source)
      telemetryEvents: telemetryRecorder.getEvents(),
      // Legacy arrays (kept for backwards compatibility and manual export)
      events:       _events,
      chatMessages: _chatMessages,
      rolls:        _rolls,
      combats:      _combats,
      actors:       exportActors,
      items:        exportItems,
      scenes:       exportScenes,
      journals:     _journals,
    };
  },

  markSynced(importId, intakeId) {
    if (_session) {
      _session.synced         = true;
      _session.remoteImportId = importId;
      _session.remoteIntakeId = intakeId ?? null;
      _persist();
    }
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _generateId() {
  return "tc-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

let _persistTimer = null;
function _maybePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(function() {
    _persistTimer = null;
    _persist();
  }, 10000);
}

async function _persist() {
  if (!_session) {
    await setSetting("localSessionBuffer", null);
    return;
  }
  await setSetting("localSessionBuffer", {
    session:      _session,
    events:       _events,
    chatMessages: _chatMessages,
    rolls:        _rolls,
    combats:      _combats,
    actors:       _actors,
    items:        _items,
    scenes:       _scenes,
    journals:     _journals,
    // Reference sets persisted as arrays for JSON serialization
    referencedActorIds: Array.from(_referencedActorIds),
    referencedItemIds:  Array.from(_referencedItemIds),
    referencedSceneIds: Array.from(_referencedSceneIds),
  });
}

function _persistToStore() {
  try {
    const wi               = getWorldInfo();
    const normalizedPayload = sessionRecorder.buildPayload();
    const payloadSizeKb    = Math.round(JSON.stringify(normalizedPayload).length / 1024);

    saveUnsyncedSession({
      localSessionId:    _session.localSessionId,
      sessionTitle:      _session.sessionTitle ?? "",
      startedAt:         _session.startedAt,
      endedAt:           _session.endedAt,
      foundryWorldId:    wi.foundryWorldId,
      foundryWorldName:  wi.foundryWorldName,
      campaignId:        getSetting("selectedCampaignId")   ?? "",
      campaignName:      getSetting("selectedCampaignName") ?? "",
      summary:           sessionRecorder.stats,
      status:            "unsynced",
      lastSyncAttemptAt: null,
      lastSyncError:     null,
      attemptCount:      0,
      remoteImportId:    null,
      payloadSizeKb,
      normalizedPayload,
    }).catch(function(err) { log("Warning: failed to save unsynced session to store:", err.message); });
  } catch (err) {
    log("Warning: _persistToStore threw:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Opening / closing snapshots — only run in full_snapshot mode
// ---------------------------------------------------------------------------

function _captureOpeningSnapshots() {
  const captureMode = getSetting("captureMode") || "standard";
  if (captureMode !== "full_snapshot") {
    debug("Skipping world snapshots (captureMode: " + captureMode + ")");
    return;
  }

  const privacy = getPrivacySettings();
  const ts = new Date().toISOString();

  if (privacy.captureActorSnapshots) {
    for (const actor of game.actors ?? []) {
      _actors.push(_snapshotActor(actor, ts, "session-open"));
    }
    log("Full snapshot: captured " + _actors.length + " actors at session-open.");
  }

  if (privacy.captureItemSnapshots) {
    for (const item of game.items ?? []) {
      _items.push(_snapshotItem(item, ts, "session-open"));
    }
    log("Full snapshot: captured " + _items.length + " items at session-open.");
  }

  if (privacy.captureSceneSnapshots && game.scenes) {
    for (const scene of game.scenes) {
      _scenes.push(_snapshotScene(scene, ts, "session-open"));
    }
    log("Full snapshot: captured " + _scenes.length + " scenes at session-open.");
  }
}

function _captureClosingSnapshots() {
  const captureMode = getSetting("captureMode") || "standard";
  if (captureMode !== "full_snapshot") return;

  const privacy = getPrivacySettings();
  const ts = new Date().toISOString();

  if (privacy.captureActorSnapshots) {
    for (const actor of game.actors ?? []) {
      _actors.push(_snapshotActor(actor, ts, "session-close"));
    }
  }

  if (privacy.captureItemSnapshots) {
    for (const item of game.items ?? []) {
      _items.push(_snapshotItem(item, ts, "session-close"));
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

// Full snapshot — used in full_snapshot mode and for live update events
export function _snapshotActor(actor, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    actorId:   actor.id,
    name:      actor.name,
    type:      actor.type,
    img:       actor.img,
    system:    _systemSummary(actor),
  };
}

export function _snapshotItem(item, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    itemId: item.id,
    name:   item.name,
    type:   item.type,
    img:    item.img,
    system: _systemSummary(item),
  };
}

export function _snapshotScene(scene, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    sceneId:  scene.id,
    name:     scene.name,
    active:   scene.active,
    navName:  scene.navName,
    width:    scene.width,
    height:   scene.height,
    gridSize: scene.grid?.size ?? scene.gridSize,
    gridType: scene.grid?.type ?? scene.gridType,
    img:      scene.background?.src ?? scene.img,
  };
}

// Minimal snapshot — used for referenced actors/items in minimal/standard modes.
// Includes only combat-relevant stats; no full system blob.
function _minimalActorSnapshot(actor, ts, subtype) {
  var sys   = actor.system   || {};
  var attrs = sys.attributes || {};
  var hp    = attrs.hp       || {};
  var ac    = attrs.ac       || {};

  return {
    subtype,
    timestamp: ts,
    actorId:  actor.id,
    name:     actor.name,
    type:     actor.type,
    img:      actor.img,
    hp:       hp.value !== undefined ? hp.value : null,
    hpMax:    hp.max   !== undefined ? hp.max   : null,
    ac:       ac.value !== undefined ? ac.value : null,
    disposition: actor.prototypeToken?.disposition ?? null,
  };
}

function _minimalItemSnapshot(item, ts, subtype) {
  var sys = item.system || {};
  var dmg = sys.damage  || {};

  return {
    subtype,
    timestamp:  ts,
    itemId:     item.id,
    name:       item.name,
    type:       item.type,
    img:        item.img,
    actorId:    item.actor?.id ?? null,
    actionType: sys.actionType                     ?? null,
    damage:     dmg.parts && dmg.parts.length > 0  ? dmg.parts : null,
    activation: sys.activation?.type               ?? null,
  };
}

// Shallow system summary — used for live update events and full_snapshot mode
function _systemSummary(doc) {
  const sys  = doc.system ?? {};
  const keys = Object.keys(sys).slice(0, 12);
  const out  = {};
  for (const k of keys) {
    const v = sys[k];
    if (v !== null && typeof v !== "object") {
      out[k] = v;
    } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const sub = {};
      for (const sk of Object.keys(v).slice(0, 6)) {
        if (typeof v[sk] !== "object") sub[sk] = v[sk];
      }
      out[k] = sub;
    }
  }
  return out;
}
