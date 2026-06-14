// @ts-check
/**
 * @file movement-capture.js
 * Captures token movement (x/y/elevation/rotation) on `preUpdateToken`, where
 * the token still holds its old position. Grid distance is computed with the
 * non-deprecated `canvas.grid.measurePath` when available.
 */

import { EVENT_TYPES, SETTINGS } from "../core/constants.js";
import { resolveActorToken, diffTouches } from "../core/util.js";
import { canCapture, emit } from "./base.js";

/**
 * Compute grid distance between two pixel positions using the current grid.
 * @returns {number|null} distance in grid units, or null if unavailable.
 */
function gridDistance(from, to) {
  try {
    const grid = globalThis.canvas?.grid;
    if (grid?.measurePath) {
      const result = grid.measurePath([from, to]);
      return result?.distance ?? null;
    }
    // Fallback: Euclidean in pixels → grid units.
    if (grid?.size && grid?.distance) {
      const dx = (to.x - from.x) / grid.size;
      const dy = (to.y - from.y) / grid.size;
      return Math.hypot(dx, dy) * grid.distance;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** preUpdateToken — movement deltas. */
export function onPreUpdateToken(tokenDoc, changes, _options, userId) {
  if (!canCapture(userId, SETTINGS.CAPTURE_MOVEMENT)) return;
  const movedXY = diffTouches(changes, "x") || diffTouches(changes, "y");
  const movedElev = diffTouches(changes, "elevation");
  const rotated = diffTouches(changes, "rotation");
  if (!movedXY && !movedElev && !rotated) return;

  const from = { x: tokenDoc.x, y: tokenDoc.y };
  const to = { x: changes.x ?? tokenDoc.x, y: changes.y ?? tokenDoc.y };
  const { actorId, tokenId } = resolveActorToken(tokenDoc);

  emit(EVENT_TYPES.MOVEMENT, {
    userId,
    actorId,
    tokenId,
    metadata: {
      from: { ...from, elevation: tokenDoc.elevation ?? 0, rotation: tokenDoc.rotation ?? 0 },
      to: {
        ...to,
        elevation: changes.elevation ?? tokenDoc.elevation ?? 0,
        rotation: changes.rotation ?? tokenDoc.rotation ?? 0,
      },
      distance: movedXY ? gridDistance(from, to) : 0,
      elevationDelta: movedElev ? (changes.elevation ?? 0) - (tokenDoc.elevation ?? 0) : 0,
      sceneId: tokenDoc.parent?.id ?? null,
      tokenName: tokenDoc.name ?? null,
    },
  });
}
