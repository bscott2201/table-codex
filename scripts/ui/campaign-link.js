// @ts-check
/**
 * @file campaign-link.js
 * Campaign linking now lives inside the unified TableCodex panel (see panel.js) —
 * the "Connection & Campaign" section provides the same controls (API URL/token,
 * test connection, load campaigns, pick/save campaign).
 *
 * This module remains only as a backward-compatible alias so existing macros and
 * the module API (`game.modules.get("tablecodex-sync").api.openCampaignLink`) keep
 * working: `openCampaignLink()` simply opens the unified panel.
 */

export { openPanel as openCampaignLink } from "./panel.js";
