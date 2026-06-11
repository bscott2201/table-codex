import { MODULE_ID, getSetting, cleanToken } from "./settings.js";
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
    .filter(([, v]) => !v || typeof v !== "string" || !v.trim())
    .map(([k]) => k);
}

// ---------------------------------------------------------------------------
// File download helper
// ---------------------------------------------------------------------------

function _download(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _filename(worldName, date, localSessionId, ext) {
  const slug = (worldName ?? "world").replace(/[^a-z0-9]/gi, "-").toLowerCase();
  return `tablecodex-session-${slug}-${date}-${localSessionId}.${ext}`;
}

function _currentFilename(ext) {
  const wi   = getWorldInfo();
  const sess = sessionRecorder.session;
  const date = sess?.startedAt ? sess.startedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  return _filename(wi.foundryWorldName, date, sess?.localSessionId ?? "unsaved", ext);
}

// ---------------------------------------------------------------------------
// JSON export — current session
// ---------------------------------------------------------------------------

export function exportJson() {
  if (!(getSetting("selectedCampaignId") ?? "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }

  const payload = sessionRecorder.buildPayload();
  const missing = _validatePayloadFields(payload);
  if (missing.length > 0) {
    const msg = `Cannot export: missing ${missing.join(", ")}.`;
    ui.notifications.error(`TableCodex: ${msg}`);
    log("exportJson blocked —", msg);
    return;
  }

  debug("exportJson —",
    `foundryWorldId: ${payload.foundryWorldId},`,
    `localSessionId: ${payload.localSessionId},`,
    `events: ${payload.summary?.eventCount ?? 0},`,
    `chat: ${payload.summary?.chatMessageCount ?? 0},`,
    `rolls: ${payload.summary?.rollCount ?? 0}`
  );

  _download(JSON.stringify(payload, null, 2), _currentFilename("json"), "application/json");
  log("JSON export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportJsonOk"));
}

// ---------------------------------------------------------------------------
// Markdown export — current session
// ---------------------------------------------------------------------------

export function exportMarkdown() {
  if (!(getSetting("selectedCampaignId") ?? "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }
  const payload = sessionRecorder.buildPayload();
  _download(_buildMarkdown(payload), _currentFilename("md"), "text/markdown");
  log("Markdown export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportMdOk"));
}

// ---------------------------------------------------------------------------
// Export helpers for unsynced (stored) sessions
// ---------------------------------------------------------------------------

export function exportUnsyncedJson(localSessionId) {
  const rec = _getRecord(localSessionId);
  if (!rec) return;
  const payload = rec.normalizedPayload ?? _minimalPayload(rec);
  const date = rec.startedAt ? rec.startedAt.slice(0, 10) : "unknown";
  _download(
    JSON.stringify(payload, null, 2),
    _filename(rec.foundryWorldName, date, localSessionId, "json"),
    "application/json"
  );
  log(`Exported unsynced session ${localSessionId} as JSON.`);
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportJsonOk"));
}

export function exportUnsyncedMarkdown(localSessionId) {
  const rec = _getRecord(localSessionId);
  if (!rec) return;
  const payload = rec.normalizedPayload ?? _minimalPayload(rec);
  const date = rec.startedAt ? rec.startedAt.slice(0, 10) : "unknown";
  _download(
    _buildMarkdown(payload),
    _filename(rec.foundryWorldName, date, localSessionId, "md"),
    "text/markdown"
  );
  log(`Exported unsynced session ${localSessionId} as Markdown.`);
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportMdOk"));
}

// ---------------------------------------------------------------------------
// API sync — current session
// ---------------------------------------------------------------------------

export async function syncSession() {
  const invalid = validateReadyToSync();
  if (invalid) {
    ui.notifications.warn(`TableCodex: ${invalid}`);
    return { success: false, error: invalid };
  }

  const sess = sessionRecorder.session;
  if (!sess) {
    const msg = game.i18n.localize("TABLECODEX.Error.NoSession");
    ui.notifications.warn(`TableCodex: ${msg}`);
    return { success: false, error: msg };
  }

  const normalizedPayload = sessionRecorder.buildPayload();
  const missing = _validatePayloadFields(normalizedPayload);
  if (missing.length > 0) {
    const msg = `Cannot sync: missing ${missing.join(", ")}.`;
    ui.notifications.error(`TableCodex: ${msg}`);
    log("syncSession blocked —", msg);
    return { success: false, error: msg };
  }

  const wi         = getWorldInfo();
  const campaignId = getSetting("selectedCampaignId") ?? "";
  const envelope   = _buildEnvelope(wi, campaignId, sess, normalizedPayload);

  debug("syncSession envelope —",
    `campaignId: ${campaignId},`,
    `foundryWorldId: ${wi.foundryWorldId},`,
    `localSessionId: ${sess.localSessionId},`,
    `startedAt: ${sess.startedAt},`,
    `events: ${normalizedPayload.summary?.eventCount ?? 0},`,
    `chat: ${normalizedPayload.summary?.chatMessageCount ?? 0},`,
    `rolls: ${normalizedPayload.summary?.rollCount ?? 0}`
  );

  if (JSON.stringify(envelope).length > 5_000_000) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.LargePayload"));
  }

  await markSessionPending(sess.localSessionId);

  const result = await apiClient.syncSession(envelope);
  if (result.success && result.importId) {
    sessionRecorder.markSynced(result.importId);
    await markSessionSynced(sess.localSessionId, result.importId);
  } else {
    await markSessionFailed(sess.localSessionId, result.error ?? "Unknown error");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Retry / Force sync — stored sessions
// ---------------------------------------------------------------------------

// Retry uses the stored normalizedPayload verbatim.
// Falls through to force sync if payload is missing.
export async function retrySyncSession(localSessionId) {
  const rec = _getRecord(localSessionId);
  if (!rec) {
    ui.notifications.error("TableCodex: Session record not found.");
    return { success: false, error: "Record not found" };
  }

  const credErr = validateApiCredentials();
  if (credErr) {
    ui.notifications.warn(`TableCodex: ${credErr}`);
    return { success: false, error: credErr };
  }

  const campaignId = rec.campaignId || (getSetting("selectedCampaignId") ?? "");
  if (!campaignId) {
    ui.notifications.warn("TableCodex: Select a campaign before retrying sync.");
    return { success: false, error: "No campaign selected" };
  }

  // Fall through to force-sync if no stored payload
  if (!rec.normalizedPayload) {
    log(`retrySyncSession: ${localSessionId} has no stored payload — running force sync.`);
    return forceSyncSession(localSessionId);
  }

  const wi       = getWorldInfo();
  const envelope = _buildEnvelope(wi, campaignId, rec, rec.normalizedPayload);

  debug("retrySyncSession —",
    `localSessionId: ${localSessionId},`,
    `campaignId: ${campaignId},`,
    `foundryWorldId: ${wi.foundryWorldId},`,
    `events: ${rec.summary?.eventCount ?? "?"},`,
    `chat: ${rec.summary?.chatMessageCount ?? "?"},`,
    `rolls: ${rec.summary?.rollCount ?? "?"}`
  );

  await markSessionPending(localSessionId);
  const result = await apiClient.syncSession(envelope);

  if (result.success && result.importId) {
    await markSessionSynced(localSessionId, result.importId);
    log(`retrySyncSession: ${localSessionId} synced → importId: ${result.importId}`);
  } else {
    await markSessionFailed(localSessionId, result.error ?? "Unknown error");
  }
  return result;
}

// Force sync rebuilds the envelope injecting current campaign + world info.
// Works even if the stored payload has empty campaignId or world fields.
export async function forceSyncSession(localSessionId) {
  const rec = _getRecord(localSessionId);
  if (!rec) {
    ui.notifications.error("TableCodex: Session record not found.");
    return { success: false, error: "Record not found" };
  }

  const credErr = validateApiCredentials();
  if (credErr) {
    ui.notifications.warn(`TableCodex: ${credErr}`);
    return { success: false, error: credErr };
  }

  // Prefer stored campaignId, fall back to current setting
  const campaignId = rec.campaignId || (getSetting("selectedCampaignId") ?? "");
  if (!campaignId) {
    ui.notifications.warn("TableCodex: Select a campaign before force syncing.");
    return { success: false, error: "No campaign selected" };
  }

  const wi = getWorldInfo();

  // Patch the stored normalizedPayload's flat fields so they're complete
  const innerPayload = rec.normalizedPayload
    ? {
        ...rec.normalizedPayload,
        campaignId,
        campaignName: rec.campaignName || getSetting("selectedCampaignName") || "",
        foundryWorldId:   wi.foundryWorldId,
        foundryWorldName: wi.foundryWorldName,
        foundryVersion:   wi.foundryVersion,
        systemId:         wi.systemId,
        moduleVersion:    wi.moduleVersion,
        world: { id: wi.foundryWorldId, name: wi.foundryWorldName },
        tablecodex: {
          campaignId,
          campaignName: rec.campaignName || getSetting("selectedCampaignName") || "",
        },
      }
    : _minimalPayload({ ...rec, campaignId, foundryWorldId: wi.foundryWorldId, foundryWorldName: wi.foundryWorldName });

  const envelope = _buildEnvelope(wi, campaignId, rec, innerPayload);

  debug("forceSyncSession —",
    `localSessionId: ${localSessionId},`,
    `campaignId: ${campaignId},`,
    `foundryWorldId: ${wi.foundryWorldId},`,
    `events: ${rec.summary?.eventCount ?? "?"}`
  );

  await markSessionPending(localSessionId);
  const result = await apiClient.syncSession(envelope);

  if (result.success && result.importId) {
    await markSessionSynced(localSessionId, result.importId);
    log(`forceSyncSession: ${localSessionId} synced → importId: ${result.importId}`);
  } else {
    await markSessionFailed(localSessionId, result.error ?? "Unknown error");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _getRecord(localSessionId) {
  return getUnsyncedSessions().find((s) => s.localSessionId === localSessionId) ?? null;
}

function _buildEnvelope(wi, campaignId, sessOrRecord, normalizedPayload) {
  return {
    campaignId,
    foundryWorldId:   wi.foundryWorldId,
    foundryWorldName: wi.foundryWorldName,
    foundryVersion:   wi.foundryVersion,
    systemId:         wi.systemId,
    moduleVersion:    wi.moduleVersion,
    localSessionId:   sessOrRecord.localSessionId,
    startedAt:        sessOrRecord.startedAt,
    endedAt:          sessOrRecord.endedAt ?? "",
    source:           "api_sync",
    payload:          normalizedPayload,
  };
}

function _minimalPayload(rec) {
  return {
    schemaVersion:    "1.0.0",
    source:           "foundry_vtt",
    moduleId:         MODULE_ID,
    moduleVersion:    rec.moduleVersion ?? "0.3.0",
    foundryWorldId:   rec.foundryWorldId ?? "",
    foundryWorldName: rec.foundryWorldName ?? "",
    foundryVersion:   rec.foundryVersion ?? "",
    systemId:         rec.systemId ?? "",
    campaignId:       rec.campaignId ?? "",
    campaignName:     rec.campaignName ?? "",
    localSessionId:   rec.localSessionId,
    startedAt:        rec.startedAt,
    endedAt:          rec.endedAt ?? "",
    world:            { id: rec.foundryWorldId ?? "", name: rec.foundryWorldName ?? "" },
    tablecodex:       { campaignId: rec.campaignId ?? "", campaignName: rec.campaignName ?? "" },
    session: {
      localSessionId: rec.localSessionId,
      sessionTitle:   rec.sessionTitle ?? "",
      startedAt:      rec.startedAt,
      endedAt:        rec.endedAt ?? "",
    },
    summary:      rec.summary ?? {},
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
// Markdown builder
// ---------------------------------------------------------------------------

function _buildMarkdown(p) {
  const lines = [];
  const sess  = p.session ?? {};

  lines.push(`# TableCodex Session Export`);
  lines.push(``);
  lines.push(`## Session Metadata`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Session ID | ${p.localSessionId ?? sess.localSessionId} |`);
  if (sess.sessionTitle) lines.push(`| Title | ${sess.sessionTitle} |`);
  lines.push(`| World | ${p.foundryWorldName} (${p.foundryWorldId}) |`);
  if (p.campaignName) lines.push(`| Campaign | ${p.campaignName} |`);
  lines.push(`| System | ${p.systemId} |`);
  lines.push(`| Foundry Version | ${p.foundryVersion} |`);
  lines.push(`| Started | ${p.startedAt ?? sess.startedAt} |`);
  lines.push(`| Ended | ${p.endedAt ?? sess.endedAt || "—"} |`);
  if (sess.timezone) lines.push(`| Timezone | ${sess.timezone} |`);
  lines.push(`| Module Version | ${p.moduleVersion} |`);
  lines.push(``);

  const s = p.summary ?? {};
  if (Object.keys(s).length > 0) {
    lines.push(`## Summary`);
    lines.push(``);
    lines.push(`- **Total events**: ${s.eventCount ?? 0}`);
    lines.push(`- **Chat messages**: ${s.chatMessageCount ?? 0}`);
    lines.push(`- **Rolls**: ${s.rollCount ?? 0}`);
    lines.push(`- **Combat events**: ${s.combatEventCount ?? 0}`);
    lines.push(`- **Actor snapshots**: ${s.actorSnapshotCount ?? 0}`);
    lines.push(`- **Scene snapshots**: ${s.sceneSnapshotCount ?? 0}`);
    lines.push(``);
  }

  const msgs = p.chatMessages ?? [];
  if (msgs.length > 0) {
    lines.push(`## Chat Transcript`);
    lines.push(``);
    for (const msg of msgs) {
      const who     = msg.speaker?.actorName ?? msg.speaker?.userName ?? "Unknown";
      const time    = msg.timestamp ? msg.timestamp.slice(11, 19) : "";
      const prefix  = msg.isWhisper ? `*[Whisper]* ` : "";
      const content = (msg.content ?? "").replace(/<[^>]*>/g, "").trim();
      lines.push(`**${who}** *(${time})* ${prefix}${content}`);
      if (msg.flavor) lines.push(`> ${msg.flavor}`);
      lines.push(``);
    }
  }

  const rolls = p.rolls ?? [];
  if (rolls.length > 0) {
    lines.push(`## Rolls`);
    lines.push(``);
    lines.push(`| Time | Who | Formula | Total |`);
    lines.push(`|---|---|---|---|`);
    for (const r of rolls) {
      const who  = r.speaker?.actorName ?? r.speaker?.userName ?? "—";
      const time = r.timestamp ? r.timestamp.slice(11, 19) : "";
      lines.push(`| ${time} | ${who} | ${r.formula} | ${r.total ?? "—"} |`);
    }
    lines.push(``);
  }

  const combats = p.combats ?? [];
  if (combats.length > 0) {
    lines.push(`## Combat Timeline`);
    lines.push(``);
    for (const c of combats) {
      const time = c.timestamp ? c.timestamp.slice(11, 19) : "";
      lines.push(`- **${c.subtype}** *(${time})* — Scene: ${c.sceneName ?? c.scene ?? "?"}, Round ${c.round}, Turn ${c.turn}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Generated by TableCodex Sync v${p.moduleVersion}*`);
  lines.push(``);
  return lines.join("\n");
}
