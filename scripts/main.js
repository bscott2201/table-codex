import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { registerSettings, getSetting } from "./core/settings.js";
import { logger } from "./core/logger.js";
import { registerChatHooks } from "./hooks/chat-hooks.js";
import { registerCombatHooks } from "./hooks/combat-hooks.js";
import { registerSceneHooks } from "./hooks/scene-hooks.js";
import { registerActorHooks } from "./hooks/actor-hooks.js";
import { openTableCodexPanel, refreshTableCodexPanel, promptSessionTitle } from "./ui/tablecodex-panel.js";
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

  Hooks.on("tablecodex.captureStarted", () => { refreshTableCodexPanel(); ui.controls?.render(); });
  Hooks.on("tablecodex.captureStopped", () => { refreshTableCodexPanel(); ui.controls?.render(); });
  Hooks.on("tablecodex.archiveCleared", refreshTableCodexPanel);

  // Warn if a previous capture was still marked active (e.g. after a page reload).
  if (game.user?.isGM && game.settings.get(MODULE_ID, "isCapturing")) {
    ui.notifications.warn(
      "[TableCodex] A capture was active when the page last unloaded. " +
      "Open the TableCodex panel to stop it or resume manually."
    );
  }
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  // V14: controls is an object keyed by group name; V13 and earlier: array with .find()
  const tokenGroup = Array.isArray(controls)
    ? controls.find((c) => c.name === "token" || c.name === "tokens")
    : (controls.tokens ?? controls.token);
  if (!tokenGroup?.tools) return;

  const isCapturing = getSetting("isCapturing") ?? false;

  const panelTool = {
    name: "tablecodex",
    title: "TableCodex",
    icon: "fas fa-scroll",
    button: true,
    onChange: () => openTableCodexPanel(),
  };

  const sessionTool = {
    name: "tablecodex-session",
    title: isCapturing ? "Stop Session" : "Start Session",
    icon: isCapturing ? "fas fa-stop" : "fas fa-circle",
    button: true,
    onChange: async () => {
      if (getSetting("isCapturing")) {
        await captureManager.stopCapture();
      } else {
        const sessionTitle = await promptSessionTitle();
        if (sessionTitle === null) return;
        const campaignId = getSetting("campaignId") || "";
        const sessionId = getSetting("sessionId") || "";
        await captureManager.startCapture({ campaignId, sessionId, sessionTitle });
      }
    },
  };

  if (Array.isArray(tokenGroup.tools)) {
    tokenGroup.tools.push(panelTool, sessionTool);
  } else {
    tokenGroup.tools.tablecodex = panelTool;
    tokenGroup.tools["tablecodex-session"] = sessionTool;
  }
});
