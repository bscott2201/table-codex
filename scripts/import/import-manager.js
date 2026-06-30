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

/** Ordered stages. `run` flags which are active this phase. */
export const IMPORT_STAGES = [
  { key: "folders", label: "Creating folders" },
  { key: "journals", label: "Creating journals" },
  { key: "actors", label: "Creating actors", pending: true }, // Phase 4
  { key: "scenes", label: "Creating scenes", pending: true }, // Phase 6
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
    const opts = { journals: true, actors: false, scenes: false, ...options };
    try {
      if (!this.planId) throw new Error("export payload has no plan id");

      // 1. Folders
      this._stage("folders", 0);
      const folderIds = await buildFolders(this.payload.folders ?? [], this.planId);

      // 2. Journals
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

      // 3/4. Actors (Phase 4) and Scenes (Phase 6) — not yet implemented.
      if (opts.actors) logger.info("import-manager: actor import not available until Phase 4");
      if (opts.scenes) logger.info("import-manager: scene import not available until Phase 6");

      this._stage("finalize", 4);
      const result = {
        folderId: folderIds.get("journals-root") ?? null,
        journals: { created: journalResult.created, updated: journalResult.updated },
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
