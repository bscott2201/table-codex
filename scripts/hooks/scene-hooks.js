import { captureManager } from "../capture/capture-manager.js";
import { normalizeSceneChanged } from "../capture/event-normalizer.js";
import { logger } from "../core/logger.js";

export function registerSceneHooks() {
  Hooks.on("canvasReady", () => {
    try {
      captureManager.addEvent(normalizeSceneChanged());
    } catch (err) {
      logger.error("scene-hooks: canvasReady error:", err);
    }
  });
}
