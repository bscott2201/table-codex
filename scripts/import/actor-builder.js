// @ts-check
/**
 * @file actor-builder.js
 * Phase 4: create dnd5e Actor documents from the export payload (PRD §6.4).
 *
 *   - NPC actors  (statblock === null) → biography only.
 *   - Enemy actors (statblock present) → full dnd5e v5 system data + items via
 *     statblock-mapper; enemies with only ac/hp fall back to a minimal sheet.
 *
 * Idempotent: an actor is matched by stable `planId` flag + name (never created
 * twice). Document creation runs with bounded concurrency (pooledMap, max 3) to
 * avoid saturating Foundry's socket queue on large plans (PRD §8.2).
 *
 * Returns a name→actorId map so the reference-linker can rewrite @UUID links into
 * the GM Notes journals created in Phase 3.
 */

import { MODULE_ID, FLAGS } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { mapToFoundrySystem } from "./statblock-mapper.js";

/** Run `fn` over `items` with at most `limit` in flight at once. */
export async function pooledMap(limit, items, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

function actorFlags(actor) {
  return actor?.flags?.[MODULE_ID] ?? {};
}

function findExistingActor(planId, name) {
  const lower = name.toLowerCase();
  return game.actors?.find(
    (a) => actorFlags(a)[FLAGS.PLAN_ID] === planId && a.name?.toLowerCase() === lower,
  );
}

/** Minimal system data for an actor we only have ac/hp for (no full stat block). */
function fallbackSystem(fallback, biographyHtml) {
  const ac = fallback?.ac;
  const hp = fallback?.hp;
  return {
    attributes: {
      ...(ac != null ? { ac: { flat: ac, calc: "flat", formula: "" } } : {}),
      ...(hp != null ? { hp: { value: hp, max: hp, temp: 0, tempmax: 0, formula: "" } } : {}),
    },
    details: { biography: { value: biographyHtml ?? "", public: "" } },
  };
}

/** Build Actor.create data + the embedded items for one actor def. */
function toActorData(def, folderId, planId) {
  let system;
  let items = [];
  if (def.statblock) {
    const mapped = mapToFoundrySystem(def.statblock, def.biography ?? "");
    system = mapped.system;
    items = mapped.items;
  } else if (def.fallback) {
    system = fallbackSystem(def.fallback, def.biography ?? "");
  } else {
    system = { details: { biography: { value: def.biography ?? "", public: "" } } };
  }
  const sceneId = def.flags?.tablecodex?.sceneId;
  return {
    name: def.name,
    type: "npc",
    folder: folderId ?? null,
    system,
    items,
    flags: {
      [MODULE_ID]: {
        [FLAGS.PLAN_ID]: planId,
        ...(sceneId ? { [FLAGS.SCENE_ID]: sceneId } : {}),
        [FLAGS.IMPORTED_AT]: Date.now(),
      },
    },
  };
}

/**
 * Create or update one actor.
 * @returns {Promise<{ id:string, name:string, created:boolean }|null>}
 */
async function upsertActor(def, planId, folderId) {
  try {
    const data = toActorData(def, folderId, planId);
    const existing = findExistingActor(planId, def.name);
    if (existing) {
      const { items, ...rest } = data;
      await existing.update(rest);
      const oldIds = existing.items?.map((it) => it.id) ?? [];
      if (oldIds.length) await existing.deleteEmbeddedDocuments("Item", oldIds);
      if (items.length) await existing.createEmbeddedDocuments("Item", items);
      return { id: existing.id, name: def.name, created: false };
    }
    const created = await Actor.create(data);
    return { id: created.id, name: def.name, created: true };
  } catch (err) {
    logger.error("actor-builder: failed on", def.name, err);
    return null;
  }
}

/**
 * Build all actors for a plan.
 * @param {object[]} actorDefs  payload.actors
 * @param {Map<string,string>} folderIdByKey
 * @param {number} planId
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<{ created:number, updated:number, idByName:Map<string,string> }>}
 */
export async function buildActors(actorDefs, folderIdByKey, planId, onProgress) {
  let created = 0;
  let updated = 0;
  let done = 0;
  const idByName = new Map();
  const total = actorDefs.length;

  await pooledMap(3, actorDefs, async (def) => {
    const folderId = folderIdByKey.get(def.folderKey) ?? null;
    const res = await upsertActor(def, planId, folderId);
    if (res) {
      idByName.set(def.name.toLowerCase(), res.id);
      if (res.created) created++;
      else updated++;
    }
    onProgress?.(++done, total);
  });

  logger.info(`actor-builder: ${created} created, ${updated} updated`);
  return { created, updated, idByName };
}
