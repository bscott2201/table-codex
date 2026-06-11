import { MODULE_ID, MODULE_VERSION, getSetting } from "./settings.js";
import { log } from "./logger.js";

/**
 * Returns a consistent world/system/version snapshot.
 * Uses a defensive fallback chain for game.world.id so a missing property
 * never silently produces undefined in a server payload.
 */
export function getWorldInfo() {
  // Foundry V14 primary: game.world.id
  // Older builds: game.world._id
  // Last resort: game.world.title used as id
  let foundryWorldId = game.world?.id ?? game.world?._id ?? null;

  if (!foundryWorldId && game.world?.title) {
    foundryWorldId = game.world.title;
    log("Warning: game.world.id unavailable — falling back to world title as id.");
  }

  if (!foundryWorldId) {
    foundryWorldId = "unknown-world";
    log("Warning: game.world.id is unavailable — using fallback 'unknown-world'. Is the world fully loaded?");
  }

  const foundryWorldName =
    (game.world?.title ?? game.world?.id ?? game.world?._id ?? "").trim() || "Unknown World";

  const foundryVersion =
    (game.version ?? game.release?.version ?? "").trim() || "unknown";

  const systemId = (game.system?.id ?? "").trim() || "unknown";

  const moduleVersion =
    game.modules.get(MODULE_ID)?.version ?? MODULE_VERSION;

  // Fall back to settings for world id/name if stored during a previous load
  const resolvedWorldId = foundryWorldId !== "unknown-world"
    ? foundryWorldId
    : (getSetting("foundryWorldId") || "unknown-world");

  const resolvedWorldName = foundryWorldName !== "Unknown World"
    ? foundryWorldName
    : (getSetting("foundryWorldName") || "Unknown World");

  return {
    foundryWorldId:   resolvedWorldId,
    foundryWorldName: resolvedWorldName,
    foundryVersion,
    systemId,
    moduleVersion,
  };
}
