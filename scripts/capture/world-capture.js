// @ts-check
/**
 * @file world-capture.js
 * Lightweight world/scene context capture: scene views and token create/delete.
 * Scene views have no triggering user (canvasReady is local), so they are owned
 * by the active GM client.
 */

import { EVENT_TYPES } from "../core/constants.js";
import { canCapture, emit } from "./base.js";

export function onCanvasReady(canvas) {
  if (!canCapture(undefined)) return;
  const scene = canvas?.scene;
  if (!scene) return;
  emit(EVENT_TYPES.SCENE_VIEW, {
    metadata: {
      sceneId: scene.id,
      name: scene.name,
      tokenCount: scene.tokens?.size ?? null,
    },
  });
}

export function onCreateToken(tokenDoc, _options, userId) {
  if (!canCapture(userId)) return;
  emit(EVENT_TYPES.TOKEN_CREATE, {
    userId,
    actorId: tokenDoc.actorId ?? null,
    tokenId: tokenDoc.id ?? null,
    metadata: {
      name: tokenDoc.name,
      sceneId: tokenDoc.parent?.id ?? null,
      x: tokenDoc.x,
      y: tokenDoc.y,
      hidden: Boolean(tokenDoc.hidden),
    },
  });
}

export function onDeleteToken(tokenDoc, _options, userId) {
  if (!canCapture(userId)) return;
  emit(EVENT_TYPES.TOKEN_DELETE, {
    userId,
    actorId: tokenDoc.actorId ?? null,
    tokenId: tokenDoc.id ?? null,
    metadata: { name: tokenDoc.name, sceneId: tokenDoc.parent?.id ?? null },
  });
}
