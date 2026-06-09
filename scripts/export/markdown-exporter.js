import { MODULE_ID, MODULE_VERSION, EXPORT_VERSION } from "../constants.js";
import { getSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

export function sanitizeFilename(value) {
  return (value ?? "export")
    .replace(/[^a-z0-9_\-\s]/gi, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 80) || "export";
}

export function buildExportMetadata() {
  return {
    foundryVersion: game?.version ?? "unknown",
    systemId: game?.system?.id ?? "unknown",
    systemTitle: game?.system?.title ?? "unknown",
    worldId: game?.world?.id ?? "unknown",
    worldTitle: game?.world?.title ?? "unknown",
    campaignId: getSetting("campaignId") ?? "",
    sessionId: getSetting("sessionId") ?? "",
    sessionTitle: getSetting("sessionTitle") || "Untitled Session",
    captureMode: getSetting("captureMode") ?? "standard",
    exportedAt: new Date().toISOString(),
  };
}

export function eventTitle(event) {
  switch (event?.eventType) {
    case "chat.message": return "Chat Message";
    case "chat.roll": return "Dice Roll";
    case "roll": return "Dice Roll";
    case "combat.started": return "Combat Started";
    case "combat.round.started": return `Round ${event?.payload?.round ?? "?"} Started`;
    case "combat.turn.started": return `Turn — ${event?.payload?.combatantName ?? "Unknown"}`;
    case "combat.ended": return "Combat Ended";
    case "scene.changed": return `Scene: ${event?.scene?.name ?? event?.payload?.sceneName ?? "Unknown"}`;
    case "actor.hp.changed": return `HP Changed — ${event?.actor?.name ?? event?.payload?.actorName ?? "Unknown"}`;
    case "session.started": return "Session Started";
    case "session.ended": return "Session Ended";
    default: return event?.eventType ?? "Event";
  }
}

export function eventSummary(event) {
  try {
    const p = event?.payload ?? {};
    switch (event?.eventType) {
      case "chat.message":
        return p.contentText?.slice(0, 200) ?? "";
      case "chat.roll": {
        const rollSummary = (p.rolls ?? [])
          .map((r) => `${r.formula} = **${r.total}**`)
          .join(", ");
        const text = p.contentText?.slice(0, 100) ?? "";
        return [rollSummary, text].filter(Boolean).join(" — ");
      }
      case "combat.started":
        return `Combat begins with ${(p.combatants ?? []).length} combatants.`;
      case "combat.round.started":
        return `Round ${p.round} begins.`;
      case "combat.turn.started":
        return `${p.combatantName ?? "?"}'s turn (round ${p.round ?? "?"}).`;
      case "combat.ended":
        return `Combat ends after round ${p.finalRound ?? "?"}.`;
      case "scene.changed":
        return `Scene changed to ${event?.scene?.name ?? p.sceneName ?? "unknown"}.`;
      case "actor.hp.changed":
        return `${p.actorName ?? "Actor"} HP: ${p.hpCurrent ?? "?"}/${p.hpMax ?? "?"}`;
      case "session.started":
        return `Session capture started. Mode: ${p.captureMode ?? "standard"}.`;
      case "session.ended":
        return `Session capture ended. Events archived: ${p.archivedEventCount ?? "?"}.`;
      default:
        return "";
    }
  } catch {
    return "";
  }
}

export function formatEventForMarkdown(event, options = {}) {
  const ts = event?.occurredAt ? new Date(event.occurredAt).toLocaleTimeString() : "??:??";
  const title = eventTitle(event);
  const summary = eventSummary(event);
  const lines = [`### ${ts} — ${title}`];

  if (event?.speaker?.alias || event?.speaker?.userName) {
    lines.push(`- **Speaker:** ${event.speaker.alias ?? event.speaker.userName}`);
  }
  if (event?.actor?.name) {
    lines.push(`- **Actor:** ${event.actor.name}`);
  }
  if (event?.scene?.name) {
    lines.push(`- **Scene:** ${event.scene.name}`);
  }
  if (event?.privacyLevel && event.privacyLevel !== "public") {
    lines.push(`- **Privacy:** ${event.privacyLevel}`);
  }

  if (summary) lines.push("", summary);

  if (options.includeRawJson !== false) {
    lines.push("", "```json", JSON.stringify(event, null, 2), "```");
  }

  return lines.join("\n");
}

export function buildSessionMarkdownExport({ events = [], metadata = {}, options = {} }) {
  const {
    foundryVersion, systemId, systemTitle, worldId, worldTitle,
    campaignId, sessionId, sessionTitle, captureMode, exportedAt,
  } = metadata;

  const frontmatter = [
    "---",
    `tablecodex_export_version: ${EXPORT_VERSION}`,
    `source: foundry-vtt`,
    `module_id: ${MODULE_ID}`,
    `module_version: ${MODULE_VERSION}`,
    `foundry_version: "${foundryVersion}"`,
    `system_id: "${systemId}"`,
    `system_title: "${systemTitle}"`,
    `world_id: "${worldId}"`,
    `world_title: "${worldTitle}"`,
    `campaign_id: "${campaignId}"`,
    `session_id: "${sessionId}"`,
    `session_title: "${sessionTitle || "Untitled Session"}"`,
    `exported_at: "${exportedAt}"`,
    `event_count: ${events.length}`,
    `privacy_mode: "${captureMode}"`,
    "---",
  ].join("\n");

  const header = [
    "# Foundry Session Export",
    "",
    "## Session Metadata",
    "",
    `- **World:** ${worldTitle} (\`${worldId}\`)`,
    `- **System:** ${systemTitle} (\`${systemId}\`)`,
    `- **Foundry Version:** ${foundryVersion}`,
    `- **Campaign ID:** ${campaignId || "—"}`,
    `- **Session ID:** ${sessionId || "—"}`,
    `- **Session Title:** ${sessionTitle || "Untitled Session"}`,
    `- **Capture Mode:** ${captureMode}`,
    `- **Exported At:** ${exportedAt}`,
    `- **Event Count:** ${events.length}`,
    "",
    "## Timeline",
    "",
  ].join("\n");

  const timeline = events.map((e) => formatEventForMarkdown(e, options)).join("\n\n---\n\n");

  return `${frontmatter}\n\n${header}${timeline || "_No events captured._"}`;
}

export function downloadMarkdownFile({ filename, markdown }) {
  try {
    const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    logger.log(`Downloaded: ${filename}`);
  } catch (err) {
    logger.error("downloadMarkdownFile failed:", err);
    ui?.notifications?.error("[TableCodex] Failed to download export file.");
  }
}
