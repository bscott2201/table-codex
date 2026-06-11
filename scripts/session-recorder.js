import { MODULE_ID, getSetting, setSetting, getPrivacySettings } from "./settings.js";
import { log, debug } from "./logger.js";
import { getWorldInfo } from "./world-info.js";
import { saveUnsyncedSession } from "./session-store.js";

// In-memory session state. Also persisted to world settings for reload recovery.
let _session = null;
let _events = [];
let _chatMessages = [];
let _rolls = [];
let _combats = [];
let _actors = [];
let _items = [];
let _scenes = [];
let _journals = [];

export const sessionRecorder = {
  get isActive() { return _session !== null && _session.active; },
  get session() { return _session; },
  get eventCount() { return _events.length; },
  get stats() {
    return {
      eventCount: _events.length,
      chatMessageCount: _chatMessages.length,
      rollCount: _rolls.length,
      combatEventCount: _combats.length,
      actorSnapshotCount: _actors.length,
      itemSnapshotCount: _items.length,
      sceneSnapshotCount: _scenes.length,
      journalSnapshotCount: _journals.length,
    };
  },

  async start(options = {}) {
    if (_session?.active) {
      ui.notifications.warn(game.i18n.localize("TABLECODEX.Session.AlreadyActive"));
      return false;
    }

    _session = {
      localSessionId: _generateId(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      active: true,
      synced: false,
      remoteImportId: null,
      sessionTitle: options.sessionTitle ?? "",
    };
    _events = [];
    _chatMessages = [];
    _rolls = [];
    _combats = [];
    _actors = [];
    _items = [];
    _scenes = [];
    _journals = [];

    await _persist();
    _captureOpeningSnapshots();

    log(`Session started: ${_session.localSessionId}`);
    Hooks.callAll(`${MODULE_ID}.sessionStarted`, _session);
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

    await _persist();
    log(`Session ended: ${_session.localSessionId}`);

    // Snapshot everything into the unsynced store so retry is possible after reload.
    _persistToStore();

    Hooks.callAll(`${MODULE_ID}.sessionStopped`, _session);
    ui.notifications.info(game.i18n.localize("TABLECODEX.Session.Ended"));
    return true;
  },

  async resume() {
    // Called on reload if buffer exists
    const buf = getSetting("localSessionBuffer");
    if (!buf) return false;

    _session = buf.session;
    _events = buf.events ?? [];
    _chatMessages = buf.chatMessages ?? [];
    _rolls = buf.rolls ?? [];
    _combats = buf.combats ?? [];
    _actors = buf.actors ?? [];
    _items = buf.items ?? [];
    _scenes = buf.scenes ?? [];
    _journals = buf.journals ?? [];

    log(`Session resumed: ${_session?.localSessionId}`);
    return true;
  },

  async clearBuffer() {
    _session = null;
    _events = [];
    _chatMessages = [];
    _rolls = [];
    _combats = [];
    _actors = [];
    _items = [];
    _scenes = [];
    _journals = [];
    await setSetting("localSessionBuffer", null);
    Hooks.callAll(`${MODULE_ID}.bufferCleared`);
    ui.notifications.info(game.i18n.localize("TABLECODEX.Session.BufferCleared"));
  },

  recordChat(data) {
    if (!_session?.active) return;
    _chatMessages.push(data);
    _events.push({ type: "chat", ts: data.timestamp, ref: data.messageId });
    _maybePersist();
    debug("Recorded chat:", data.messageId);
  },

  recordRoll(data) {
    if (!_session?.active) return;
    _rolls.push(data);
    _events.push({ type: "roll", ts: data.timestamp, ref: data.rollId });
    _maybePersist();
  },

  recordCombat(data) {
    if (!_session?.active) return;
    _combats.push(data);
    _events.push({ type: "combat", ts: data.timestamp, subtype: data.subtype });
    _maybePersist();
  },

  recordScene(data) {
    if (!_session?.active) return;
    _scenes.push(data);
    _events.push({ type: "scene", ts: data.timestamp, ref: data.sceneId });
    _maybePersist();
  },

  recordActor(data) {
    if (!_session?.active) return;
    _actors.push(data);
    _events.push({ type: "actor", ts: data.timestamp, ref: data.actorId, subtype: data.subtype });
    _maybePersist();
  },

  recordItem(data) {
    if (!_session?.active) return;
    _items.push(data);
    _events.push({ type: "item", ts: data.timestamp, ref: data.itemId, subtype: data.subtype });
    _maybePersist();
  },

  recordJournal(data) {
    if (!_session?.active) return;
    _journals.push(data);
    _events.push({ type: "journal", ts: data.timestamp, ref: data.journalId, subtype: data.subtype });
    _maybePersist();
  },

  buildPayload() {
    const privacy  = getPrivacySettings();
    const sess     = _session ?? {};
    const wi       = getWorldInfo();
    const campaignId   = getSetting("selectedCampaignId")   ?? "";
    const campaignName = getSetting("selectedCampaignName") ?? "";

    return {
      // Schema / source identifiers
      schemaVersion: "1.0.0",
      source:        "foundry_vtt",
      moduleId:      MODULE_ID,
      moduleVersion: wi.moduleVersion,

      // Flat top-level fields required by the web app upload validator
      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
      foundryVersion:   wi.foundryVersion,
      systemId:         wi.systemId,
      campaignId,
      campaignName,
      localSessionId: sess.localSessionId ?? "",
      startedAt:      sess.startedAt      ?? "",
      endedAt:        sess.endedAt        ?? "",

      // Nested world object (kept for backwards compat / human readability)
      world: {
        id:   wi.foundryWorldId,
        name: wi.foundryWorldName,
      },

      // TableCodex-specific metadata
      tablecodex: { campaignId, campaignName },

      // Session envelope
      session: {
        localSessionId: sess.localSessionId ?? "",
        sessionTitle:   sess.sessionTitle   ?? "",
        startedAt:      sess.startedAt      ?? "",
        endedAt:        sess.endedAt        ?? "",
        timezone:       Intl.DateTimeFormat().resolvedOptions().timeZone,
        active:         sess.active         ?? false,
        synced:         sess.synced         ?? false,
        remoteImportId: sess.remoteImportId ?? null,
      },

      settings: privacy,
      summary:  this.stats,
      events:       _events,
      chatMessages: _chatMessages,
      rolls:        _rolls,
      combats:      _combats,
      actors:       _actors,
      items:        _items,
      scenes:       _scenes,
      journals:     _journals,
    };
  },

  markSynced(importId) {
    if (_session) {
      _session.synced = true;
      _session.remoteImportId = importId;
      _persist();
    }
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _generateId() {
  return `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

let _persistTimer = null;
function _maybePersist() {
  // Debounce — persist at most once per 10 s during active play
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    _persist();
  }, 10_000);
}

async function _persist() {
  if (!_session) {
    await setSetting("localSessionBuffer", null);
    return;
  }
  await setSetting("localSessionBuffer", {
    session: _session,
    events: _events,
    chatMessages: _chatMessages,
    rolls: _rolls,
    combats: _combats,
    actors: _actors,
    items: _items,
    scenes: _scenes,
    journals: _journals,
  });
}

function _persistToStore() {
  // Build and save the record asynchronously — errors are non-fatal.
  try {
    const wi             = getWorldInfo();
    const normalizedPayload = sessionRecorder.buildPayload();
    const payloadSizeKb  = Math.round(JSON.stringify(normalizedPayload).length / 1024);

    saveUnsyncedSession({
      localSessionId:   _session.localSessionId,
      sessionTitle:     _session.sessionTitle ?? "",
      startedAt:        _session.startedAt,
      endedAt:          _session.endedAt,
      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
      campaignId:       getSetting("selectedCampaignId")   ?? "",
      campaignName:     getSetting("selectedCampaignName") ?? "",
      summary:          sessionRecorder.stats,
      status:           "unsynced",
      lastSyncAttemptAt: null,
      lastSyncError:    null,
      attemptCount:     0,
      remoteImportId:   null,
      payloadSizeKb,
      normalizedPayload,
    }).catch((err) => log("Warning: failed to save unsynced session to store:", err.message));
  } catch (err) {
    log("Warning: _persistToStore threw:", err.message);
  }
}

function _captureOpeningSnapshots() {
  const privacy = getPrivacySettings();
  const ts = new Date().toISOString();

  if (privacy.captureActorSnapshots) {
    for (const actor of game.actors ?? []) {
      _actors.push(_snapshotActor(actor, ts, "session-open"));
    }
  }

  if (privacy.captureItemSnapshots) {
    for (const item of game.items ?? []) {
      _items.push(_snapshotItem(item, ts, "session-open"));
    }
  }

  if (privacy.captureSceneSnapshots && game.scenes) {
    for (const scene of game.scenes) {
      _scenes.push(_snapshotScene(scene, ts, "session-open"));
    }
  }
}

function _captureClosingSnapshots() {
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

export function _snapshotActor(actor, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    actorId: actor.id,
    name: actor.name,
    type: actor.type,
    img: actor.img,
    system: _systemSummary(actor),
  };
}

export function _snapshotItem(item, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    itemId: item.id,
    name: item.name,
    type: item.type,
    img: item.img,
    system: _systemSummary(item),
  };
}

export function _snapshotScene(scene, ts, subtype) {
  return {
    subtype,
    timestamp: ts,
    sceneId: scene.id,
    name: scene.name,
    active: scene.active,
    navName: scene.navName,
    width: scene.width,
    height: scene.height,
    gridSize: scene.grid?.size ?? scene.gridSize,
    gridType: scene.grid?.type ?? scene.gridType,
    img: scene.background?.src ?? scene.img,
  };
}

function _systemSummary(doc) {
  // Return only a shallow summary to avoid huge dumps
  const sys = doc.system ?? {};
  const keys = Object.keys(sys).slice(0, 12);
  const out = {};
  for (const k of keys) {
    const v = sys[k];
    if (v !== null && typeof v !== "object") out[k] = v;
    else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      // One level deep for nested objects like hp, attributes
      const sub = {};
      for (const sk of Object.keys(v).slice(0, 6)) {
        if (typeof v[sk] !== "object") sub[sk] = v[sk];
      }
      out[k] = sub;
    }
  }
  return out;
}
