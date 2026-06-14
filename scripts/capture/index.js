// @ts-check
/**
 * @file index.js
 * Wires every capture module to its Foundry hooks. Two phases of registration:
 *
 *  - registerPreUpdateHooks(): called at module-scope (before `init`) so the
 *    "before" snapshot exists on the very first update of the session. These are
 *    `preUpdate*` hooks (HP, movement, resource deltas) and they no-op until a
 *    session is active.
 *
 *  - registerCaptureModules(): called in `ready`, after the store/session exist.
 *    These are create/update/delete/combat/chat/canvas hooks plus the dnd5e
 *    Phase 3 layer (registered only when the active system is dnd5e).
 */

import { logger } from "../core/logger.js";
import { guard } from "./base.js";
import { isDnd5e } from "../integrations/dnd5e.js";

// Phase 2
import * as hp from "./hp-capture.js";
import * as movement from "./movement-capture.js";
import * as condition from "./condition-capture.js";
import * as combat from "./combat-capture.js";
import * as roll from "./roll-capture.js";
import * as world from "./world-capture.js";

// Phase 3 (dnd5e)
import * as activity from "./activity-capture.js";
import * as spell from "./spell-capture.js";
import * as weapon from "./weapon-capture.js";
import * as feature from "./feature-capture.js";
import * as resource from "./resource-capture.js";

let _preUpdateRegistered = false;
let _captureRegistered = false;

/** Pre-update hooks — MUST be registered before `ready`. */
export function registerPreUpdateHooks() {
  if (_preUpdateRegistered) return;
  _preUpdateRegistered = true;

  Hooks.on(
    "preUpdateActor",
    guard("preUpdateActor", (actor, changes, options, userId) => {
      hp.onPreUpdateActor(actor, changes, options, userId);
      resource.onPreUpdateActor(actor, changes, options, userId);
    }),
  );

  Hooks.on(
    "preUpdateToken",
    guard("preUpdateToken", (tokenDoc, changes, options, userId) => {
      // Order: HP first (unlinked actor delta), then movement.
      hp.onPreUpdateToken(tokenDoc, changes, options, userId);
      movement.onPreUpdateToken(tokenDoc, changes, options, userId);
    }),
  );

  Hooks.on(
    "preUpdateItem",
    guard("preUpdateItem", (item, changes, options, userId) => {
      resource.onPreUpdateItem(item, changes, options, userId);
    }),
  );

  logger.debug("capture: pre-update hooks registered");
}

/** Post-ready capture hooks. */
export function registerCaptureModules() {
  if (_captureRegistered) return;
  _captureRegistered = true;

  // ── Conditions (ActiveEffects) ─────────────────────────────────────
  Hooks.on("createActiveEffect", guard("createActiveEffect", condition.onCreateActiveEffect));
  Hooks.on("updateActiveEffect", guard("updateActiveEffect", condition.onUpdateActiveEffect));
  Hooks.on("deleteActiveEffect", guard("deleteActiveEffect", condition.onDeleteActiveEffect));

  // ── Combat ─────────────────────────────────────────────────────────
  Hooks.on("combatStart", guard("combatStart", combat.onCombatStart));
  Hooks.on("deleteCombat", guard("deleteCombat", combat.onDeleteCombat));
  Hooks.on("combatRound", guard("combatRound", combat.onCombatRound));
  Hooks.on("combatTurn", guard("combatTurn", combat.onCombatTurn));
  Hooks.on("updateCombatant", guard("updateCombatant", combat.onUpdateCombatant));

  // ── Rolls (system-agnostic) ────────────────────────────────────────
  Hooks.on("createChatMessage", guard("createChatMessage", roll.onCreateChatMessage));

  // ── World/scene context ────────────────────────────────────────────
  Hooks.on("canvasReady", guard("canvasReady", world.onCanvasReady));
  Hooks.on("createToken", guard("createToken", world.onCreateToken));
  Hooks.on("deleteToken", guard("deleteToken", world.onDeleteToken));

  // ── Phase 3: dnd5e activity layer ──────────────────────────────────
  if (isDnd5e()) {
    activity.register();
    spell.register();
    weapon.register();
    feature.register();
    resource.register();
    logger.info("capture: dnd5e activity layer registered");
  } else {
    logger.info("capture: non-dnd5e system — Phase 3 layer skipped");
  }

  logger.debug("capture: post-ready hooks registered");
}
