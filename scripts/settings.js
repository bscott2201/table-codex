export const MODULE_ID = "tablecodex-sync";
export const MODULE_TITLE = "TableCodex Sync";
export const SCHEMA_VERSION = "1.0.0";
export const MODULE_VERSION = "0.2.3";

export function registerSettings() {
  const S = game.settings;
  const m = MODULE_ID;

  S.register(m, "tablecodexApiUrl", {
    name: "TABLECODEX.Settings.ApiUrl.Name",
    hint: "TABLECODEX.Settings.ApiUrl.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
  });

  S.register(m, "apiToken", {
    name: "TABLECODEX.Settings.ApiToken.Name",
    hint: "TABLECODEX.Settings.ApiToken.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
    restricted: true,
    onChange: (value) => {
      const cleaned = cleanToken(value);
      if (cleaned !== value) {
        // Re-save the normalized value silently so the stored token is always clean.
        game.settings.set(m, "apiToken", cleaned);
      }
    },
  });

  S.register(m, "foundryWorldId", {
    name: "TABLECODEX.Settings.WorldId.Name",
    hint: "TABLECODEX.Settings.WorldId.Hint",
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  S.register(m, "foundryWorldName", {
    name: "TABLECODEX.Settings.WorldName.Name",
    hint: "TABLECODEX.Settings.WorldName.Hint",
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  S.register(m, "captureWhispers", {
    name: "TABLECODEX.Settings.CaptureWhispers.Name",
    hint: "TABLECODEX.Settings.CaptureWhispers.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });

  S.register(m, "capturePrivateRolls", {
    name: "TABLECODEX.Settings.CapturePrivateRolls.Name",
    hint: "TABLECODEX.Settings.CapturePrivateRolls.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });

  S.register(m, "captureJournalText", {
    name: "TABLECODEX.Settings.CaptureJournalText.Name",
    hint: "TABLECODEX.Settings.CaptureJournalText.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });

  S.register(m, "captureActorSnapshots", {
    name: "TABLECODEX.Settings.CaptureActorSnapshots.Name",
    hint: "TABLECODEX.Settings.CaptureActorSnapshots.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    restricted: true,
  });

  S.register(m, "captureItemSnapshots", {
    name: "TABLECODEX.Settings.CaptureItemSnapshots.Name",
    hint: "TABLECODEX.Settings.CaptureItemSnapshots.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    restricted: true,
  });

  S.register(m, "captureSceneSnapshots", {
    name: "TABLECODEX.Settings.CaptureSceneSnapshots.Name",
    hint: "TABLECODEX.Settings.CaptureSceneSnapshots.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    restricted: true,
  });

  S.register(m, "autoSyncOnSessionEnd", {
    name: "TABLECODEX.Settings.AutoSync.Name",
    hint: "TABLECODEX.Settings.AutoSync.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });

  S.register(m, "debugLogging", {
    name: "TABLECODEX.Settings.DebugLogging.Name",
    hint: "TABLECODEX.Settings.DebugLogging.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
    restricted: true,
  });

  // Internal state — not shown in config UI
  S.register(m, "localSessionBuffer", {
    scope: "world",
    config: false,
    type: Object,
    default: null,
  });

  S.register(m, "lastSyncedImportId", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  S.register(m, "selectedCampaignId", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });

  S.register(m, "selectedCampaignName", {
    scope: "world",
    config: false,
    type: String,
    default: "",
  });
}

// Normalize a raw token value: trim whitespace and strip surrounding quotes.
export function cleanToken(raw) {
  return (raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
}

export function getSetting(key) {
  return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
  return game.settings.set(MODULE_ID, key, value);
}

export function getPrivacySettings() {
  return {
    captureWhispers: getSetting("captureWhispers"),
    capturePrivateRolls: getSetting("capturePrivateRolls"),
    captureJournalText: getSetting("captureJournalText"),
    captureActorSnapshots: getSetting("captureActorSnapshots"),
    captureItemSnapshots: getSetting("captureItemSnapshots"),
    captureSceneSnapshots: getSetting("captureSceneSnapshots"),
  };
}
