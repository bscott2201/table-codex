// TableCodex Sync — exporter.js
// Note: _buildMarkdown uses array + string concatenation throughout.
// Template literals are intentionally avoided inside that function to prevent
// any engine-specific parsing issues with non-ASCII characters in ${...}.

import { MODULE_ID, getSetting, cleanToken, getSelectedCampaignIdForApi } from "./settings.js";
import { sessionRecorder } from "./session-recorder.js";
import { apiClient, validateReadyToSync, validateApiCredentials } from "./api-client.js";
import { getWorldInfo } from "./world-info.js";
import {
  getUnsyncedSessions,
  saveUnsyncedSession,
  markSessionPending,
  markSessionSynced,
  markSessionFailed,
} from "./session-store.js";
import { log, debug } from "./logger.js";

console.log("[TableCodex Sync] exporter.js evaluated");

// ---------------------------------------------------------------------------
// Pre-flight validation
// ---------------------------------------------------------------------------

function _validatePayloadFields(payload) {
  const required = {
    foundryWorldId:   payload.foundryWorldId,
    foundryWorldName: payload.foundryWorldName,
    localSessionId:   payload.localSessionId,
    startedAt:        payload.startedAt,
  };
  return Object.entries(required)
    .filter(function(entry) {
      var v = entry[1];
      return !v || typeof v !== "string" || !v.trim();
    })
    .map(function(entry) { return entry[0]; });
}

// ---------------------------------------------------------------------------
// File download helper
// ---------------------------------------------------------------------------

function _download(content, filename, mimeType) {
  var blob = new Blob([content], { type: mimeType });
  var url  = URL.createObjectURL(blob);
  var a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _filename(worldName, date, localSessionId, ext) {
  var slug = (worldName || "world").replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return "tablecodex-session-" + slug + "-" + date + "-" + localSessionId + "." + ext;
}

function _currentFilename(ext) {
  var wi   = getWorldInfo();
  var sess = sessionRecorder.session;
  var date = sess && sess.startedAt
    ? sess.startedAt.slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  var id = (sess && sess.localSessionId) ? sess.localSessionId : "unsaved";
  return _filename(wi.foundryWorldName, date, id, ext);
}

// ---------------------------------------------------------------------------
// JSON export — current session
// ---------------------------------------------------------------------------

export function exportJson() {
  if (!(getSetting("selectedCampaignId") || "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }

  var payload = sessionRecorder.buildPayload();
  var missing = _validatePayloadFields(payload);
  if (missing.length > 0) {
    var msg = "Cannot export: missing " + missing.join(", ") + ".";
    ui.notifications.error("TableCodex: " + msg);
    log("exportJson blocked:", msg);
    return;
  }

  debug("exportJson",
    "foundryWorldId:", payload.foundryWorldId,
    "localSessionId:", payload.localSessionId,
    "events:", (payload.summary && payload.summary.eventCount) || 0
  );

  _download(JSON.stringify(payload, null, 2), _currentFilename("json"), "application/json");
  log("JSON export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportJsonOk"));
}

// ---------------------------------------------------------------------------
// Markdown export — current session
// ---------------------------------------------------------------------------

export function exportMarkdown() {
  if (!(getSetting("selectedCampaignId") || "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }
  var payload = sessionRecorder.buildPayload();
  _download(_buildMarkdown(payload), _currentFilename("md"), "text/markdown");
  log("Markdown export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportMdOk"));
}

// ---------------------------------------------------------------------------
// Export helpers for unsynced (stored) sessions
// ---------------------------------------------------------------------------

export function exportUnsyncedJson(localSessionId) {
  var rec = _getRecord(localSessionId);
  if (!rec) return;
  var payload = rec.normalizedPayload || _minimalPayload(rec);
  var date = rec.startedAt ? rec.startedAt.slice(0, 10) : "unknown";
  _download(
    JSON.stringify(payload, null, 2),
    _filename(rec.foundryWorldName, date, localSessionId, "json"),
    "application/json"
  );
  log("Exported unsynced session " + localSessionId + " as JSON.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportJsonOk"));
}

export function exportUnsyncedMarkdown(localSessionId) {
  var rec = _getRecord(localSessionId);
  if (!rec) return;
  var payload = rec.normalizedPayload || _minimalPayload(rec);
  var date = rec.startedAt ? rec.startedAt.slice(0, 10) : "unknown";
  _download(
    _buildMarkdown(payload),
    _filename(rec.foundryWorldName, date, localSessionId, "md"),
    "text/markdown"
  );
  log("Exported unsynced session " + localSessionId + " as Markdown.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportMdOk"));
}

// ---------------------------------------------------------------------------
// API sync — current session
// ---------------------------------------------------------------------------

export async function syncSession() {
  var invalid = validateReadyToSync();
  if (invalid) {
    ui.notifications.warn("TableCodex: " + invalid);
    return { success: false, error: invalid };
  }

  var sess = sessionRecorder.session;
  if (!sess) {
    var msg = game.i18n.localize("TABLECODEX.Error.NoSession");
    ui.notifications.warn("TableCodex: " + msg);
    return { success: false, error: msg };
  }

  var normalizedPayload = sessionRecorder.buildPayload();
  var missing = _validatePayloadFields(normalizedPayload);
  if (missing.length > 0) {
    var blockMsg = "Cannot sync: missing " + missing.join(", ") + ".";
    ui.notifications.error("TableCodex: " + blockMsg);
    log("syncSession blocked:", blockMsg);
    return { success: false, error: blockMsg };
  }

  var wi         = getWorldInfo();
  var campaignId = getSelectedCampaignIdForApi();

  if (campaignId === null) {
    var rawCampaignId = getSetting("selectedCampaignId");
    var badIdMsg = "Campaign ID \"" + rawCampaignId + "\" could not be parsed as a number. Re-select the campaign.";
    ui.notifications.error("TableCodex: " + badIdMsg);
    return { success: false, error: badIdMsg };
  }

  var envelope = _buildEnvelope(wi, campaignId, sess, normalizedPayload);

  debug("syncSession",
    "campaignId raw:", getSetting("selectedCampaignId"),
    "parsed:", campaignId,
    "type:", typeof campaignId,
    "foundryWorldId:", wi.foundryWorldId,
    "localSessionId:", sess.localSessionId,
    "events:", (normalizedPayload.summary && normalizedPayload.summary.eventCount) || 0
  );

  if (JSON.stringify(envelope).length > 5000000) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.LargePayload"));
  }

  await markSessionPending(sess.localSessionId);
  var result = await apiClient.syncSession(envelope);

  if (result.success && result.importId) {
    sessionRecorder.markSynced(result.importId);
    await markSessionSynced(sess.localSessionId, result.importId);
  } else {
    await markSessionFailed(sess.localSessionId, result.error || "Unknown error");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Retry / Force sync — stored sessions
// ---------------------------------------------------------------------------

export async function retrySyncSession(localSessionId) {
  var rec = _getRecord(localSessionId);
  if (!rec) {
    ui.notifications.error("TableCodex: Session record not found.");
    return { success: false, error: "Record not found" };
  }

  var credErr = validateApiCredentials();
  if (credErr) {
    ui.notifications.warn("TableCodex: " + credErr);
    return { success: false, error: credErr };
  }

  // Resolve campaignId as number — prefer stored record, fall back to current setting
  var rawCampaignId = rec.campaignId || (getSetting("selectedCampaignId") || "");
  if (!rawCampaignId) {
    ui.notifications.warn("TableCodex: Select a campaign before retrying sync.");
    return { success: false, error: "No campaign selected" };
  }
  var campaignId = Number(rawCampaignId);
  if (!Number.isFinite(campaignId) || campaignId <= 0) {
    ui.notifications.error("TableCodex: Campaign ID \"" + rawCampaignId + "\" is not a valid number. Re-select the campaign.");
    return { success: false, error: "Invalid campaign ID" };
  }

  if (!rec.normalizedPayload) {
    log("retrySyncSession: " + localSessionId + " has no stored payload — running force sync.");
    return forceSyncSession(localSessionId);
  }

  var wi       = getWorldInfo();
  var envelope = _buildEnvelope(wi, campaignId, rec, rec.normalizedPayload);

  debug("retrySyncSession",
    "campaignId raw:", rawCampaignId,
    "parsed:", campaignId,
    "type:", typeof campaignId
  );
  debug("retrySyncSession",
    "localSessionId:", localSessionId,
    "campaignId:", campaignId,
    "foundryWorldId:", wi.foundryWorldId
  );

  await markSessionPending(localSessionId);
  var result = await apiClient.syncSession(envelope);

  if (result.success && result.importId) {
    await markSessionSynced(localSessionId, result.importId);
    log("retrySyncSession: " + localSessionId + " synced, importId: " + result.importId);
  } else {
    await markSessionFailed(localSessionId, result.error || "Unknown error");
  }
  return result;
}

export async function forceSyncSession(localSessionId) {
  var rec = _getRecord(localSessionId);
  if (!rec) {
    ui.notifications.error("TableCodex: Session record not found.");
    return { success: false, error: "Record not found" };
  }

  var credErr = validateApiCredentials();
  if (credErr) {
    ui.notifications.warn("TableCodex: " + credErr);
    return { success: false, error: credErr };
  }

  var rawForceCampaignId = rec.campaignId || (getSetting("selectedCampaignId") || "");
  if (!rawForceCampaignId) {
    ui.notifications.warn("TableCodex: Select a campaign before force syncing.");
    return { success: false, error: "No campaign selected" };
  }
  var campaignId = Number(rawForceCampaignId);
  if (!Number.isFinite(campaignId) || campaignId <= 0) {
    ui.notifications.error("TableCodex: Campaign ID \"" + rawForceCampaignId + "\" is not a valid number. Re-select the campaign.");
    return { success: false, error: "Invalid campaign ID" };
  }

  debug("forceSyncSession",
    "campaignId raw:", rawForceCampaignId,
    "parsed:", campaignId,
    "type:", typeof campaignId
  );

  var wi = getWorldInfo();
  var selectedCampaignName = getSetting("selectedCampaignName") || "";

  var innerPayload;
  if (rec.normalizedPayload) {
    innerPayload = Object.assign({}, rec.normalizedPayload, {
      campaignId:       campaignId,
      campaignName:     rec.campaignName || selectedCampaignName,
      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
      foundryVersion:   wi.foundryVersion,
      systemId:         wi.systemId,
      moduleVersion:    wi.moduleVersion,
      world:            { id: wi.foundryWorldId, name: wi.foundryWorldName },
      tablecodex: {
        campaignId:   campaignId,
        campaignName: rec.campaignName || selectedCampaignName,
      },
    });
  } else {
    innerPayload = _minimalPayload(Object.assign({}, rec, {
      campaignId:       campaignId,
      foundryWorldId:   wi.foundryWorldId,
      foundryWorldName: wi.foundryWorldName,
    }));
  }

  var envelope = _buildEnvelope(wi, campaignId, rec, innerPayload);

  debug("forceSyncSession",
    "localSessionId:", localSessionId,
    "campaignId:", campaignId,
    "foundryWorldId:", wi.foundryWorldId
  );

  await markSessionPending(localSessionId);
  var result = await apiClient.syncSession(envelope);

  if (result.success && result.importId) {
    await markSessionSynced(localSessionId, result.importId);
    log("forceSyncSession: " + localSessionId + " synced, importId: " + result.importId);
  } else {
    await markSessionFailed(localSessionId, result.error || "Unknown error");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _getRecord(localSessionId) {
  var sessions = getUnsyncedSessions();
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].localSessionId === localSessionId) return sessions[i];
  }
  return null;
}

function _buildEnvelope(wi, campaignId, sessOrRecord, normalizedPayload) {
  return {
    campaignId:       campaignId,
    foundryWorldId:   wi.foundryWorldId,
    foundryWorldName: wi.foundryWorldName,
    foundryVersion:   wi.foundryVersion,
    systemId:         wi.systemId,
    moduleVersion:    wi.moduleVersion,
    localSessionId:   sessOrRecord.localSessionId,
    startedAt:        sessOrRecord.startedAt,
    endedAt:          sessOrRecord.endedAt || "",
    source:           "api_sync",
    payload:          normalizedPayload,
  };
}

function _minimalPayload(rec) {
  return {
    schemaVersion:    "1.0.0",
    source:           "foundry_vtt",
    moduleId:         MODULE_ID,
    moduleVersion:    rec.moduleVersion || "0.3.5",
    foundryWorldId:   rec.foundryWorldId || "",
    foundryWorldName: rec.foundryWorldName || "",
    foundryVersion:   rec.foundryVersion || "",
    systemId:         rec.systemId || "",
    campaignId:       rec.campaignId || "",
    campaignName:     rec.campaignName || "",
    localSessionId:   rec.localSessionId,
    startedAt:        rec.startedAt,
    endedAt:          rec.endedAt || "",
    world:            { id: rec.foundryWorldId || "", name: rec.foundryWorldName || "" },
    tablecodex:       { campaignId: rec.campaignId || "", campaignName: rec.campaignName || "" },
    session: {
      localSessionId: rec.localSessionId,
      sessionTitle:   rec.sessionTitle || "",
      startedAt:      rec.startedAt,
      endedAt:        rec.endedAt || "",
    },
    summary:      rec.summary || {},
    events:       [],
    chatMessages: [],
    rolls:        [],
    combats:      [],
    actors:       [],
    items:        [],
    scenes:       [],
    journals:     [],
  };
}

// ---------------------------------------------------------------------------
// Markdown builder — pure string concatenation, no template literals,
// no raw Unicode characters. Em dash represented as "—".
// ---------------------------------------------------------------------------

function _buildMarkdown(p) {
  var DASH = "—";
  var lines = [];
  var sess  = p.session || {};

  lines.push("# TableCodex Session Export");
  lines.push("");
  lines.push("## Session Metadata");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push("| Session ID | " + (p.localSessionId || sess.localSessionId || "") + " |");
  if (sess.sessionTitle) {
    lines.push("| Title | " + sess.sessionTitle + " |");
  }
  lines.push("| World | " + (p.foundryWorldName || "") + " (" + (p.foundryWorldId || "") + ") |");
  if (p.campaignName) {
    lines.push("| Campaign | " + p.campaignName + " |");
  }
  lines.push("| System | " + (p.systemId || "") + " |");
  lines.push("| Foundry Version | " + (p.foundryVersion || "") + " |");
  lines.push("| Started | " + (p.startedAt || sess.startedAt || "") + " |");
  lines.push("| Ended | " + (p.endedAt || sess.endedAt || DASH) + " |");
  if (sess.timezone) {
    lines.push("| Timezone | " + sess.timezone + " |");
  }
  lines.push("| Module Version | " + (p.moduleVersion || "") + " |");
  lines.push("");

  var s = p.summary || {};
  if (Object.keys(s).length > 0) {
    lines.push("## Summary");
    lines.push("");
    lines.push("- **Total events**: " + (s.eventCount || 0));
    lines.push("- **Chat messages**: " + (s.chatMessageCount || 0));
    lines.push("- **Rolls**: " + (s.rollCount || 0));
    lines.push("- **Combat events**: " + (s.combatEventCount || 0));
    lines.push("- **Actor snapshots**: " + (s.actorSnapshotCount || 0));
    lines.push("- **Scene snapshots**: " + (s.sceneSnapshotCount || 0));
    lines.push("");
  }

  var msgs = p.chatMessages || [];
  if (msgs.length > 0) {
    lines.push("## Chat Transcript");
    lines.push("");
    for (var i = 0; i < msgs.length; i++) {
      var msg     = msgs[i];
      var spk     = msg.speaker || {};
      var who     = spk.actorName || spk.userName || "Unknown";
      var time    = msg.timestamp ? msg.timestamp.slice(11, 19) : "";
      var prefix  = msg.isWhisper ? "*[Whisper]* " : "";
      var content = (msg.content || "").replace(/<[^>]*>/g, "").trim();
      lines.push("**" + who + "** *(" + time + ")* " + prefix + content);
      if (msg.flavor) {
        lines.push("> " + msg.flavor);
      }
      lines.push("");
    }
  }

  var rolls = p.rolls || [];
  if (rolls.length > 0) {
    lines.push("## Rolls");
    lines.push("");
    lines.push("| Time | Who | Formula | Total |");
    lines.push("|---|---|---|---|");
    for (var r = 0; r < rolls.length; r++) {
      var roll = rolls[r];
      var rSpk  = roll.speaker || {};
      var rWho  = rSpk.actorName || rSpk.userName || DASH;
      var rTime = roll.timestamp ? roll.timestamp.slice(11, 19) : "";
      var rTot  = (roll.total !== null && roll.total !== undefined) ? roll.total : DASH;
      lines.push("| " + rTime + " | " + rWho + " | " + (roll.formula || "") + " | " + rTot + " |");
    }
    lines.push("");
  }

  var combats = p.combats || [];
  if (combats.length > 0) {
    lines.push("## Combat Timeline");
    lines.push("");
    for (var c = 0; c < combats.length; c++) {
      var cb   = combats[c];
      var cTime = cb.timestamp ? cb.timestamp.slice(11, 19) : "";
      var scene = cb.sceneName || cb.scene || "?";
      lines.push(
        "- **" + (cb.subtype || "") + "** *(" + cTime + ")* " + DASH +
        " Scene: " + scene + ", Round " + (cb.round || 0) + ", Turn " + (cb.turn || 0)
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by TableCodex Sync v" + (p.moduleVersion || "") + "*");
  lines.push("");

  return lines.join("\n");
}
