import { captureManager } from "../capture/capture-manager.js";
import { normalizeChatMessage } from "../capture/event-normalizer.js";
import { getSetting } from "../core/settings.js";
import { logger } from "../core/logger.js";

export function registerChatHooks() {
  Hooks.on("createChatMessage", (message) => {
    try {
      const captureWhispers = getSetting("captureWhispers");
      const hasWhisper = Array.isArray(message.whisper) && message.whisper.length > 0;

      if (hasWhisper && !captureWhispers) return;

      const event = normalizeChatMessage(message);
      captureManager.addEvent(event);
    } catch (err) {
      logger.error("chat-hooks: createChatMessage error:", err);
    }
  });
}
