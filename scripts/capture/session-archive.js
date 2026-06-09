import { getJson, setJson } from "../core/storage.js";
import { logger } from "../core/logger.js";

export function getArchiveKey({ worldId, captureId } = {}) {
  const w = worldId || "unknown-world";
  const c = captureId || "manual-unsynced";
  return `tablecodex.sessionArchive.${w}.${c}`;
}

export function appendArchivedEvent(event, { worldId, captureId } = {}) {
  const key = getArchiveKey({ worldId, captureId });
  try {
    const existing = getJson(key, []);
    existing.push(event);
    setJson(key, existing);
  } catch (err) {
    logger.error("Failed to archive event:", err);
    ui?.notifications?.warn("[TableCodex] Could not write to session archive. Storage may be full.");
  }
}

export function getArchivedEvents({ worldId, captureId } = {}) {
  const key = getArchiveKey({ worldId, captureId });
  return getJson(key, []);
}

// Archive cleanup should later be handled by explicit user action (e.g. a "Clear Archive" button
// in the panel). Do NOT auto-clear on capture end — the GM may want to export after stopping.
export function clearArchivedEventsForCapture({ worldId, captureId } = {}) {
  const key = getArchiveKey({ worldId, captureId });
  try {
    setJson(key, []);
  } catch (err) {
    logger.error("Failed to clear session archive:", err);
    ui?.notifications?.warn("[TableCodex] Could not clear session archive.");
  }
}

export function getArchivedEventCount({ worldId, captureId } = {}) {
  return getArchivedEvents({ worldId, captureId }).length;
}
