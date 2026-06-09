import { getSetting } from "../core/settings.js";
import { getFoundryWorldContext } from "../core/foundry-context.js";
import { getArchivedEvents } from "../capture/session-archive.js";
import {
  buildSessionMarkdownExport,
  buildExportMetadata,
  downloadMarkdownFile,
  sanitizeFilename,
} from "./markdown-exporter.js";
import { logger } from "../core/logger.js";

export async function openExportDialog() {
  const sessionId = getSetting("sessionId");
  const worldId = getFoundryWorldContext().foundryWorldId;
  const events = getArchivedEvents({ worldId, sessionId });

  if (events.length === 0) {
    ui?.notifications?.warn("[TableCodex] No archived events found for the current capture.");
    return;
  }

  const metadata = buildExportMetadata();

  // Confirm export with event count so the GM knows what they're getting.
  const confirmed = await Dialog.confirm({
    title: "Export Session Markdown",
    content: `
      <p>Export <strong>${events.length} events</strong> from this session as a Markdown file?</p>
      <p><em>Session: ${metadata.sessionTitle}</em></p>
      <p>This file can be imported manually into the TableCodex web app.</p>
    `,
    yes: () => true,
    no: () => false,
  });

  if (!confirmed) return;

  try {
    const markdown = buildSessionMarkdownExport({ events, metadata });
    const sessionSlug = sanitizeFilename(metadata.sessionTitle);
    const dateSlug = metadata.exportedAt.slice(0, 10);
    const filename = `tablecodex-${sessionSlug}-${dateSlug}.md`;
    downloadMarkdownFile({ filename, markdown });
    ui?.notifications?.info(`[TableCodex] Session exported: ${filename}`);
  } catch (err) {
    logger.error("Export failed:", err);
    ui?.notifications?.error("[TableCodex] Export failed. Check the browser console for details.");
  }
}
