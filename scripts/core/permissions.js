import { MODULE_TITLE } from "../constants.js";

export function requireGM(actionName = "This action") {
  if (game?.user?.isGM) return true;
  ui?.notifications?.warn(`${actionName} is only available to the GM.`);
  return false;
}
