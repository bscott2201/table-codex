import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { registerSettings } from "./core/settings.js";
import { logger } from "./core/logger.js";
import { registerChatHooks } from "./hooks/chat-hooks.js";
import { registerCombatHooks } from "./hooks/combat-hooks.js";
import { registerSceneHooks } from "./hooks/scene-hooks.js";
import { registerActorHooks } from "./hooks/actor-hooks.js";
import { openTableCodexPanel, refreshTableCodexPanel } from "./ui/tablecodex-panel.js";
import { captureManager } from "./capture/capture-manager.js";

Hooks.once("init", () => {
  logger.log(`Initializing ${MODULE_TITLE} v${game.modules.get(MODULE_ID)?.version ?? "?"}`);
  registerSettings();
});

Hooks.once("ready", () => {
  logger.log("Ready.");

  registerChatHooks();
  registerCombatHooks();
  registerSceneHooks();
  registerActorHooks();

  // Refresh the panel whenever capture state changes.
  Hooks.on("tablecodex.captureStarted", refreshTableCodexPanel);
  Hooks.on("tablecodex.captureStopped", refreshTableCodexPanel);
  Hooks.on("tablecodex.archiveCleared", refreshTableCodexPanel);

  // Warn if a previous capture was still marked active (e.g. after a page reload).
  if (game.user?.isGM && game.settings.get(MODULE_ID, "isCapturing")) {
    ui.notifications.warn(
      "[TableCodex] A capture was active when the page last unloaded. " +
      "Open the TableCodex panel to stop it or resume manually."
    );
  }
});

// Add a button to the scene navigation controls for quick panel access (GM only).
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const tokenControls = controls.find((c) => c.name === "token");
  if (!tokenControls) return;

  tokenControls.tools.push({
    name: "tablecodex",
    title: "TableCodex",
    icon: "fas fa-scroll",
    button: true,
    onClick: () => openTableCodexPanel(),
  });
});
