// @ts-check
/**
 * @file scene-controls.js
 * Injects a TableCodex tool into the scene controls toolbar. V13+ delivers the
 * controls as a record (keyed object); we handle that shape and fall back to the
 * legacy array shape just in case. GM-only.
 */

import { MODULE_ID } from "../core/constants.js";
import { isActiveGM } from "../core/util.js";
import { logger } from "../core/logger.js";
import { openPanel } from "./panel.js";

/**
 * @param {Record<string, any>|any[]} controls  The hook payload.
 */
export function injectSceneControls(controls) {
  if (!isActiveGM()) return;

  const tool = {
    name: "tablecodex-panel",
    title: "TableCodex Sync",
    icon: "fa-solid fa-scroll",
    button: true,
    visible: true,
    order: 99,
    onChange: () => openPanel(),
    onClick: () => openPanel(), // legacy fallback
  };

  // V13/V14 record shape: controls is an object keyed by control group name.
  if (controls && !Array.isArray(controls)) {
    controls[MODULE_ID] = {
      name: MODULE_ID,
      title: "TableCodex Sync",
      icon: "fa-solid fa-scroll",
      order: 99,
      visible: true,
      tools: { [tool.name]: tool },
      activeTool: tool.name,
    };
    logger.trace("scene-controls: injected (record shape)");
    return;
  }

  // Legacy array shape.
  if (Array.isArray(controls)) {
    controls.push({
      name: MODULE_ID,
      title: "TableCodex Sync",
      icon: "fa-solid fa-scroll",
      layer: "tokens",
      tools: [tool],
      activeTool: tool.name,
    });
    logger.trace("scene-controls: injected (array shape)");
  }
}
