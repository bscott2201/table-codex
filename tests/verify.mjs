// @ts-check
/**
 * tests/verify.mjs
 * Load-time + behavioral verification for the pure pipeline modules. Stubs the
 * minimal Foundry globals so the ESM import graph resolves in plain Node, then
 * asserts the core data-safety invariants:
 *   - envelope factory enforces required fields
 *   - event bus isolates a throwing subscriber
 *   - events sort deterministically by seq
 *   - reconstruction folds a synthetic log into combats + actor state
 *
 * Run: node tests/verify.mjs
 */

// ── Minimal Foundry global stubs ─────────────────────────────────────
const settingsStore = new Map();
const hookCalls = [];
globalThis.Hooks = {
  callAll: (name, ...args) => hookCalls.push({ name, args }),
  on: () => {},
  once: () => {},
};
globalThis.foundry = {
  utils: {
    randomID: (n = 16) => "x".repeat(n).replace(/x/g, () => ((Math.random() * 36) | 0).toString(36)),
    getProperty: (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o),
    deepClone: (o) => structuredClone(o),
  },
};
globalThis.game = {
  world: { id: "test-world", title: "Test World" },
  system: { id: "dnd5e", version: "4.1.0" },
  version: "14.0.0",
  user: { id: "gm-user", isGM: true },
  users: { activeGM: { id: "gm-user" }, contents: [] },
  modules: { get: () => ({ version: "0.6.0", active: true }) },
  settings: {
    settings: { has: () => false },
    get: (_m, k) => settingsStore.get(k),
    set: async (_m, k, v) => settingsStore.set(k, v),
    register: () => {},
    registerMenu: () => {},
  },
};
globalThis.window = { addEventListener: () => {} };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} } };

// ── Tiny assert harness ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// ── Imports (validates the pure import graph) ────────────────────────
const { eventBus } = await import("../scripts/bus/event-bus.js");
const { buildEvent, validateEvent, resetSeq } = await import("../scripts/bus/event-envelope.js");
const { eventStore } = await import("../scripts/bus/event-store.js");
const { sortEvents } = await import("../scripts/reconstruction/timeline.js");
const { reconstructionEngine } = await import("../scripts/reconstruction/reconstruction-engine.js");
const { EVENT_TYPES } = await import("../scripts/core/constants.js");
const { jsonExporter } = await import("../scripts/export/json-exporter.js");

console.log("\n[1] Envelope enforcement");
{
  resetSeq(0);
  const evt = buildEvent(EVENT_TYPES.HP_CHANGE, { actorId: "a1", metadata: { valueDelta: -5 } });
  ok(evt && evt.id && evt.eventType === EVENT_TYPES.HP_CHANGE, "valid event is built");
  ok(evt.worldId === "test-world" && evt.userId === "gm-user", "context fields populated");
  ok(evt.seq === 1, "sequence increments");
  ok(validateEvent(evt) === true, "valid event passes validation");
  const bad = { ...evt };
  delete bad.sessionId;
  ok(validateEvent(bad) === false, "missing required field fails validation");
}

console.log("\n[2] Event bus subscriber isolation");
{
  let goodGotIt = false;
  const offBad = eventBus.on("*", () => {
    throw new Error("boom");
  });
  const offGood = eventBus.on(EVENT_TYPES.ROLL, () => {
    goodGotIt = true;
  });
  eventBus.emit(buildEvent(EVENT_TYPES.ROLL, { metadata: { formula: "1d20" } }));
  ok(goodGotIt, "good subscriber still receives after another throws");
  offBad();
  offGood();
}

console.log("\n[3] Deterministic ordering by seq");
{
  const shuffled = [
    { seq: 3, epochMs: 30, id: "c" },
    { seq: 1, epochMs: 10, id: "a" },
    { seq: 2, epochMs: 20, id: "b" },
  ];
  const sorted = sortEvents(shuffled);
  ok(sorted.map((e) => e.seq).join(",") === "1,2,3", "events sort by seq ascending");
}

console.log("\n[4] Reconstruction over a synthetic log");
{
  resetSeq(0);
  const mk = (type, opts) => buildEvent(type, opts);
  const events = [
    mk(EVENT_TYPES.SESSION_START, { metadata: { id: "s1" } }),
    mk(EVENT_TYPES.COMBAT_START, {
      metadata: { combatId: "cb1", round: 1, combatants: [{ id: "k1", name: "Hero", actorId: "a1" }] },
    }),
    mk(EVENT_TYPES.COMBAT_TURN, {
      actorId: "a1",
      metadata: { combatId: "cb1", round: 1, turn: 0, activeCombatant: { id: "k1", name: "Hero" } },
    }),
    mk(EVENT_TYPES.SPELL_CAST, { actorId: "a1", metadata: { spellName: "Fire Bolt", castLevel: 0, baseLevel: 0 } }),
    mk(EVENT_TYPES.HP_CHANGE, {
      actorId: "a2",
      metadata: { docName: "Goblin", direction: "damage", valueDelta: -7, after: { value: 3, max: 10 } },
    }),
    mk(EVENT_TYPES.COMBAT_END, { metadata: { combatId: "cb1", finalRound: 1 } }),
    mk(EVENT_TYPES.SESSION_STOP, { metadata: { id: "s1" } }),
  ];
  const r = reconstructionEngine.reconstruct(events);
  ok(r.summary.eventCount === events.length, "all events counted");
  ok(r.combats.length === 1, "one combat reconstructed");
  ok(r.combats[0].rounds[0].turns[0].actions.length >= 2, "actions slotted into the turn");
  ok(r.actors.a2 && r.actors.a2.damageTaken === 7, "actor damage accumulated");
  ok(r.actors.a2.hp.value === 3, "actor HP state updated");
}

console.log("\n[5] JSON export payload shape (raw before reconstruction)");
{
  resetSeq(0);
  const events = [buildEvent(EVENT_TYPES.ROLL, { metadata: { formula: "1d20", total: 17 } })];
  const { payload } = jsonExporter.serialize(events);
  ok(Array.isArray(payload.rawEvents) && payload.rawEvents.length === 1, "rawEvents present");
  ok(Boolean(payload.reconstruction), "reconstruction present");
  ok(payload.module.id === "tablecodex-sync", "module id stamped");
  const keys = Object.keys(payload);
  ok(keys.indexOf("rawEvents") < keys.indexOf("reconstruction"), "raw events serialized before reconstruction");
}

console.log("\n[6] Event store records + flushes (GM authoritative)");
{
  resetSeq(0);
  eventStore.init();
  // Simulate an active session for the envelope sessionId.
  globalThis.TableCodexSync = { sessionManager: { sessionId: "s1" } };
  eventStore.ingest(buildEvent(EVENT_TYPES.MOVEMENT, { tokenId: "t1", metadata: { distance: 30 } }));
  ok(eventStore.size === 1, "GM ingest records to buffer");
  await eventStore.forceFlush();
  const stored = settingsStore.get("rawEventBuffer");
  ok(stored && stored.events.length === 1, "buffer flushed to persisted setting");
}

console.log("\n[7] Combat round numbering (driven by turn metadata)");
{
  resetSeq(0);
  const mk = (type, opts) => buildEvent(type, opts);
  // combat.start reports round 0 (pre-first-round); no combat.round events fire;
  // turns carry their own round number and cross from round 1 into round 2.
  const events = [
    mk(EVENT_TYPES.COMBAT_START, { metadata: { combatId: "cb1", round: 0, combatants: [] } }),
    mk(EVENT_TYPES.COMBAT_TURN, { actorId: "a1", metadata: { combatId: "cb1", round: 1, turn: 0, activeCombatant: { id: "k1", name: "Hero" } } }),
    mk(EVENT_TYPES.COMBAT_TURN, { actorId: "a2", metadata: { combatId: "cb1", round: 1, turn: 1, activeCombatant: { id: "k2", name: "Goblin" } } }),
    mk(EVENT_TYPES.COMBAT_TURN, { actorId: "a1", metadata: { combatId: "cb1", round: 2, turn: 0, activeCombatant: { id: "k1", name: "Hero" } } }),
    mk(EVENT_TYPES.COMBAT_END, { metadata: { combatId: "cb1" } }),
  ];
  const r = reconstructionEngine.reconstruct(events);
  const combat = r.combats[0];
  ok(combat.rounds[0].round === 1, "opening round labeled 1 (not 0) despite combat.start round=0");
  ok(combat.rounds.length === 2, "turns crossing into round 2 create a second round bucket");
  ok(combat.rounds[0].turns.length === 2 && combat.rounds[1].turns.length === 1, "turns slotted into the correct round");
}

console.log("\n[8] Midi save + per-target damage enrichment");
{
  const { targetSummary, saveSpec, isSaveWorkflow, normAttackTotal } = await import(
    "../scripts/integrations/midi-qol.js"
  );
  // Synthetic Fireball workflow modeled on a real capture: save-for-half, one
  // target fails (full damage), one saves (half). Sets use object identity, as Midi does.
  const voidHorror = { id: "tA", actorId: "aA", name: "Void Horror" };
  const prevail = { id: "tB", actorId: "aB", name: "Prevail" };
  const workflow = {
    item: { id: "fb", name: "Fireball" },
    activity: { save: { dc: { value: 15 }, ability: "dex" } },
    damageTotal: 26,
    attackTotal: -100, // Midi "no attack" sentinel for a save spell
    targets: new Set([voidHorror, prevail]),
    hitTargets: new Set([voidHorror, prevail]),
    saves: new Set([prevail]), // only Prevail succeeded
    damageList: [
      { tokenId: "tA", actorId: "aA", appliedDamage: 26, oldHP: 30, newHP: 4, saved: false },
      { tokenId: "tB", actorId: "aB", appliedDamage: 13, oldHP: 40, newHP: 27, saved: true },
    ],
  };
  ok(normAttackTotal(workflow.attackTotal) === null, "save-spell attackTotal sentinel normalized to null");
  ok(isSaveWorkflow(workflow) === true, "save workflow detected");
  const spec = saveSpec(workflow);
  ok(spec.dc === 15 && spec.ability === "dex", "save DC + ability resolved");
  const ts = targetSummary(workflow);
  const a = ts.find((t) => t.tokenId === "tA");
  const b = ts.find((t) => t.tokenId === "tB");
  ok(a.saved === false && b.saved === true, "per-target save outcome captured");
  ok(a.appliedDamage === 26 && b.appliedDamage === 13, "per-target APPLIED damage captured (26 vs 13)");
  ok(b.oldHP === 40 && b.newHP === 27, "per-target HP before/after captured");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
