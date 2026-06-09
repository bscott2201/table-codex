import { getCurrentSceneRef } from "../core/foundry-context.js";

function nowIso() {
  return new Date().toISOString();
}

function safeUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function stripHtml(html) {
  try {
    const div = document.createElement("div");
    div.innerHTML = html ?? "";
    return div.textContent || div.innerText || "";
  } catch {
    return html ?? "";
  }
}

function normalizeRollData(roll) {
  if (!roll) return null;
  try {
    return {
      formula: roll.formula ?? null,
      total: roll.total ?? null,
      dice: (roll.dice ?? []).map((d) => ({
        faces: d.faces ?? null,
        number: d.number ?? null,
        results: (d.results ?? []).map((r) => r.result ?? r),
      })),
      terms: (roll.terms ?? []).map((t) => {
        try { return t.expression ?? String(t); } catch { return null; }
      }),
    };
  } catch {
    return null;
  }
}

export function normalizeChatMessage(message) {
  try {
    const hasWhisper = Array.isArray(message.whisper) && message.whisper.length > 0;
    const privacyLevel = hasWhisper ? "whisper" : "public";

    const rolls = (message.rolls ?? []).map(normalizeRollData).filter(Boolean);
    const hasRolls = rolls.length > 0;

    const contentHtml = message.content ?? "";
    const contentText = stripHtml(contentHtml);

    const speakerData = message.speaker ?? {};
    const actorEntity = speakerData.actor
      ? (game?.actors?.get(speakerData.actor) ?? null)
      : null;

    return {
      sourceEventId: message.id ?? safeUuid(),
      eventType: hasRolls ? "chat.roll" : "chat.message",
      occurredAt: nowIso(),
      privacyLevel,
      actor: actorEntity
        ? { id: actorEntity.id ?? null, name: actorEntity.name ?? null, type: actorEntity.type ?? null }
        : null,
      speaker: {
        userId: speakerData.user ?? null,
        userName: game?.users?.get(speakerData.user)?.name ?? null,
        alias: speakerData.alias ?? null,
        tokenId: speakerData.token ?? null,
      },
      scene: getCurrentSceneRef(),
      payload: {
        contentText,
        contentHtml,
        rolls,
        whisperUserIds: hasWhisper ? message.whisper : [],
      },
      raw: null,
    };
  } catch (err) {
    return {
      sourceEventId: safeUuid(),
      eventType: "chat.message",
      occurredAt: nowIso(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: getCurrentSceneRef(),
      payload: { error: String(err) },
      raw: null,
    };
  }
}

export function normalizeRoll(roll) {
  return {
    sourceEventId: safeUuid(),
    eventType: "roll",
    occurredAt: nowIso(),
    privacyLevel: "public",
    actor: null,
    speaker: null,
    scene: getCurrentSceneRef(),
    payload: normalizeRollData(roll),
    raw: null,
  };
}

export function normalizeCombatStarted(combat) {
  try {
    const combatants = (combat.combatants ?? []).map((c) => ({
      id: c.id ?? null,
      name: c.name ?? null,
      actorId: c.actorId ?? null,
      tokenId: c.tokenId ?? null,
      initiative: c.initiative ?? null,
    }));
    return {
      sourceEventId: `combat-started-${combat.id ?? safeUuid()}`,
      eventType: "combat.started",
      occurredAt: nowIso(),
      privacyLevel: "public",
      actor: null,
      speaker: null,
      scene: getCurrentSceneRef(),
      payload: {
        combatId: combat.id ?? null,
        round: combat.round ?? 0,
        turn: combat.turn ?? 0,
        combatants,
      },
      raw: null,
    };
  } catch (err) {
    return { sourceEventId: safeUuid(), eventType: "combat.started", occurredAt: nowIso(), privacyLevel: "public", actor: null, speaker: null, scene: getCurrentSceneRef(), payload: { error: String(err) }, raw: null };
  }
}

export function normalizeCombatRoundStarted(combat, changes) {
  return {
    sourceEventId: `combat-round-${combat.id ?? ""}-${changes.round ?? combat.round ?? 0}`,
    eventType: "combat.round.started",
    occurredAt: nowIso(),
    privacyLevel: "public",
    actor: null,
    speaker: null,
    scene: getCurrentSceneRef(),
    payload: {
      combatId: combat.id ?? null,
      round: changes.round ?? combat.round ?? null,
    },
    raw: null,
  };
}

export function normalizeCombatTurnStarted(combat, changes) {
  try {
    const turn = changes.turn ?? combat.turn ?? 0;
    const combatant = combat.combatants?.contents?.[turn] ?? combat.combatants?.[turn] ?? null;
    return {
      sourceEventId: `combat-turn-${combat.id ?? ""}-${combat.round ?? 0}-${turn}`,
      eventType: "combat.turn.started",
      occurredAt: nowIso(),
      privacyLevel: "public",
      actor: combatant?.actorId ? { id: combatant.actorId, name: combatant.name ?? null } : null,
      speaker: null,
      scene: getCurrentSceneRef(),
      payload: {
        combatId: combat.id ?? null,
        round: combat.round ?? null,
        turn,
        combatantId: combatant?.id ?? null,
        combatantName: combatant?.name ?? null,
        actorId: combatant?.actorId ?? null,
      },
      raw: null,
    };
  } catch (err) {
    return { sourceEventId: safeUuid(), eventType: "combat.turn.started", occurredAt: nowIso(), privacyLevel: "public", actor: null, speaker: null, scene: getCurrentSceneRef(), payload: { error: String(err) }, raw: null };
  }
}

export function normalizeCombatEnded(combat) {
  return {
    sourceEventId: `combat-ended-${combat.id ?? safeUuid()}`,
    eventType: "combat.ended",
    occurredAt: nowIso(),
    privacyLevel: "public",
    actor: null,
    speaker: null,
    scene: getCurrentSceneRef(),
    payload: {
      combatId: combat.id ?? null,
      finalRound: combat.round ?? null,
    },
    raw: null,
  };
}

export function normalizeSceneChanged() {
  const scene = getCurrentSceneRef();
  return {
    sourceEventId: `scene-changed-${scene?.id ?? safeUuid()}`,
    eventType: "scene.changed",
    occurredAt: nowIso(),
    privacyLevel: "public",
    actor: null,
    speaker: null,
    scene,
    payload: {
      sceneId: scene?.id ?? null,
      sceneName: scene?.name ?? null,
    },
    raw: null,
  };
}

export function normalizeActorHpChanged(actor, changes) {
  try {
    const hp = actor?.system?.attributes?.hp ?? {};
    return {
      sourceEventId: `actor-hp-${actor?.id ?? safeUuid()}-${Date.now()}`,
      eventType: "actor.hp.changed",
      occurredAt: nowIso(),
      privacyLevel: "public",
      actor: { id: actor?.id ?? null, name: actor?.name ?? null, type: actor?.type ?? null },
      speaker: null,
      scene: getCurrentSceneRef(),
      payload: {
        actorId: actor?.id ?? null,
        actorName: actor?.name ?? null,
        hpCurrent: hp.value ?? null,
        hpMax: hp.max ?? null,
        hpChange: changes?.system?.attributes?.hp?.value ?? null,
      },
      raw: null,
    };
  } catch (err) {
    return { sourceEventId: safeUuid(), eventType: "actor.hp.changed", occurredAt: nowIso(), privacyLevel: "public", actor: null, speaker: null, scene: getCurrentSceneRef(), payload: { error: String(err) }, raw: null };
  }
}
