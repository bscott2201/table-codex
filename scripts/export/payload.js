// @ts-check
/**
 * @file payload.js
 * Builds the canonical session payload shared by both exporters and the upload
 * queue, and provides a browser file-download helper. The payload always carries
 * the FULL raw event log alongside the derived reconstruction — raw first, so a
 * consumer can recompute reconstruction independently (invariant #2).
 */

import { MODULE_ID, MODULE_VERSION, ENVELOPE_SCHEMA, SETTINGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { eventStore } from "../bus/event-store.js";
import { sessionManager } from "../session/session-manager.js";
import { reconstructionEngine } from "../reconstruction/reconstruction-engine.js";
import { getSetting } from "../core/settings.js";

/**
 * @typedef {Object} SessionPayload
 * @property {object} module
 * @property {object} session
 * @property {import("../bus/event-envelope.js").TelemetryEvent[]} rawEvents
 * @property {object} reconstruction
 */

/**
 * Assemble the full payload from the live store (or a provided event array).
 * @param {import("../bus/event-envelope.js").TelemetryEvent[]} [events]
 * @returns {SessionPayload}
 */
export function buildPayload(events) {
  const rawEvents = events ?? eventStore.getEvents();
  const reconstruction = reconstructionEngine.reconstruct(rawEvents);
  return {
    module: {
      id: MODULE_ID,
      version: MODULE_VERSION,
      envelopeSchema: ENVELOPE_SCHEMA,
      exportedAt: new Date().toISOString(),
    },
    session: {
      ...(sessionManager.meta ?? {}),
      id: reconstruction.sessionId ?? sessionManager.meta?.id ?? null,
      title: sessionManager.meta?.title ?? null,
      campaignId: getSetting(SETTINGS.CAMPAIGN_ID) || null,
      campaignName: getSetting(SETTINGS.CAMPAIGN_NAME) || null,
      worldId: getSetting(SETTINGS.WORLD_ID) || reconstruction.worldId,
      worldName: getSetting(SETTINGS.WORLD_NAME) || null,
    },
    rawEvents, // RAW first — never lose the source of truth
    reconstruction,
  };
}

/** A filesystem-safe base filename for a session. */
export function sessionFilename(payload, ext) {
  const id = payload?.session?.id ?? "session";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `tablecodex-${id}-${stamp}.${ext}`;
}

/**
 * Trigger a browser download. Prefers Foundry's helper, falls back to a Blob
 * anchor so the exporter works regardless of Foundry version namespacing.
 * @param {string} content
 * @param {string} filename
 * @param {string} mime
 */
export function downloadFile(content, filename, mime = "application/json") {
  try {
    const f = globalThis.foundry;
    if (f?.utils?.saveDataToFile) {
      f.utils.saveDataToFile(content, mime, filename);
      return;
    }
    if (typeof globalThis.saveDataToFile === "function") {
      globalThis.saveDataToFile(content, mime, filename);
      return;
    }
    // Plain-DOM fallback.
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    logger.error("export: download failed", err);
    globalThis.ui?.notifications?.error("TableCodex: export download failed (see console).");
  }
}
