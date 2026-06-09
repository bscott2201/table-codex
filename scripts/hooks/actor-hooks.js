import { captureManager } from "../capture/capture-manager.js";
import { normalizeActorHpChanged } from "../capture/event-normalizer.js";
import { logger } from "../core/logger.js";

function hasHpChange(changes) {
  try {
    return changes?.system?.attributes?.hp !== undefined;
  } catch {
    return false;
  }
}

export function registerActorHooks() {
  Hooks.on("updateActor", (actor, changes) => {
    try {
      // Only capture HP changes; guard against non-D&D systems gracefully.
      if (!hasHpChange(changes)) return;
      captureManager.addEvent(normalizeActorHpChanged(actor, changes));
    } catch (err) {
      logger.error("actor-hooks: updateActor error:", err);
    }
  });
}
