import { logger } from "../core/logger.js";
import { requireGM } from "../core/permissions.js";
import { getSetting, setSetting } from "../core/settings.js";
import { getFoundryWorldContext } from "../core/foundry-context.js";
import { apiClient } from "../api/api-client.js";
import { eventBuffer } from "./event-buffer.js";
import {
  appendArchivedEvent,
  getArchivedEvents,
  clearArchivedEventsForSession,
  getArchivedEventCount,
} from "./session-archive.js";

function safeUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

class CaptureManager {
  async startCapture({ campaignId = "", sessionTitle = "" } = {}) {
    if (!requireGM("Start Capture")) return;
    if (getSetting("isCapturing")) {
      ui?.notifications?.warn("[TableCodex] Capture is already active.");
      return;
    }

    const world = getFoundryWorldContext();
    const captureMode = getSetting("captureMode") || "standard";
    const apiKey = getSetting("apiKey");

    let sessionId;

    if (!apiKey || !campaignId) {
      ui?.notifications?.info("[TableCodex] API key or campaign ID missing. Starting local-only capture.");
      sessionId = `local-${safeUuid()}`;
    } else {
      try {
        // Determine next session number from existing sessions.
        let sessionNumber = 1;
        try {
          const sessions = await apiClient.getSessions(campaignId);
          sessionNumber = Array.isArray(sessions) ? sessions.length + 1 : 1;
        } catch {
          // Non-fatal — session number defaults to 1.
        }

        const session = await apiClient.createSession(campaignId, {
          title: sessionTitle,
          sessionNumber,
        });
        sessionId = String(session.id);
        ui?.notifications?.info(`[TableCodex] Session "${sessionTitle}" created (Session ${sessionNumber}).`);
      } catch (err) {
        logger.warn("API createSession failed — falling back to local-only capture:", err);
        ui?.notifications?.warn("[TableCodex] Could not create session via API. Starting local-only capture.");
        sessionId = `local-${safeUuid()}`;
      }
    }

    await setSetting("campaignId", campaignId);
    await setSetting("sessionId", sessionId);
    await setSetting("sessionTitle", sessionTitle);
    await setSetting("isCapturing", true);

    eventBuffer.start();

    this.addEvent({
      sourceEventId: `session-started-${sessionId}`,
      eventType: "session.started",
      occurredAt: new Date().toISOString(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: null,
      payload: { campaignId, sessionId, sessionTitle, captureMode, world },
      raw: null,
    });

    logger.log(`Capture started. sessionId=${sessionId}`);
    Hooks.call("tablecodex.captureStarted", { sessionId, campaignId });
  }

  async stopCapture() {
    if (!requireGM("Stop Capture")) return;
    if (!getSetting("isCapturing")) {
      ui?.notifications?.warn("[TableCodex] No active capture to stop.");
      return;
    }

    const sessionId = getSetting("sessionId");
    const worldId = getFoundryWorldContext().foundryWorldId;

    this.addEvent({
      sourceEventId: `session-ended-${sessionId}`,
      eventType: "session.ended",
      occurredAt: new Date().toISOString(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: null,
      payload: {
        sessionId,
        archivedEventCount: getArchivedEventCount({ worldId, sessionId }),
      },
      raw: null,
    });

    const apiKey = getSetting("apiKey");
    const campaignId = getSetting("campaignId");

    if (apiKey && campaignId && sessionId && !sessionId.startsWith("local-")) {
      try {
        await eventBuffer.flush();
      } catch (err) {
        logger.warn("Final flush failed on stop:", err);
      }
    }

    eventBuffer.stop();
    await setSetting("isCapturing", false);

    logger.log("Capture stopped.");
    ui?.notifications?.info("[TableCodex] Session capture stopped. Use the panel to export.");
    Hooks.call("tablecodex.captureStopped", { sessionId });
  }

  addEvent(event) {
    if (!getSetting("isCapturing")) return;
    if (!game?.user?.isGM) return;

    const sessionId = getSetting("sessionId");
    const worldId = getFoundryWorldContext().foundryWorldId;

    const enriched = {
      ...event,
      sessionId: sessionId || null,
      clientCapturedAt: new Date().toISOString(),
    };

    eventBuffer.add(enriched);
    appendArchivedEvent(enriched, { worldId, sessionId });
  }

  async syncNow() {
    if (!requireGM("Sync Now")) return;
    await eventBuffer.flush();
  }

  getStatus() {
    const sessionId = getSetting("sessionId");
    const worldId = getFoundryWorldContext().foundryWorldId;
    return {
      isCapturing: getSetting("isCapturing") ?? false,
      campaignId: getSetting("campaignId") ?? "",
      sessionId: sessionId ?? "",
      sessionTitle: getSetting("sessionTitle") ?? "",
      queuedEventCount: eventBuffer.getQueueCount(),
      archivedEventCount: getArchivedEventCount({ worldId, sessionId }),
      captureMode: getSetting("captureMode") ?? "standard",
    };
  }

  exportSessionMarkdown() {
    if (!requireGM("Export Session Markdown")) return;
    import("../export/export-session-dialog.js").then(({ openExportDialog }) => {
      openExportDialog();
    }).catch((err) => {
      logger.error("Failed to open export dialog:", err);
    });
  }

  clearCurrentSessionArchive() {
    if (!requireGM("Clear Session Archive")) return;
    const sessionId = getSetting("sessionId");
    const worldId = getFoundryWorldContext().foundryWorldId;
    clearArchivedEventsForSession({ worldId, sessionId });
    eventBuffer.clearAllEvents();
    ui?.notifications?.info("[TableCodex] Session archive cleared.");
    Hooks.call("tablecodex.archiveCleared", { sessionId });
  }
}

export const captureManager = new CaptureManager();
