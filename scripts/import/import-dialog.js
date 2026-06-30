// @ts-check
/**
 * @file import-dialog.js
 * Phase 3: the session-prep import dialog (PRD F5.2). An ApplicationV2 that
 * fetches the export payload, runs the ImportManager, and shows live stage
 * progress. On completion it notifies and offers to open the Journal sidebar.
 *
 * Fetching the payload happens on "Start import" (not on open), because fetching
 * stamps the plan as exported server-side.
 */

import { MODULE_ID } from "../core/constants.js";
import { logger } from "../core/logger.js";
import { getSessionPlan } from "./plan-fetcher.js";
import { ImportManager, IMPORT_STAGES } from "./import-manager.js";

/** @type {any} */
let _DialogClass = null;

function getDialogClass() {
  if (_DialogClass) return _DialogClass;
  const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

  class ImportDialog extends HandlebarsApplicationMixin(ApplicationV2) {
    /** @type {number|string|null} */ _planId = null;
    /** @type {string} */ _planTitle = "";
    /** @type {"idle"|"running"|"done"|"error"} */ _phase = "idle";
    /** @type {{journals:boolean, actors:boolean}} */ _options = { journals: true, actors: true };
    /** @type {Record<string,"pending"|"active"|"done">} */ _stageState = {};
    /** @type {{done:number,total:number}|null} */ _progress = null;
    /** @type {string|null} */ _error = null;
    /** @type {{created:number,updated:number}|null} */ _result = null;

    static DEFAULT_OPTIONS = {
      id: "tablecodex-import-dialog",
      tag: "div",
      window: { title: "Import Session Prep", icon: "fa-solid fa-file-import", resizable: true },
      position: { width: 460, height: "auto" },
      actions: {
        startImport: ImportDialog._onStart,
        openJournals: ImportDialog._onOpenJournals,
        closeDialog: ImportDialog._onClose,
      },
    };

    static PARTS = {
      body: { template: `modules/${MODULE_ID}/templates/import-dialog.hbs` },
    };

    /** @override */
    async _prepareContext() {
      const stages = IMPORT_STAGES.map((s) => {
        const state = s.pending ? "skip" : (this._stageState[s.key] ?? "pending");
        return {
          key: s.key,
          label: s.label,
          pending: !!s.pending,
          isDone: state === "done",
          isActive: state === "active",
          isSkip: state === "skip",
          isPending: state === "pending",
        };
      });
      const pct = this._progress && this._progress.total
        ? Math.round((this._progress.done / this._progress.total) * 100)
        : (this._phase === "done" ? 100 : 0);
      return {
        planTitle: this._planTitle,
        phase: this._phase,
        idle: this._phase === "idle",
        running: this._phase === "running",
        done: this._phase === "done",
        errored: this._phase === "error",
        error: this._error,
        result: this._result
          ? {
              journalsNew: this._result.journals?.created ?? 0,
              journalsUpd: this._result.journals?.updated ?? 0,
              actorsNew: this._result.actors?.created ?? 0,
              actorsUpd: this._result.actors?.updated ?? 0,
            }
          : null,
        stages,
        pct,
      };
    }

    /** @this {any} Start the import: fetch payload, then run the manager. */
    static async _onStart() {
      if (this._phase === "running") return;
      this._phase = "running";
      this._error = null;
      this._stageState = {};
      this._progress = null;
      this.render();

      const fetched = await getSessionPlan(this._planId);
      if (!fetched.ok) {
        this._phase = "error";
        this._error = fetched.error ?? "Failed to fetch the session plan.";
        ui.notifications?.error(`TableCodex: ${this._error}`);
        this.render();
        return;
      }

      const manager = new ImportManager(fetched.data);
      manager.addEventListener("stage", (/** @type {any} */ e) => {
        const { stage } = e.detail;
        // Mark prior active stages done, current active.
        for (const s of IMPORT_STAGES) {
          if (s.key === stage) this._stageState[s.key] = "active";
          else if (this._stageState[s.key] === "active") this._stageState[s.key] = "done";
        }
        this._progress = null;
        this.render();
      });
      manager.addEventListener("progress", (/** @type {any} */ e) => {
        this._progress = { done: e.detail.done, total: e.detail.total };
        this.render();
      });

      try {
        const result = await manager.run(this._options);
        for (const key of Object.keys(this._stageState)) {
          if (this._stageState[key] === "active") this._stageState[key] = "done";
        }
        this._phase = "done";
        this._result = { journals: result.journals, actors: result.actors };
        const j = result.journals.created + result.journals.updated;
        const a = (result.actors?.created ?? 0) + (result.actors?.updated ?? 0);
        ui.notifications?.info(
          `TableCodex: imported “${this._planTitle}” — ${j} journal(s), ${a} actor(s).`,
        );
        this.render();
      } catch (err) {
        this._phase = "error";
        this._error = String(err?.message ?? err);
        this.render();
      }
    }

    /** @this {any} */
    static _onOpenJournals() {
      try {
        ui.sidebar?.activateTab?.("journal");
      } catch (err) {
        logger.warn("import-dialog: could not open journal sidebar", err);
      }
    }

    /** @this {any} */
    static _onClose() {
      this.close();
    }
  }

  _DialogClass = ImportDialog;
  return _DialogClass;
}

/**
 * Open the import dialog for a given plan.
 * @param {{ planId:number|string, planTitle?:string }} args
 */
export function openImportDialog({ planId, planTitle }) {
  try {
    const Cls = getDialogClass();
    const dlg = new Cls();
    dlg._planId = planId;
    dlg._planTitle = planTitle ?? `Plan ${planId}`;
    dlg.render(true);
    return dlg;
  } catch (err) {
    logger.error("import-dialog: failed to open", err);
    ui.notifications?.error("TableCodex: failed to open import dialog (see console).");
    return null;
  }
}
