import { MODULE_ID, MODULE_TITLE } from "./constants.js";
import { registerSettings, getSetting } from "./core/settings.js";
import { logger } from "./core/logger.js";
import { registerChatHooks } from "./hooks/chat-hooks.js";
import { registerCombatHooks } from "./hooks/combat-hooks.js";
import { registerSceneHooks } from "./hooks/scene-hooks.js";
import { registerActorHooks } from "./hooks/actor-hooks.js";
import { openTableCodexPanel, refreshTableCodexPanel, promptSessionTitle } from "./ui/tablecodex-panel.js";
import { CampaignPickerForm } from "./ui/campaign-picker.js";
import { captureManager } from "./capture/capture-manager.js";
import { inactivityMonitor } from "./core/inactivity-monitor.js";

Hooks.once("init", () => {
  logger.log(`Initializing ${MODULE_TITLE} v${game.modules.get(MODULE_ID)?.version ?? "?"}`);
  registerSettings();

  game.settings.registerMenu(MODULE_ID, "campaignPicker", {
    name: "Campaign",
    label: "Select Campaign",
    hint: "Choose which TableCodex campaign to sync Foundry sessions to.",
    icon: "fas fa-map",
    type: CampaignPickerForm,
    restricted: true,
  });
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

  if (!game.user?.isGM) return;

  const isCapturing = getSetting("isCapturing");

  if (isCapturing) {
    // Session was active before a page reload — resume the inactivity monitor.
    ui.notifications.warn(
      "[TableCodex] A session was active when the page last reloaded. " +
      "Resuming capture — open the TableCodex panel to stop it."
    );
    inactivityMonitor.start(() => captureManager.stopCapture());
  } else {
    // Prompt the GM to start a session after Foundry finishes loading.
    setTimeout(_promptSessionStart, 2000);
  }
});

async function _promptSessionStart() {
  const campaignId = getSetting("campaignId");
  if (!campaignId) return; // No campaign configured — nothing to prompt.

  const campaignName = getSetting("campaignName") || campaignId;

  const start = await Dialog.confirm({
    title: "Start a Session?",
    content: `
      <p>Welcome back! Would you like to start logging a new session for</p>
      <p><strong>${campaignName}</strong>?</p>
    `,
    yes: () => true,
    no: () => false,
    defaultYes: true,
  });

  if (!start) return;

  const sessionTitle = await promptSessionTitle();
  if (sessionTitle === null) return;

  await captureManager.startCapture({ campaignId, sessionTitle });
}

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
        await captureManager.startCapture({ campaignId, sessionTitle });
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
