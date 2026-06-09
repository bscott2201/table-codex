import { captureManager } from "../capture/capture-manager.js";
import {
  normalizeCombatStarted,
  normalizeCombatRoundStarted,
  normalizeCombatTurnStarted,
  normalizeCombatEnded,
} from "../capture/event-normalizer.js";
import { logger } from "../core/logger.js";

export function registerCombatHooks() {
  Hooks.on("createCombat", (combat) => {
    try {
      captureManager.addEvent(normalizeCombatStarted(combat));
    } catch (err) {
      logger.error("combat-hooks: createCombat error:", err);
    }
  });

  Hooks.on("updateCombat", (combat, changes) => {
    try {
      if ("round" in changes && changes.round !== combat._previousRound) {
        captureManager.addEvent(normalizeCombatRoundStarted(combat, changes));
      }
      if ("turn" in changes) {
        captureManager.addEvent(normalizeCombatTurnStarted(combat, changes));
      }
    } catch (err) {
      logger.error("combat-hooks: updateCombat error:", err);
    }
  });

  Hooks.on("deleteCombat", (combat) => {
    try {
      captureManager.addEvent(normalizeCombatEnded(combat));
    } catch (err) {
      logger.error("combat-hooks: deleteCombat error:", err);
    }
  });
}
