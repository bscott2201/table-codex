// @ts-check
/**
 * @file folder-manager.js
 * Phase 3: idempotent Folder creation for the session-prep import (PRD §6.10).
 *
 * Folders are matched on the stable `folderKey` + `planId` flags — NEVER on name
 * (a GM may rename a folder; matching on name would create duplicates). Flags are
 * stored under the module's own scope (MODULE_ID), with values sourced from the
 * export payload's `flags.tablecodex` namespace.
 */

import { MODULE_ID, FLAGS } from "../core/constants.js";
import { logger } from "../core/logger.js";

/** @typedef {{ key:string, name:string, type:"Actor"|"JournalEntry"|"Scene", parentKey?:string }} FoundryFolderDef */

/** Read our planId/folderKey flags off a Folder (raw flag path; no scope warning). */
function folderFlags(folder) {
  return folder?.flags?.[MODULE_ID] ?? {};
}

/**
 * Find an existing import-created folder by stable flags, or create it.
 * @param {FoundryFolderDef} def
 * @param {number} planId
 * @param {string|null} parentId  resolved Foundry id of the parent folder
 * @returns {Promise<string>} the folder's id
 */
export async function findOrCreateFolder(def, planId, parentId) {
  const existing = game.folders?.find(
    (f) =>
      f.type === def.type &&
      folderFlags(f)[FLAGS.FOLDER_KEY] === def.key &&
      folderFlags(f)[FLAGS.PLAN_ID] === planId,
  );

  if (existing) {
    // Keep the parent link fresh but respect a GM rename of the folder itself.
    if (parentId && existing.folder?.id !== parentId) {
      await existing.update({ folder: parentId });
    }
    return existing.id;
  }

  const created = await Folder.create({
    name: def.name,
    type: def.type,
    folder: parentId ?? null,
    flags: { [MODULE_ID]: { [FLAGS.FOLDER_KEY]: def.key, [FLAGS.PLAN_ID]: planId } },
  });
  return created.id;
}

/**
 * Create the full folder hierarchy for a plan, parents before children.
 * @param {FoundryFolderDef[]} folderDefs
 * @param {number} planId
 * @returns {Promise<Map<string,string>>} key → folder id
 */
export async function buildFolders(folderDefs, planId) {
  const idByKey = new Map();
  const remaining = [...folderDefs];
  let guard = remaining.length + 1;

  // Resolve in dependency order: a folder is created once its parent (if any) is.
  while (remaining.length && guard-- > 0) {
    for (let i = remaining.length - 1; i >= 0; i--) {
      const def = remaining[i];
      if (def.parentKey && !idByKey.has(def.parentKey)) continue; // parent not ready
      const parentId = def.parentKey ? idByKey.get(def.parentKey) ?? null : null;
      try {
        const id = await findOrCreateFolder(def, planId, parentId);
        idByKey.set(def.key, id);
      } catch (err) {
        logger.error("folder-manager: failed to create folder", def.key, err);
      }
      remaining.splice(i, 1);
    }
  }

  if (remaining.length) {
    logger.warn("folder-manager: unresolved folders (missing parents?)", remaining.map((f) => f.key));
  }
  logger.debug("folder-manager: built", idByKey.size, "folders");
  return idByKey;
}
