// @ts-check
/**
 * @file import-manager.js
 * Phase 3: orchestrates a session-prep import (PRD §6.4). Runs builders in
 * sequence and emits progress events that the ImportDialog listens to.
 *
 * Stages (Phase 3): folders → journals → done. Actors (Phase 4) and scenes
 * (Phase 6) are declared as pending stages and skipped for now, so the dialog's
 * stage list is stable as later phases land.
 *
 * Events (CustomEvent on this EventTarget):
 *   "stage"    detail: { stage, label, index, total }
 *   "progress" detail: { stage, done, total }
 *   "done"     detail: { folderId, journals:{created,updated}, sceneFolderId }
 *   "error"    detail: { message }
 */

import { logger } from "../core/logger.js";
import { buildFolders } from "./folder-manager.js";
import { buildJournals } from "./journal-builder.js";
import { buildActors } from "./actor-builder.js";
import { linkActorReferences } from "./reference-linker.js";
import { buildScenes } from "./scene-builder.js";

/** Ordered stages. `run` flags which are active this phase. */
export const IMPORT_STAGES = [
  { key: "folders", label: "Creating folders" },
  { key: "journals", label: "Creating journals" },
  { key: "actors", label: "Creating actors" },
  { key: "scenes", label: "Creating scenes" },
  { key: "finalize", label: "Finalizing" },
];

export class ImportManager extends EventTarget {
  /** @param {object} payload  FoundryExportPayload from the server */
  constructor(payload) {
    super();
    this.payload = payload;
    this.planId = payload?.meta?.planId;
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _stage(key, index) {
    const s = IMPORT_STAGES.find((x) => x.key === key);
    this._emit("stage", { stage: key, label: s?.label ?? key, index, total: IMPORT_STAGES.length });
  }

  /**
   * Run the import. Options gate which document kinds are created (journals are
   * the only kind implemented this phase).
   * @param {{ journals?:boolean, actors?:boolean, scenes?:boolean }} [options]
   */
  async run(options = {}) {
    const opts = { journals: true, actors: true, scenes: false, ...options };
    try {
      if (!this.planId) throw new Error("export payload has no plan id");

      // 1. Folders
      this._stage("folders", 0);
      const folderIds = await buildFolders(this.payload.folders ?? [], this.planId);

      // 2. Journals (created before actors; actor @UUID links are filled in below)
      let journalResult = { created: 0, updated: 0, ids: [] };
      if (opts.journals) {
        this._stage("journals", 1);
        journalResult = await buildJournals(
          this.payload.journals ?? [],
          folderIds,
          this.planId,
          (done, total) => this._emit("progress", { stage: "journals", done, total }),
        );
      }

      // 3. Actors, then the @UUID second pass into the GM Notes journals.
      let actorResult = { created: 0, updated: 0, idByName: new Map() };
      if (opts.actors) {
        this._stage("actors", 2);
        actorResult = await buildActors(
          this.payload.actors ?? [],
          folderIds,
          this.planId,
          (done, total) => this._emit("progress", { stage: "actors", done, total }),
        );
        if (actorResult.idByName.size) {
          await linkActorReferences(this.payload, actorResult.idByName, this.planId);
        }
      }

      // 4. Scenes — placeholder scenes with map backgrounds + journal links.
      let sceneResult = { created: 0, updated: 0 };
      if (opts.scenes) {
        this._stage("scenes", 3);
        sceneResult = await buildScenes(
          this.payload.scenes ?? [],
          folderIds,
          this.planId,
          (done, total) => this._emit("progress", { stage: "scenes", done, total }),
        );
      }

      this._stage("finalize", 4);
      const result = {
        folderId: folderIds.get("journals-root") ?? null,
        journals: { created: journalResult.created, updated: journalResult.updated },
        actors: { created: actorResult.created, updated: actorResult.updated },
        scenes: { created: sceneResult.created, updated: sceneResult.updated },
      };
      this._emit("done", result);
      logger.info("import-manager: import complete", result);
      return result;
    } catch (err) {
      const message = String(err?.message ?? err);
      logger.error("import-manager: import failed", err);
      this._emit("error", { message });
      throw err;
    }
  }
}

/** Convenience: run an import and return its result. */
export async function orchestrateImport(payload, options) {
  return new ImportManager(payload).run(options);
}
