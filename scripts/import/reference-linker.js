// @ts-check
/**
 * @file reference-linker.js
 * Phase 4 second pass (PRD §6.4): now that Actor documents exist, rewrite the
 * GM Notes journal pages (created in Phase 3, before actor ids were known) to
 * embed @UUID links to each scene's enemy actors — so the GM can drag a linked
 * combatant straight from the prep notes onto the canvas / combat tracker.
 *
 * Enemy actors carry their scene's sceneId flag, which matches the journal's
 * sceneId flag. For each match we link the actor name inline where it appears,
 * and guarantee reachability by appending a "Combatants" line of any names not
 * found in the prose.
 */

import { MODULE_ID, FLAGS } from "../core/constants.js";
import { logger } from "../core/logger.js";

const uuidFor = (id, name) => `@UUID[Actor.${id}]{${name}}`;

/**
 * @param {object} payload  FoundryExportPayload (for actor name ↔ sceneId)
 * @param {Map<string,string>} idByName  lowercased name → actor id
 * @param {number} planId
 * @returns {Promise<{ linked:number }>}
 */
export async function linkActorReferences(payload, idByName, planId) {
  // sceneId → [{ name, id }]
  const bySceneId = new Map();
  for (const a of payload.actors ?? []) {
    const sceneId = a.flags?.tablecodex?.sceneId;
    const id = idByName.get(a.name.toLowerCase());
    if (!sceneId || !id) continue; // NPC actors have no sceneId — skip
    const list = bySceneId.get(sceneId) ?? [];
    list.push({ name: a.name, id });
    bySceneId.set(sceneId, list);
  }
  if (!bySceneId.size) return { linked: 0 };

  // One session journal per plan; the per-scene GM Notes pages carry a sceneId flag.
  const journal = game.journal?.find((j) => j.flags?.[MODULE_ID]?.[FLAGS.PLAN_ID] === planId);
  if (!journal) return { linked: 0 };

  let linked = 0;
  for (const page of journal.pages ?? []) {
    const pf = page.flags?.[MODULE_ID];
    if (!pf || pf.kind !== "gm") continue;
    const refs = bySceneId.get(pf[FLAGS.SCENE_ID]);
    if (!refs?.length) continue;

    let html = page.text?.content ?? "";
    let changed = false;
    const leftover = [];

    for (const { name, id } of refs) {
      const link = uuidFor(id, name);
      if (html.includes(link)) continue; // already linked (idempotent re-run)
      const idx = html.indexOf(name);
      if (idx !== -1) {
        html = html.slice(0, idx) + link + html.slice(idx + name.length);
        changed = true;
        linked++;
      } else {
        leftover.push(link);
      }
    }

    if (leftover.length) {
      html += `<h3>Combatants</h3><p>${leftover.join(", ")}</p>`;
      changed = true;
      linked += leftover.length;
    }

    if (changed) {
      try {
        await page.update({ text: { content: html } });
      } catch (err) {
        logger.warn("reference-linker: failed to update page for", page.name, err);
      }
    }
  }

  logger.info(`reference-linker: linked ${linked} actor reference(s)`);
  return { linked };
}
