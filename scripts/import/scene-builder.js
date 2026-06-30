// @ts-check
/**
 * @file scene-builder.js
 * Phase 6: create Foundry Scene documents from the export payload (PRD §6.4).
 *
 * Each planned scene becomes a placeholder Scene: a battle-map background (when
 * one was generated) and a `journal` link to that scene's narrative JournalEntry
 * (created in Phase 3), so activating the scene shows the prep notes in the
 * sidebar. Walls/lighting/grid-tile editing are out of scope (PRD §3.2) — these
 * are background-only scenes.
 *
 * Idempotent: matched by stable `planId` + `sceneId` flags (never by name).
 */

import { MODULE_ID, FLAGS, SETTINGS } from "../core/constants.js";
import { getSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

const DEFAULT_GRID = 100; // px per square — placeholder; GM re-aligns to taste.

/** Resolve a possibly-relative storage URL against the configured API base. */
function resolveSrc(src) {
  if (!src) return null;
  if (/^https?:\/\//i.test(src)) return src;
  const base = (getSetting(SETTINGS.API_URL) || "").trim().replace(/\/+$/, "");
  return base ? `${base}${src.startsWith("/") ? "" : "/"}${src}` : src;
}

function sceneFlags(scene) {
  return scene?.flags?.[MODULE_ID] ?? {};
}

/** The single session JournalEntry for this plan. */
function findSessionJournal(planId) {
  return game.journal?.find((j) => j.flags?.[MODULE_ID]?.[FLAGS.PLAN_ID] === planId);
}

/** The read-aloud page within the session journal for a given scene. */
function findReadAloudPage(journal, sceneKey) {
  return journal?.pages?.find(
    (p) => p.flags?.[MODULE_ID]?.[FLAGS.SCENE_ID] === sceneKey && p.flags?.[MODULE_ID]?.kind === "read-aloud",
  );
}

/** Build Scene.create data for one scene def. */
function toSceneData(def, planId, folderId) {
  const src = resolveSrc(def.backgroundSrc);
  const journal = findSessionJournal(planId);
  const page = findReadAloudPage(journal, def.journalSceneKey);
  return {
    name: def.name,
    folder: folderId ?? null,
    ...(src ? { background: { src }, width: 1536, height: 1024 } : {}),
    grid: { size: DEFAULT_GRID },
    // Link the scene to the session journal, and to this scene's read-aloud page.
    ...(journal ? { journal: journal.id } : {}),
    ...(page ? { journalEntryPage: page.id } : {}),
    flags: {
      [MODULE_ID]: {
        [FLAGS.PLAN_ID]: planId,
        [FLAGS.SCENE_ID]: def.flags?.tablecodex?.sceneId,
        [FLAGS.IMPORTED_AT]: Date.now(),
      },
    },
  };
}

async function upsertScene(def, planId, folderId) {
  const sceneId = def.flags?.tablecodex?.sceneId;
  const data = toSceneData(def, planId, folderId);
  const existing = game.scenes?.find(
    (s) => sceneFlags(s)[FLAGS.PLAN_ID] === planId && sceneFlags(s)[FLAGS.SCENE_ID] === sceneId,
  );
  if (existing) {
    await existing.update(data);
    return { id: existing.id, created: false };
  }
  const created = await Scene.create(data);
  return { id: created.id, created: true };
}

/**
 * Build all scenes for a plan.
 * @param {object[]} sceneDefs  payload.scenes
 * @param {Map<string,string>} folderIdByKey
 * @param {number} planId
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{ created:number, updated:number }>}
 */
export async function buildScenes(sceneDefs, folderIdByKey, planId, onProgress) {
  let created = 0;
  let updated = 0;
  const total = sceneDefs.length;

  for (let i = 0; i < total; i++) {
    const def = sceneDefs[i];
    const folderId = folderIdByKey.get(def.folderKey) ?? null;
    try {
      const res = await upsertScene(def, planId, folderId);
      if (res.created) created++;
      else updated++;
    } catch (err) {
      logger.error("scene-builder: failed on", def.name, err);
    }
    onProgress?.(i + 1, total);
  }

  logger.info(`scene-builder: ${created} created, ${updated} updated`);
  return { created, updated };
}
