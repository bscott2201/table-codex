/**
 * Persistent storage for unsynced session records.
 * Each record holds the full normalizedPayload so retry/force-sync can work
 * after a Foundry reload without any in-memory state.
 */

import { getSetting, setSetting } from "./settings.js";
import { log, debug } from "./logger.js";

const KEY = "unsyncedSessions";

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export function getUnsyncedSessions() {
  const raw = getSetting(KEY);
  return Array.isArray(raw) ? raw : [];
}

// Sessions the GM still needs to act on.
export function getPendingSessions() {
  return getUnsyncedSessions().filter(
    (s) => s.status === "unsynced" || s.status === "sync_failed" || s.status === "sync_pending"
  );
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

export async function saveUnsyncedSession(record) {
  if (!record?.localSessionId) {
    log("saveUnsyncedSession: record missing localSessionId — skipping.");
    return;
  }

  const all = getUnsyncedSessions();
  const idx = all.findIndex((s) => s.localSessionId === record.localSessionId);

  if (idx >= 0) {
    all[idx] = { ...all[idx], ...record };
  } else {
    all.push(record);
  }

  await setSetting(KEY, all);
  debug(`Session store: saved ${record.localSessionId} (status: ${record.status ?? "?"})`);
}

export async function markSessionPending(localSessionId) {
  await _update(localSessionId, { status: "sync_pending" });
}

export async function markSessionSynced(localSessionId, remoteImportId) {
  await _update(localSessionId, {
    status: "synced",
    remoteImportId,
    lastSyncAttemptAt: new Date().toISOString(),
    lastSyncError: null,
  });
  log(`Session store: ${localSessionId} → synced (importId: ${remoteImportId})`);
}

export async function markSessionFailed(localSessionId, error) {
  const all = getUnsyncedSessions();
  const rec = all.find((s) => s.localSessionId === localSessionId);
  if (!rec) {
    log(`markSessionFailed: ${localSessionId} not found — skipping.`);
    return;
  }
  rec.status          = "sync_failed";
  rec.lastSyncAttemptAt = new Date().toISOString();
  rec.lastSyncError   = typeof error === "string" ? error : (error?.message ?? String(error));
  rec.attemptCount    = (rec.attemptCount ?? 0) + 1;
  await setSetting(KEY, all);
  log(`Session store: ${localSessionId} → sync_failed (attempt ${rec.attemptCount}): ${rec.lastSyncError}`);
}

export async function archiveSession(localSessionId) {
  await _update(localSessionId, { status: "archived" });
  log(`Session store: ${localSessionId} → archived`);
}

// Overwrite the stored normalizedPayload for an existing record.
// Used when force-sync rebuilds the payload with injected fields.
export async function updateSessionPayload(localSessionId, normalizedPayload) {
  await _update(localSessionId, { normalizedPayload });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function _update(localSessionId, patch) {
  const all = getUnsyncedSessions();
  const idx = all.findIndex((s) => s.localSessionId === localSessionId);
  if (idx < 0) return;
  all[idx] = { ...all[idx], ...patch };
  await setSetting(KEY, all);
}
