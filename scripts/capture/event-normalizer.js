import { getCurrentSceneRef } from "../core/foundry-context.js";

// Maps internal Foundry event types to the API's VTT event type enum.
const EVENT_TYPE_MAP = {
  "chat.message": "chat",
  "chat.roll": "chat",
  "roll": "chat",
  "combat.started": "custom",
  "combat.ended": "custom",
  "combat.round.started": "custom",
  "combat.turn.started": "custom",
  "actor.hp.changed": "custom",
  "scene.changed": "scene_change",
};

const SKIP_EVENT_TYPES = new Set(["session.started", "session.ended"]);

function mapEventType(internalType) {
  return EVENT_TYPE_MAP[internalType] ?? "custom";
}

function generateSummary(event) {
  const p = event.payload ?? {};
  switch (event.eventType) {
    case "chat.message": {
      const who = event.speaker?.alias ?? event.actor?.name ?? "Someone";
      const text = (p.contentText ?? "").slice(0, 200);
      return text ? `${who}: ${text}` : `${who} sent a message`;
    }
    case "chat.roll": {
      const who = event.speaker?.alias ?? event.actor?.name ?? "Someone";
      const formula = event.payload?.rolls?.[0]?.formula ?? "?";
      const total = event.payload?.rolls?.[0]?.total ?? "?";
      return `${who} rolled ${formula} = ${total}`;
    }
    case "roll": {
      const formula = p.formula ?? "?";
      const total = p.total ?? "?";
      return `Roll: ${formula} = ${total}`;
    }
    case "combat.started": {
      const n = (p.combatants ?? []).length;
      return `Combat started with ${n} combatant${n !== 1 ? "s" : ""}`;
    }
    case "combat.ended":
      return `Combat ended after round ${p.finalRound ?? "?"}`;
    case "combat.round.started":
      return `Round ${p.round ?? "?"} began`;
    case "combat.turn.started": {
      const name = p.combatantName ?? event.actor?.name ?? "Unknown";
      return `${name}'s turn (Round ${p.round ?? "?"})`;
    }
    case "actor.hp.changed": {
      const name = p.actorName ?? event.actor?.name ?? "Unknown";
      const change = p.hpChange;
      const current = p.hpCurrent ?? "?";
      const max = p.hpMax ?? "?";
      if (change != null) {
        const sign = change > 0 ? "+" : "";
        return `${name} HP ${sign}${change} → ${current}/${max}`;
      }
      return `${name} HP: ${current}/${max}`;
    }
    case "scene.changed":
      return `Scene: ${p.sceneName ?? "unknown"}`;
    default:
      return event.eventType ?? "Unknown event";
  }
}

// Converts an internal buffered event into the VTT event shape the API expects.
// Returns null for event types that should not be sent to the API.
export function toVttEvent(event, sequenceIndex) {
  if (SKIP_EVENT_TYPES.has(event.eventType)) return null;

  // Determine if HP change was damage or healing for a more precise eventType.
  let apiEventType = mapEventType(event.eventType);
  if (event.eventType === "actor.hp.changed") {
    const change = event.payload?.hpChange;
    if (change != null) apiEventType = change < 0 ? "damage" : "healing";
  }

  return {
    sequenceIndex,
    eventType: apiEventType,
    actor: event.actor?.name ?? null,
    target: null,
    eventSummary: generateSummary(event),
    rawLine: null,
    eventDataJson: event.payload ?? null,
    visibility: event.privacyLevel === "whisper" ? "dm_only" : "player_safe",
    confidence: "high",
    isImportant: false,
  };
}

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
