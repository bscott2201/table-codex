// @ts-check
/**
 * @file plan-fetcher.js
 * Phase 2: thin wrappers over api-client for the session-prep import flow.
 *
 *   listSessionPlans() — summary list for the panel picker (read-only; does NOT
 *                        mark a plan exported).
 *   getSessionPlan(id) — full FoundryExportPayload for an actual import (this
 *                        DOES stamp foundryExportedAt server-side).
 *
 * Both return result objects ({ ok, data?, error? }) rather than throwing, matching
 * the rest of the module's API surface.
 */

import { apiClient } from "../export/api-client.js";
import { logger } from "../core/logger.js";

/** Lowest payload version this module knows how to import. */
export const SUPPORTED_PAYLOAD_VERSION = 1;

/**
 * @typedef {{ id:number, title:string, plannedSessionNumber:number|null,
 *   status:string|null, sceneCount:number, npcCount:number,
 *   hasBattleMaps:boolean, foundryExportedAt:string|null }} SessionPlanSummary
 */

/**
 * Fetch the importable session plans for the linked campaign.
 * @returns {Promise<{ ok:boolean, data?:SessionPlanSummary[], error?:string }>}
 */
export async function listSessionPlans() {
  const result = await apiClient.listSessionPlans();
  if (!result.ok) {
    logger.warn("plan-fetcher: listSessionPlans failed", result.error);
    return { ok: false, error: result.error ?? "failed to load plans" };
  }
  return { ok: true, data: result.data ?? [] };
}

/**
 * Fetch the full export payload for one plan. Validates the payload version so a
 * newer server schema can't be half-imported by an old module.
 * @param {number|string} planId
 * @returns {Promise<{ ok:boolean, data?:any, error?:string }>}
 */
export async function getSessionPlan(planId) {
  const result = await apiClient.getSessionPlan(planId);
  if (!result.ok) {
    logger.warn("plan-fetcher: getSessionPlan failed", planId, result.error);
    return { ok: false, error: result.error ?? "failed to load plan" };
  }

  const payload = result.data;
  const version = payload?.meta?.payloadVersion;
  if (typeof version !== "number") {
    return { ok: false, error: "export payload is missing a version — update the TableCodex server" };
  }
  if (version > SUPPORTED_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: `this plan needs a newer TableCodex module (payload v${version}, supported v${SUPPORTED_PAYLOAD_VERSION})`,
    };
  }

  logger.info(
    `plan-fetcher: fetched plan ${planId} — ${payload.journals?.length ?? 0} journals, ${payload.actors?.length ?? 0} actors`,
  );
  return { ok: true, data: payload };
}
