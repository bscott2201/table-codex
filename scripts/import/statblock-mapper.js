// @ts-check
/**
 * @file statblock-mapper.js
 * Phase 4: translate a FoundryStatblock (from the export payload) into dnd5e
 * Actor `system.*` data + embedded `items[]` (PRD §6.7, rewritten for v1.1).
 *
 * Targets dnd5e v5.x on Foundry v13–14. The well-established core fields (AC, HP,
 * abilities, movement, details, traits, skills, senses) are stable across v3–v5.
 * Actions/traits become Items; on dnd5e v4+ each rollable action carries an
 * **Activity** (attack/save) — gated behind hasActivities(). Every item ALWAYS
 * keeps its full description, so a creature stays usable even if an activity field
 * needs tuning against a specific dnd5e build.
 *
 * NOTE: the exact Activity field shapes should be validated in a live dnd5e v5
 * world (PRD §8.2 schema-drift risk). Core stats and descriptions do not depend
 * on that and are safe.
 */

import { hasActivities } from "../integrations/dnd5e.js";

/** Full skill name → dnd5e skill key. */
const SKILL_KEY = {
  acrobatics: "acr", "animal handling": "ani", arcana: "arc", athletics: "ath",
  deception: "dec", history: "his", insight: "ins", intimidation: "itm",
  investigation: "inv", medicine: "med", nature: "nat", perception: "prc",
  performance: "prf", persuasion: "per", religion: "rel", "sleight of hand": "slt",
  stealth: "ste", survival: "sur",
};

const ABILS = ["str", "dex", "con", "int", "wis", "cha"];

function randomId() {
  return globalThis.foundry?.utils?.randomID?.(16) ?? `a${Math.random().toString(36).slice(2, 12)}`;
}

/** Parse "2d6+3" / "1d8" / "3d6-1" → { number, denomination, bonus }. */
function parseDamageDice(dice) {
  if (typeof dice !== "string") return null;
  const m = dice.replace(/\s+/g, "").match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return {
    number: parseInt(m[1], 10),
    denomination: parseInt(m[2], 10),
    bonus: m[3] ? String(parseInt(m[3], 10)) : "",
  };
}

/** Build a dnd5e damage part from an action's damage fields. */
function damagePart(action) {
  const parsed = parseDamageDice(action.damageDice);
  if (!parsed) return null;
  return {
    number: parsed.number,
    denomination: parsed.denomination,
    bonus: parsed.bonus,
    types: action.damageType ? [String(action.damageType).toLowerCase()] : [],
    custom: { enabled: false, formula: "" },
    scaling: { mode: "", number: 1, formula: "" },
  };
}

/**
 * Parse a senses string into the dnd5e v5 senses object. In dnd5e 5.x the numeric
 * ranges live under `senses.ranges.{darkvision,...}` (NOT flat on `senses`).
 */
function parseSenses(senses) {
  const ranges = { darkvision: null, blindsight: null, tremorsense: null, truesight: null };
  if (typeof senses === "string") {
    for (const key of Object.keys(ranges)) {
      const m = senses.match(new RegExp(`${key}\\s+(\\d+)`, "i"));
      if (m) ranges[key] = parseInt(m[1], 10);
    }
  }
  return { ranges, units: "ft", special: "" };
}

/** melee vs ranged inferred from the action description. */
function attackKind(desc) {
  return /ranged|\bbow\b|\bcrossbow\b|thrown|\bdart\b|\bsling\b/i.test(desc ?? "") ? "ranged" : "melee";
}

/** Build an attack Activity (dnd5e v4+/v5). */
function attackActivity(action) {
  const part = damagePart(action);
  return {
    _id: randomId(),
    type: "attack",
    name: action.name ?? "",
    activation: { type: "action", value: 1, condition: "" },
    // flat:true → the to-hit equals `bonus` exactly (NPC stat blocks give the number).
    attack: {
      ability: "",
      bonus: action.attackBonus != null ? String(action.attackBonus) : "",
      flat: action.attackBonus != null,
      type: { value: attackKind(action.desc), classification: "weapon" },
    },
    damage: { includeBase: false, critical: { allow: false }, parts: part ? [part] : [] },
  };
}

/** Build a save Activity (dnd5e v4+/v5). */
function saveActivity(action) {
  const part = damagePart(action);
  return {
    _id: randomId(),
    type: "save",
    name: action.name ?? "",
    activation: { type: "action", value: 1, condition: "" },
    save: {
      ability: action.saveAbility ? [String(action.saveAbility).toLowerCase()] : [],
      dc: { calculation: "", formula: action.saveDC != null ? String(action.saveDC) : "" },
    },
    damage: { onSave: "half", parts: part ? [part] : [] },
  };
}

/** Wrap activities in the keyed object dnd5e expects. */
function activityMap(activity) {
  if (!activity || !hasActivities()) return {};
  return { [activity._id]: activity };
}

const descHtml = (action) => ({ value: action.desc ? `<p>${action.desc}</p>` : "", chat: "" });

/** Build the embedded items[] (actions, traits, legendary, reactions). */
function buildItems(sb) {
  const items = [];

  for (const a of sb.actions ?? []) {
    const isSave = a.saveAbility != null || a.saveDC != null;
    const isAttack = a.attackBonus != null || a.damageDice != null;
    if (isAttack && !isSave) {
      items.push({
        name: a.name, type: "weapon",
        system: {
          description: descHtml(a),
          type: { value: "natural" },
          activities: activityMap(attackActivity(a)),
        },
      });
    } else if (isSave) {
      items.push({
        name: a.name, type: "feat",
        system: {
          description: descHtml(a),
          type: { value: "monster", subtype: "" },
          activities: activityMap(saveActivity(a)),
        },
      });
    } else {
      items.push({ name: a.name, type: "feat", system: { description: descHtml(a), type: { value: "monster", subtype: "" } } });
    }
  }

  for (const t of sb.traits ?? []) {
    items.push({ name: t.name, type: "feat", system: { description: descHtml(t), type: { value: "monster", subtype: "" } } });
  }

  for (const l of sb.legendaryActions ?? []) {
    items.push({
      name: l.name, type: "feat",
      system: { description: descHtml(l), type: { value: "monster", subtype: "" }, activation: { type: "legendary", value: l.cost ?? 1 } },
    });
  }

  for (const r of sb.reactions ?? []) {
    items.push({
      name: r.name, type: "feat",
      system: { description: descHtml(r), type: { value: "monster", subtype: "" }, activation: { type: "reaction", value: 1 } },
    });
  }

  return items;
}

/**
 * Map a FoundryStatblock to dnd5e Actor data.
 * @param {object} sb  FoundryStatblock
 * @param {string} [biographyHtml]  optional biography to embed in details
 * @returns {{ system: object, items: object[] }}
 */
export function mapToFoundrySystem(sb, biographyHtml = "") {
  const abilities = {};
  for (const k of ABILS) {
    abilities[k] = {
      value: sb.abilities?.[k] ?? 10,
      proficient: sb.saves && sb.saves[k] != null ? 1 : 0,
      bonuses: { check: "", save: "" },
    };
  }

  const skills = {};
  for (const [name] of Object.entries(sb.skills ?? {})) {
    const key = SKILL_KEY[String(name).toLowerCase()];
    if (key) skills[key] = { value: 1 };
  }

  const system = {
    abilities,
    attributes: {
      ac: { flat: sb.ac ?? 10, calc: "flat", formula: "" },
      hp: { value: sb.hp ?? 1, max: sb.hp ?? 1, temp: 0, tempmax: 0, formula: sb.hpFormula ?? "" },
      movement: { walk: sb.speed ?? 30, fly: 0, swim: 0, climb: 0, burrow: 0, hover: false, units: "ft" },
      senses: parseSenses(sb.senses),
    },
    details: {
      cr: sb.cr ?? 0,
      type: { value: sb.type ?? "humanoid", subtype: sb.subtype ?? "", swarm: "", custom: "" },
      alignment: sb.alignment ?? "",
      biography: { value: biographyHtml ?? "", public: "" },
    },
    traits: {
      size: sb.size ?? "med",
      di: { value: sb.damageImmunities ?? [], bypasses: [], custom: "" },
      dr: { value: sb.damageResistances ?? [], bypasses: [], custom: "" },
      dv: { value: sb.damageVulnerabilities ?? [], bypasses: [], custom: "" },
      ci: { value: sb.conditionImmunities ?? [], custom: "" },
      languages: { value: [], custom: sb.languages ?? "" },
    },
    ...(Object.keys(skills).length ? { skills } : {}),
  };

  // Legendary action economy lives on the actor, not the item.
  if (Array.isArray(sb.legendaryActions) && sb.legendaryActions.length) {
    const n = Math.max(1, Math.min(5, sb.legendaryActions.length));
    system.resources = { legact: { value: n, max: n }, legres: { value: 0, max: 0 }, lair: { value: false, initiative: null } };
  }

  return { system, items: buildItems(sb) };
}
