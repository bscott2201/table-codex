import { getJson, setJson } from "../core/storage.js";
import { logger } from "../core/logger.js";

export function getArchiveKey({ worldId, sessionId } = {}) {
  const w = worldId || "unknown-world";
  const s = sessionId || "manual-unsynced";
  return `tablecodex.sessionArchive.${w}.${s}`;
}

export function appendArchivedEvent(event, { worldId, sessionId } = {}) {
  const key = getArchiveKey({ worldId, sessionId });
  try {
    const existing = getJson(key, []);
    existing.push(event);
    setJson(key, existing);
  } catch (err) {
    logger.error("Failed to archive event:", err);
    ui?.notifications?.warn("[TableCodex] Could not write to session archive. Storage may be full.");
  }
}

export function getArchivedEvents({ worldId, sessionId } = {}) {
  const key = getArchiveKey({ worldId, sessionId });
  return getJson(key, []);
}

export function clearArchivedEventsForSession({ worldId, sessionId } = {}) {
  const key = getArchiveKey({ worldId, sessionId });
  try {
    setJson(key, []);
  } catch (err) {
    logger.error("Failed to clear session archive:", err);
    ui?.notifications?.warn("[TableCodex] Could not clear session archive.");
  }
}

export function getArchivedEventCount({ worldId, sessionId } = {}) {
  return getArchivedEvents({ worldId, sessionId }).length;
}
