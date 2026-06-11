import { getSetting } from "./settings.js";
import { sessionRecorder } from "./session-recorder.js";
import { apiClient, validateReadyToSync } from "./api-client.js";
import { getWorldInfo } from "./world-info.js";
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
  const missing = Object.entries(required)
    .filter(([, v]) => !v || typeof v !== "string" || !v.trim())
    .map(([k]) => k);
  return missing;
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

function _filename(ext) {
  const wi       = getWorldInfo();
  const worldSlug = wi.foundryWorldName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
  const sess  = sessionRecorder.session;
  const date  = sess?.startedAt ? sess.startedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
  const id    = sess?.localSessionId ?? "unsaved";
  return `tablecodex-session-${worldSlug}-${date}-${id}.${ext}`;
}

// ---------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------

export function exportJson() {
  if (!(getSetting("selectedCampaignId") ?? "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }

  const payload = sessionRecorder.buildPayload();

  // Validate required fields before writing the file
  const missing = _validatePayloadFields(payload);
  if (missing.length > 0) {
    const msg = `Cannot export: missing ${missing.join(", ")}.`;
    ui.notifications.error(`TableCodex: ${msg}`);
    log("exportJson blocked —", msg);
    return;
  }

  debug("exportJson —",
    `foundryWorldId: ${payload.foundryWorldId},`,
    `foundryWorldName: ${payload.foundryWorldName},`,
    `localSessionId: ${payload.localSessionId},`,
    `startedAt: ${payload.startedAt},`,
    `endedAt: ${payload.endedAt || "—"},`,
    `events: ${payload.summary?.eventCount ?? 0},`,
    `chat: ${payload.summary?.chatMessageCount ?? 0},`,
    `rolls: ${payload.summary?.rollCount ?? 0}`
  );

  const json = JSON.stringify(payload, null, 2);
  _download(json, _filename("json"), "application/json");
  log("JSON export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportJsonOk"));
}

// ---------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------

export function exportMarkdown() {
  if (!(getSetting("selectedCampaignId") ?? "").trim()) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.NoCampaignExport"));
  }

  const payload = sessionRecorder.buildPayload();
  const md = _buildMarkdown(payload);
  _download(md, _filename("md"), "text/markdown");
  log("Markdown export complete.");
  ui.notifications.info(game.i18n.localize("TABLECODEX.Notify.ExportMdOk"));
}

function _buildMarkdown(p) {
  const lines = [];
  const sess  = p.session;

  lines.push(`# TableCodex Session Export`);
  lines.push(``);
  lines.push(`## Session Metadata`);
  lines.push(``);
  lines.push(`| Field | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Session ID | ${sess.localSessionId} |`);
  if (sess.sessionTitle) lines.push(`| Title | ${sess.sessionTitle} |`);
  lines.push(`| World | ${p.foundryWorldName} (${p.foundryWorldId}) |`);
  if (p.campaignName) lines.push(`| Campaign | ${p.campaignName} |`);
  lines.push(`| System | ${p.systemId} |`);
  lines.push(`| Foundry Version | ${p.foundryVersion} |`);
  lines.push(`| Started | ${sess.startedAt} |`);
  lines.push(`| Ended | ${sess.endedAt || "—"} |`);
  lines.push(`| Timezone | ${sess.timezone} |`);
  lines.push(`| Module Version | ${p.moduleVersion} |`);
  lines.push(``);

  lines.push(`## Summary`);
  lines.push(``);
  const s = p.summary;
  lines.push(`- **Total events**: ${s.eventCount}`);
  lines.push(`- **Chat messages**: ${s.chatMessageCount}`);
  lines.push(`- **Rolls**: ${s.rollCount}`);
  lines.push(`- **Combat events**: ${s.combatEventCount}`);
  lines.push(`- **Actor snapshots**: ${s.actorSnapshotCount}`);
  lines.push(`- **Item snapshots**: ${s.itemSnapshotCount}`);
  lines.push(`- **Scene snapshots**: ${s.sceneSnapshotCount}`);
  lines.push(`- **Journal entries**: ${s.journalSnapshotCount}`);
  lines.push(``);

  if (p.chatMessages.length > 0) {
    lines.push(`## Chat Transcript`);
    lines.push(``);
    for (const msg of p.chatMessages) {
      const who     = msg.speaker?.actorName ?? msg.speaker?.userName ?? "Unknown";
      const time    = msg.timestamp ? msg.timestamp.slice(11, 19) : "";
      const prefix  = msg.isWhisper ? `*[Whisper]* ` : "";
      const content = (msg.content ?? "").replace(/<[^>]*>/g, "").trim();
      lines.push(`**${who}** *(${time})* ${prefix}${content}`);
      if (msg.flavor) lines.push(`> ${msg.flavor}`);
      lines.push(``);
    }
  }

  if (p.rolls.length > 0) {
    lines.push(`## Rolls`);
    lines.push(``);
    lines.push(`| Time | Who | Formula | Total |`);
    lines.push(`|---|---|---|---|`);
    for (const r of p.rolls) {
      const who  = r.speaker?.actorName ?? r.speaker?.userName ?? "—";
      const time = r.timestamp ? r.timestamp.slice(11, 19) : "";
      lines.push(`| ${time} | ${who} | ${r.formula} | ${r.total ?? "—"} |`);
    }
    lines.push(``);
  }

  if (p.combats.length > 0) {
    lines.push(`## Combat Timeline`);
    lines.push(``);
    for (const c of p.combats) {
      const time = c.timestamp ? c.timestamp.slice(11, 19) : "";
      lines.push(`- **${c.subtype}** *(${time})* — Scene: ${c.sceneName ?? c.scene ?? "?"}, Round ${c.round}, Turn ${c.turn}`);
    }
    lines.push(``);
  }

  const scenesViewed = p.scenes.filter((s) => s.subtype === "viewed");
  if (scenesViewed.length > 0) {
    lines.push(`## Scenes Visited`);
    lines.push(``);
    for (const s of scenesViewed) {
      const time = s.timestamp ? s.timestamp.slice(11, 19) : "";
      lines.push(`- **${s.name}** *(${time})*`);
    }
    lines.push(``);
  }

  const actorNames = [...new Set(p.actors.map((a) => a.name).filter(Boolean))];
  if (actorNames.length > 0) {
    lines.push(`## Actors Referenced`);
    lines.push(``);
    for (const n of actorNames) lines.push(`- ${n}`);
    lines.push(``);
  }

  const itemNames = [...new Set(p.items.map((i) => i.name).filter(Boolean))];
  if (itemNames.length > 0) {
    lines.push(`## Items Referenced`);
    lines.push(``);
    for (const n of itemNames) lines.push(`- ${n}`);
    lines.push(``);
  }

  if (p.journals.length > 0) {
    lines.push(`## Journals Referenced`);
    lines.push(``);
    const seen = new Set();
    for (const j of p.journals) {
      if (seen.has(j.journalId)) continue;
      seen.add(j.journalId);
      const pageNames = (j.pages ?? []).map((pg) => pg.name).filter(Boolean).join(", ");
      lines.push(`- **${j.name}**${pageNames ? ` — pages: ${pageNames}` : ""}`);
    }
    lines.push(``);
  }

  lines.push(`---`);
  lines.push(`*Generated by TableCodex Sync v${p.moduleVersion}*`);
  lines.push(``);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// API sync
// ---------------------------------------------------------------------------

export async function syncSession() {
  // Validate credentials + campaign before touching the payload
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

  // Build the normalised payload (inner)
  const normalizedPayload = sessionRecorder.buildPayload();

  // Validate required fields on the normalized payload
  const missing = _validatePayloadFields(normalizedPayload);
  if (missing.length > 0) {
    const msg = `Cannot sync: missing ${missing.join(", ")}.`;
    ui.notifications.error(`TableCodex: ${msg}`);
    log("syncSession blocked —", msg);
    return { success: false, error: msg };
  }

  // Build the session-import envelope that the server validates
  const wi         = getWorldInfo();
  const campaignId = getSetting("selectedCampaignId") ?? "";

  const envelope = {
    campaignId,
    foundryWorldId:   wi.foundryWorldId,
    foundryWorldName: wi.foundryWorldName,
    foundryVersion:   wi.foundryVersion,
    systemId:         wi.systemId,
    moduleVersion:    wi.moduleVersion,
    localSessionId:   sess.localSessionId,
    startedAt:        sess.startedAt,
    endedAt:          sess.endedAt ?? "",
    source:           "api_sync",
    payload:          normalizedPayload,
  };

  debug("syncSession envelope —",
    `campaignId: ${campaignId},`,
    `foundryWorldId: ${wi.foundryWorldId},`,
    `foundryWorldName: ${wi.foundryWorldName},`,
    `localSessionId: ${sess.localSessionId},`,
    `startedAt: ${sess.startedAt},`,
    `endedAt: ${sess.endedAt || "—"},`,
    `events: ${normalizedPayload.summary?.eventCount ?? 0},`,
    `chat: ${normalizedPayload.summary?.chatMessageCount ?? 0},`,
    `rolls: ${normalizedPayload.summary?.rollCount ?? 0}`
  );

  const size = JSON.stringify(envelope).length;
  if (size > 5_000_000) {
    ui.notifications.warn(game.i18n.localize("TABLECODEX.Warn.LargePayload"));
  }

  const result = await apiClient.syncSession(envelope);
  if (result.success && result.importId) {
    sessionRecorder.markSynced(result.importId);
  }
  return result;
}
