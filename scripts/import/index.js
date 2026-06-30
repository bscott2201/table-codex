// @ts-check
/**
 * @file index.js
 * Barrel for the session-prep import modules (PRD §6.4). Phase 2 ships the plan
 * fetcher; folder/journal/actor builders and the orchestrator arrive in later
 * phases.
 */

export { listSessionPlans, getSessionPlan, SUPPORTED_PAYLOAD_VERSION } from "./plan-fetcher.js";
export { buildFolders, findOrCreateFolder } from "./folder-manager.js";
export { buildJournals, upsertJournal } from "./journal-builder.js";
export { mapToFoundrySystem } from "./statblock-mapper.js";
export { buildActors, pooledMap } from "./actor-builder.js";
export { linkActorReferences } from "./reference-linker.js";
export { buildScenes } from "./scene-builder.js";
export { ImportManager, orchestrateImport, IMPORT_STAGES } from "./import-manager.js";
export { openImportDialog } from "./import-dialog.js";
