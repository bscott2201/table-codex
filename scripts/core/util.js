// @ts-check
/**
 * @file util.js
 * Small pure-ish helpers shared across the pipeline: id generation, context
 * resolution (world/user), object diffing, and safe property access. These
 * intentionally degrade gracefully when Foundry globals are absent so the pure
 * modules can be unit-tested in plain Node with stubbed globals.
 */

/**
 * Generate a random id. Uses Foundry's randomID when available, otherwise a
 * crypto/Math fallback so tests and early-boot code still work.
 * @param {number} [length=16]
 * @returns {string}
 */
export function randomId(length = 16) {
  const f = globalThis.foundry;
  if (f?.utils?.randomID) return f.utils.randomID(length);
  // Fallback: base36 from crypto if present.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  const rnd =
    globalThis.crypto?.getRandomValues?.(new Uint32Array(length)) ?? null;
  for (let i = 0; i < length; i++) {
    const n = rnd ? rnd[i] : Math.floor(Math.random() * 0xffffffff);
    out += chars[n % chars.length];
  }
  return out;
}

/** Current ISO timestamp. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Current world id, or a stable placeholder when no world is loaded.
 * @returns {string}
 */
export function worldId() {
  return globalThis.game?.world?.id ?? "no-world";
}

/**
 * Current acting user id, or "system" when none.
 * @returns {string}
 */
export function currentUserId() {
  return globalThis.game?.user?.id ?? "system";
}

/** Is the current client the active GM (authoritative writer)? */
export function isActiveGM() {
  // `game.users.activeGM` is the canonical "designated GM" in V11+.
  const activeGM = globalThis.game?.users?.activeGM;
  if (activeGM) return activeGM.id === globalThis.game?.user?.id;
  return Boolean(globalThis.game?.user?.isGM);
}

/** Is any GM currently connected? */
export function gmConnected() {
  return Boolean(globalThis.game?.users?.activeGM);
}

/**
 * Exactly-once capture guard. Foundry document hooks fire on every connected
 * client; the 4th argument of update/create/delete hooks is the id of the user
 * who triggered the change. Only that client should capture the event, so each
 * real-world action is recorded once across the table.
 * @param {string} userId  The triggering user id from the hook.
 * @returns {boolean} true if this client is the originating client.
 */
export function isTriggeringUser(userId) {
  // If no user id was provided (system-driven change), let the active GM own it.
  if (!userId) return isActiveGM();
  return userId === globalThis.game?.user?.id;
}

/**
 * Safe deep property read. Prefers Foundry's getProperty, falls back to a
 * dotted-path walk.
 * @param {object} obj
 * @param {string} path
 * @returns {*}
 */
export function getProp(obj, path) {
  const f = globalThis.foundry;
  if (f?.utils?.getProperty) return f.utils.getProperty(obj, path);
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/**
 * Compute the set of leaf paths that changed between two objects given a Foundry
 * "diff" object (the `changed` argument of update hooks). Returns a flat list of
 * dotted paths. Pure and dependency-free.
 * @param {object} changed
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function changedPaths(changed, prefix = "") {
  const out = [];
  if (changed == null || typeof changed !== "object") return out;
  for (const [k, v] of Object.entries(changed)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(...changedPaths(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/** Does a Foundry-style diff touch any path under the given root? */
export function diffTouches(changed, root) {
  return changedPaths(changed).some((p) => p === root || p.startsWith(`${root}.`));
}

/**
 * Resolve actorId/tokenId from a variety of document shapes (Actor, Token,
 * TokenDocument, ActiveEffect parent, etc.). Always returns the keyed pair with
 * nulls rather than throwing.
 * @param {*} doc
 * @returns {{ actorId: string|null, tokenId: string|null }}
 */
export function resolveActorToken(doc) {
  let actorId = null;
  let tokenId = null;
  if (!doc) return { actorId, tokenId };

  // TokenDocument
  if (doc.documentName === "Token" || doc.actorId !== undefined) {
    tokenId = doc.id ?? null;
    actorId = doc.actorId ?? doc.actor?.id ?? null;
    return { actorId, tokenId };
  }
  // Actor
  if (doc.documentName === "Actor") {
    actorId = doc.id ?? null;
    // Best-effort active token on the canvas
    tokenId = doc.getActiveTokens?.()?.[0]?.id ?? null;
    return { actorId, tokenId };
  }
  // Embedded document (Item, ActiveEffect): walk to the parent actor.
  const parentActor = doc.actor ?? (doc.parent?.documentName === "Actor" ? doc.parent : null);
  if (parentActor) {
    actorId = parentActor.id ?? null;
    tokenId = parentActor.getActiveTokens?.()?.[0]?.id ?? null;
  }
  return { actorId, tokenId };
}

/** Clamp helper. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Deep clone via Foundry util or structuredClone fallback. */
export function clone(obj) {
  const f = globalThis.foundry;
  if (f?.utils?.deepClone) return f.utils.deepClone(obj);
  return globalThis.structuredClone ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
}
