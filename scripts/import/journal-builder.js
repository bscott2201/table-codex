// @ts-check
/**
 * @file journal-builder.js
 * Phase 3: create JournalEntry documents from the export payload (PRD §6.8).
 *
 * Ownership is the v1.1 corrected model: a player-visible page uses default 2
 * (OBSERVER); GM-only pages use 0 (NONE). The parent entry is GM-only (0) and the
 * Read Aloud page overrides upward so players see only it.
 *
 * Idempotent: an entry is matched by stable `planId` + `sceneId` flags (never by
 * name). On re-import the entry is updated in place and its pages reconciled.
 */

import { MODULE_ID, FLAGS } from "../core/constants.js";
import { logger } from "../core/logger.js";

/** @typedef {{ name:string, html:string, ownershipDefault:0|2 }} FoundryJournalPage */
/** @typedef {{ name:string, folderKey:string, entryOwnershipDefault:0,
 *   pages:FoundryJournalPage[], flags:{tablecodex:{planId:number, sceneId:string}} }} FoundryJournalDef */

/** HTML page-format code, resilient to const availability across versions. */
function htmlFormat() {
  return foundry?.CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.HTML
    ?? globalThis.CONST?.JOURNAL_ENTRY_PAGE_FORMATS?.HTML
    ?? 1;
}

/** Map a payload page to JournalEntryPage creation data. */
function toPageData(page) {
  return {
    name: page.name,
    type: "text",
    title: { show: true, level: 1 },
    text: { content: page.html ?? "", format: htmlFormat() },
    ownership: { default: page.ownershipDefault },
    // Page-level flags let the reference-linker target the right scene's GM page
    // and the scene-builder link a Scene to its read-aloud page.
    ...(page.sceneId || page.kind
      ? { flags: { [MODULE_ID]: {
          ...(page.sceneId ? { [FLAGS.SCENE_ID]: page.sceneId } : {}),
          ...(page.kind ? { kind: page.kind } : {}),
        } } }
      : {}),
  };
}

function entryFlags(entry) {
  return entry?.flags?.[MODULE_ID] ?? {};
}

/** Find the single import-created session journal for this plan. */
function findExistingJournal(planId) {
  return game.journal?.find((j) => entryFlags(j)[FLAGS.PLAN_ID] === planId);
}

/**
 * Create or update the session's JournalEntry (one entry, many pages).
 * @param {FoundryJournalDef} def
 * @param {number} planId
 * @param {string|null} folderId
 * @returns {Promise<{ id:string, created:boolean }>}
 */
export async function upsertJournal(def, planId, folderId) {
  const pages = (def.pages ?? []).map(toPageData);
  const flags = {
    [MODULE_ID]: {
      [FLAGS.PLAN_ID]: planId,
      [FLAGS.IMPORTED_AT]: Date.now(),
    },
  };

  const existing = findExistingJournal(planId);
  if (existing) {
    await existing.update({
      name: def.name,
      ...(folderId ? { folder: folderId } : {}),
      ownership: { default: def.entryOwnershipDefault },
      flags,
    });
    // Reconcile pages: delete the old set, recreate from the payload so content
    // (and ownership) always matches the latest plan.
    const oldIds = existing.pages?.map((p) => p.id) ?? [];
    if (oldIds.length) await existing.deleteEmbeddedDocuments("JournalEntryPage", oldIds);
    if (pages.length) await existing.createEmbeddedDocuments("JournalEntryPage", pages);
    return { id: existing.id, created: false };
  }

  const created = await JournalEntry.create({
    name: def.name,
    folder: folderId ?? null,
    ownership: { default: def.entryOwnershipDefault },
    pages,
    flags,
  });
  return { id: created.id, created: true };
}

/**
 * Build all journals for a plan.
 * @param {FoundryJournalDef[]} journalDefs
 * @param {Map<string,string>} folderIdByKey
 * @param {number} planId
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<{ created:number, updated:number, ids:string[] }>}
 */
export async function buildJournals(journalDefs, folderIdByKey, planId, onProgress) {
  let created = 0;
  let updated = 0;
  const ids = [];
  const total = journalDefs.length;

  for (let i = 0; i < total; i++) {
    const def = journalDefs[i];
    const folderId = folderIdByKey.get(def.folderKey) ?? null;
    try {
      const res = await upsertJournal(def, planId, folderId);
      ids.push(res.id);
      if (res.created) created++;
      else updated++;
    } catch (err) {
      logger.error("journal-builder: failed on", def.name, err);
    }
    onProgress?.(i + 1, total);
  }

  logger.info(`journal-builder: ${created} created, ${updated} updated`);
  return { created, updated, ids };
}
