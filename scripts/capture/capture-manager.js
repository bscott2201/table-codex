import { logger } from "../core/logger.js";
import { requireGM } from "../core/permissions.js";
import { getSetting, setSetting } from "../core/settings.js";
import { getFoundryWorldContext } from "../core/foundry-context.js";
import { apiClient } from "../api/api-client.js";
import { eventBuffer } from "./event-buffer.js";
import { appendArchivedEvent, getArchivedEvents, clearArchivedEventsForCapture, getArchivedEventCount } from "./session-archive.js";

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
  async startCapture({ campaignId = "", sessionId = "", sessionTitle = "" } = {}) {
    if (!requireGM("Start Capture")) return;
    if (getSetting("isCapturing")) {
      ui?.notifications?.warn("[TableCodex] Capture is already active.");
      return;
    }

    const world = getFoundryWorldContext();
    const captureMode = getSetting("captureMode") || "standard";
    const apiKey = getSetting("apiKey");

    let captureId;

    if (!apiKey) {
      ui?.notifications?.info("[TableCodex] API key missing. Starting local-only capture for Markdown export.");
      captureId = `local-${safeUuid()}`;
    } else {
      try {
        const resp = await apiClient.startCapture(sessionId, {
          captureMode,
          world,
          campaignId,
          sessionTitle,
        });
        captureId = resp?.captureId ?? `local-${safeUuid()}`;
        ui?.notifications?.info("[TableCodex] Capture started and connected to API.");
      } catch (err) {
        logger.warn("API startCapture failed — falling back to local-only capture:", err);
        ui?.notifications?.warn("[TableCodex] Could not connect to TableCodex API. Starting local-only capture.");
        captureId = `local-${safeUuid()}`;
      }
    }

    await setSetting("campaignId", campaignId);
    await setSetting("sessionId", sessionId);
    await setSetting("sessionTitle", sessionTitle);
    await setSetting("captureId", captureId);
    await setSetting("isCapturing", true);

    eventBuffer.start();

    this.addEvent({
      sourceEventId: `session-started-${captureId}`,
      eventType: "session.started",
      occurredAt: new Date().toISOString(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: null,
      payload: { campaignId, sessionId, sessionTitle, captureMode, world },
      raw: null,
    });

    logger.log(`Capture started. captureId=${captureId}`);
    Hooks.call("tablecodex.captureStarted", { captureId, sessionId, campaignId });
  }

  async stopCapture() {
    if (!requireGM("Stop Capture")) return;
    if (!getSetting("isCapturing")) {
      ui?.notifications?.warn("[TableCodex] No active capture to stop.");
      return;
    }

    this.addEvent({
      sourceEventId: `session-ended-${getSetting("captureId")}`,
      eventType: "session.ended",
      occurredAt: new Date().toISOString(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: null,
      payload: {
        captureId: getSetting("captureId"),
        sessionId: getSetting("sessionId"),
        archivedEventCount: getArchivedEventCount({
          worldId: getFoundryWorldContext().foundryWorldId,
          captureId: getSetting("captureId"),
        }),
      },
      raw: null,
    });

    const apiKey = getSetting("apiKey");
    const sessionId = getSetting("sessionId");
    const captureId = getSetting("captureId");

    if (apiKey && sessionId) {
      try {
        await eventBuffer.flush();
        await apiClient.endCapture(sessionId, {
          captureId,
          eventCount: getArchivedEventCount({
            worldId: getFoundryWorldContext().foundryWorldId,
            captureId,
          }),
        });
      } catch (err) {
        logger.warn("API endCapture failed:", err);
      }
    }

    eventBuffer.stop();
    await setSetting("isCapturing", false);

    logger.log("Capture stopped.");
    ui?.notifications?.info("[TableCodex] Capture stopped. Use the panel to export your session.");
    Hooks.call("tablecodex.captureStopped", { captureId });
  }

  addEvent(event) {
    if (!getSetting("isCapturing")) return;
    // Only the GM client adds events to avoid duplicate sync from multiple connected clients.
    if (!game?.user?.isGM) return;

    const captureId = getSetting("captureId");
    const worldId = getFoundryWorldContext().foundryWorldId;

    const enriched = {
      ...event,
      captureId: captureId || null,
      clientCapturedAt: new Date().toISOString(),
    };

    eventBuffer.add(enriched);
    appendArchivedEvent(enriched, { worldId, captureId });
  }

  async syncNow() {
    if (!requireGM("Sync Now")) return;
    await eventBuffer.flush();
  }

  getStatus() {
    const captureId = getSetting("captureId");
    const worldId = getFoundryWorldContext().foundryWorldId;
    return {
      isCapturing: getSetting("isCapturing") ?? false,
      campaignId: getSetting("campaignId") ?? "",
      sessionId: getSetting("sessionId") ?? "",
      sessionTitle: getSetting("sessionTitle") ?? "",
      captureId: captureId ?? "",
      queuedEventCount: eventBuffer.getQueueCount(),
      archivedEventCount: getArchivedEventCount({ worldId, captureId }),
      captureMode: getSetting("captureMode") ?? "standard",
    };
  }

  exportSessionMarkdown() {
    if (!requireGM("Export Session Markdown")) return;
    // Defer import to avoid circular dependency at module load time.
    import("../export/export-session-dialog.js").then(({ openExportDialog }) => {
      openExportDialog();
    }).catch((err) => {
      logger.error("Failed to open export dialog:", err);
    });
  }

  clearCurrentSessionArchive() {
    if (!requireGM("Clear Session Archive")) return;
    const captureId = getSetting("captureId");
    const worldId = getFoundryWorldContext().foundryWorldId;
    clearArchivedEventsForCapture({ worldId, captureId });
    eventBuffer.clearAllEvents();
    ui?.notifications?.info("[TableCodex] Session archive cleared.");
    Hooks.call("tablecodex.archiveCleared", { captureId });
  }
}

export const captureManager = new CaptureManager();
