// @ts-check
/**
 * tests/import-verify.mjs
 * Behavioral tests for the session-prep import builders (Phase 3). Stubs the
 * Foundry document classes (Folder / JournalEntry) with in-memory fakes, then
 * asserts the correctness-critical invariants:
 *   - folders build in dependency order and are idempotent (matched by flag, not name)
 *   - journal page ownership is correct (read-aloud = 2 / OBSERVER, GM pages = 0)
 *   - re-import updates in place (no duplicate documents) and reconciles pages
 *   - import-manager emits stages and reports created/updated counts
 *
 * Run: node tests/import-verify.mjs
 */

// ── Minimal Foundry global stubs (mirrors verify.mjs) ────────────────
const settingsStore = new Map();
globalThis.Hooks = { callAll: () => {}, on: () => {}, once: () => {} };
let _id = 0;
const nextId = () => `id${++_id}`;
globalThis.foundry = {
  CONST: { JOURNAL_ENTRY_PAGE_FORMATS: { HTML: 1, MARKDOWN: 2 } },
  utils: { randomID: () => nextId() },
};
globalThis.CONST = globalThis.foundry.CONST;
globalThis.game = {
  world: { id: "test-world", title: "Test World" },
  system: { id: "dnd5e", version: "5.0.0" },
  version: "14.0.0",
  user: { id: "gm", isGM: true },
  users: { activeGM: { id: "gm" }, contents: [] },
  modules: { get: () => ({ version: "0.7.5", active: true }) },
  settings: {
    settings: { has: () => false },
    get: (_m, k) => settingsStore.get(k),
    set: async (_m, k, v) => settingsStore.set(k, v),
    register: () => {},
  },
  folders: [],
  journal: [],
  actors: [],
  scenes: [],
};
globalThis.CONFIG = { DND5E: { activityTypes: { attack: {}, save: {} } } };
globalThis.ui = { notifications: { warn() {}, info() {}, error() {} }, sidebar: { activateTab() {} } };

// ── Fake document classes ────────────────────────────────────────────
class FakeFolder {
  constructor(data) { Object.assign(this, data); this.id = data.id ?? nextId(); }
  async update(data) { Object.assign(this, data); return this; }
}
globalThis.Folder = {
  async create(data) { const f = new FakeFolder(data); game.folders.push(f); return f; },
};

class FakePage {
  constructor(data) { Object.assign(this, data); this.id = nextId(); }
  async update(data) {
    for (const [k, v] of Object.entries(data)) {
      if (k === "text" && this.text) this.text = { ...this.text, ...v };
      else this[k] = v;
    }
    return this;
  }
}
class FakeJournal {
  constructor(data) {
    Object.assign(this, data);
    this.id = data.id ?? nextId();
    this.pages = (data.pages ?? []).map((p) => new FakePage(p));
  }
  async update(data) {
    const { pages, ...rest } = data;
    Object.assign(this, rest);
    return this;
  }
  async createEmbeddedDocuments(type, docs) {
    const created = docs.map((d) => new FakePage(d));
    this.pages.push(...created);
    return created;
  }
  async deleteEmbeddedDocuments(type, ids) {
    this.pages = this.pages.filter((p) => !ids.includes(p.id));
    return ids;
  }
}
globalThis.JournalEntry = {
  async create(data) { const j = new FakeJournal(data); game.journal.push(j); return j; },
};

class FakeItem {
  constructor(data) { Object.assign(this, data); this.id = nextId(); }
}
class FakeActor {
  constructor(data) {
    Object.assign(this, data);
    this.id = data.id ?? nextId();
    this.items = (data.items ?? []).map((it) => new FakeItem(it));
  }
  async update(data) { const { items, ...rest } = data; Object.assign(this, rest); return this; }
  async createEmbeddedDocuments(type, docs) {
    const created = docs.map((d) => new FakeItem(d));
    this.items.push(...created);
    return created;
  }
  async deleteEmbeddedDocuments(type, ids) {
    this.items = this.items.filter((it) => !ids.includes(it.id));
    return ids;
  }
}
globalThis.Actor = {
  async create(data) { const a = new FakeActor(data); game.actors.push(a); return a; },
};

class FakeScene {
  constructor(data) { Object.assign(this, data); this.id = data.id ?? nextId(); }
  async update(data) { Object.assign(this, data); return this; }
}
globalThis.Scene = {
  async create(data) { const s = new FakeScene(data); game.scenes.push(s); return s; },
};

// ── assert harness ───────────────────────────────────────────────────
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

const { buildFolders } = await import("../scripts/import/folder-manager.js");
const { buildJournals } = await import("../scripts/import/journal-builder.js");
const { ImportManager } = await import("../scripts/import/import-manager.js");

const PLAN_ID = 42;
const FOLDERS = [
  { key: "journals-root", name: "The Vault", type: "JournalEntry" },
  { key: "actors-root", name: "The Vault", type: "Actor" },
  { key: "actors-enemies", name: "Enemies", type: "Actor", parentKey: "actors-root" },
];
const JOURNALS = [
  {
    name: "The Gate", folderKey: "journals-root", entryOwnershipDefault: 0,
    pages: [
      { name: "Read Aloud", html: "<aside>x</aside>", ownershipDefault: 2 },
      { name: "GM Notes", html: "<p>secret</p>", ownershipDefault: 0 },
    ],
    flags: { tablecodex: { planId: PLAN_ID, sceneId: "scene-the-gate-abc12345" } },
  },
];

console.log("\n[1] Folder hierarchy");
const ids = await buildFolders(FOLDERS, PLAN_ID);
ok(ids.size === 3, "all three folders created");
const enemyFolder = game.folders.find((f) => f.flags["tablecodex-sync"]?.folderKey === "actors-enemies");
ok(enemyFolder?.folder === ids.get("actors-root"), "subfolder parented to actors-root");
ok(game.folders.every((f) => f.flags["tablecodex-sync"]?.planId === PLAN_ID), "folders carry planId flag");

console.log("\n[2] Folder idempotency (re-run)");
const before = game.folders.length;
const ids2 = await buildFolders(FOLDERS, PLAN_ID);
ok(game.folders.length === before, "re-run creates no duplicate folders");
ok(ids2.get("journals-root") === ids.get("journals-root"), "stable folder id across runs");

console.log("\n[3] Journal ownership + creation");
const r1 = await buildJournals(JOURNALS, ids, PLAN_ID);
ok(r1.created === 1 && r1.updated === 0, "one journal created");
const gate = game.journal.find((j) => j.flags["tablecodex-sync"]?.sceneId === "scene-the-gate-abc12345");
ok(gate?.ownership?.default === 0, "entry is GM-only (0)");
const readAloud = gate.pages.find((p) => p.name === "Read Aloud");
const gmNotes = gate.pages.find((p) => p.name === "GM Notes");
ok(readAloud?.ownership?.default === 2, "Read Aloud page is OBSERVER (2)");
ok(gmNotes?.ownership?.default === 0, "GM Notes page is NONE (0)");
ok(readAloud?.text?.format === 1, "page stored as HTML format");

console.log("\n[4] Journal idempotency (re-import)");
const r2 = await buildJournals(JOURNALS, ids, PLAN_ID);
ok(r2.created === 0 && r2.updated === 1, "re-import updates, does not create");
ok(game.journal.length === 1, "no duplicate journal entry");
ok(game.journal[0].pages.length === 2, "pages reconciled to two");

console.log("\n[5] import-manager orchestration");
const payload = { meta: { planId: PLAN_ID }, folders: FOLDERS, journals: JOURNALS };
const mgr = new ImportManager(payload);
const seenStages = [];
mgr.addEventListener("stage", (e) => seenStages.push(e.detail.stage));
const result = await mgr.run({ journals: true });
ok(seenStages.includes("folders") && seenStages.includes("journals"), "emits folder + journal stages");
ok(result.journals.updated === 1, "manager reports journal updated on third pass");

// ── Phase 4: statblock mapper + actors ───────────────────────────────
const { detectSystem } = await import("../scripts/integrations/dnd5e.js");
detectSystem(); // version 5.0.0 → hasActivities() true
const { mapToFoundrySystem } = await import("../scripts/import/statblock-mapper.js");
const { buildActors } = await import("../scripts/import/actor-builder.js");
const { linkActorReferences } = await import("../scripts/import/reference-linker.js");
const { buildScenes } = await import("../scripts/import/scene-builder.js");

const SKELETON_SB = {
  source: "srd", ac: 13, hp: 13, hpFormula: "2d8+4", speed: 30,
  abilities: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
  cr: 0.25, size: "med", type: "undead", subtype: "skeleton",
  saves: { dex: 4 }, skills: { perception: 2, stealth: 4 },
  damageImmunities: ["poison"], conditionImmunities: ["poisoned"],
  senses: "darkvision 60 ft.", languages: "understands all it knew in life",
  traits: [{ name: "Undead Nature", desc: "Doesn't require air." }],
  actions: [
    { name: "Shortsword", desc: "Melee Weapon Attack: reach 5 ft.", attackBonus: 4, damageDice: "1d6+2", damageType: "piercing" },
    { name: "Withering Gaze", desc: "DC 13 Wisdom saving throw.", saveAbility: "wis", saveDC: 13, damageDice: "2d6", damageType: "necrotic" },
  ],
  legendaryActions: [{ name: "Move", desc: "Moves up to its speed." }],
};

console.log("\n[6] statblock-mapper core stats");
const mapped = mapToFoundrySystem(SKELETON_SB, "<p>bio</p>");
ok(mapped.system.attributes.ac.flat === 13 && mapped.system.attributes.ac.calc === "flat", "AC flat=13");
ok(mapped.system.attributes.hp.value === 13 && mapped.system.attributes.hp.max === 13, "HP value+max set");
ok(mapped.system.attributes.movement.walk === 30, "walk speed mapped");
ok(mapped.system.abilities.dex.value === 14 && mapped.system.abilities.dex.proficient === 1, "DEX value + save proficiency");
ok(mapped.system.details.type.value === "undead" && mapped.system.details.type.subtype === "skeleton", "creature type + subtype");
ok(mapped.system.traits.size === "med" && mapped.system.traits.di.value.includes("poison"), "size + damage immunity");
ok(mapped.system.attributes.senses.ranges.darkvision === 60, "darkvision parsed to senses.ranges (dnd5e v5)");
ok(mapped.system.skills.prc?.value === 1 && mapped.system.skills.ste?.value === 1, "skills mapped to dnd5e keys");
ok(mapped.system.resources?.legact?.max === 1, "legendary action resource set");

console.log("\n[7] statblock-mapper items + activities");
const sword = mapped.items.find((it) => it.name === "Shortsword");
ok(sword?.type === "weapon", "attack action → weapon item");
const atk = Object.values(sword.system.activities)[0];
ok(atk?.type === "attack" && atk.attack.flat === true && atk.attack.bonus === "4", "attack activity flat to-hit +4");
ok(atk.damage.parts[0].number === 1 && atk.damage.parts[0].denomination === 6 && atk.damage.parts[0].bonus === "2", "damage 1d6+2 parsed");
ok(atk.damage.parts[0].types[0] === "piercing", "damage type piercing");
const gaze = mapped.items.find((it) => it.name === "Withering Gaze");
const save = Object.values(gaze.system.activities)[0];
ok(save?.type === "save" && save.save.ability[0] === "wis" && save.save.dc.formula === "13", "save activity DC 13 wis");
const legend = mapped.items.find((it) => it.name === "Move");
ok(legend?.system.activation?.type === "legendary", "legendary action item activation");
ok(mapped.items.find((it) => it.name === "Undead Nature")?.type === "feat", "trait → passive feat");

console.log("\n[8] actor-builder NPC + enemy");
const ACTORS = [
  { name: "Gravekeeper Mol", type: "npc", folderKey: "actors-npcs", statblock: null, biography: "<p>guards</p>", flags: { tablecodex: { planId: PLAN_ID } } },
  { name: "Skeleton", type: "npc", folderKey: "actors-enemies", statblock: SKELETON_SB, biography: "", flags: { tablecodex: { planId: PLAN_ID, sceneId: "scene-the-gate-abc12345" } } },
  { name: "Wraith", type: "npc", folderKey: "actors-enemies", statblock: null, fallback: { ac: 13, hp: 67 }, biography: "", flags: { tablecodex: { planId: PLAN_ID, sceneId: "scene-the-gate-abc12345" } } },
];
const ar = await buildActors(ACTORS, ids, PLAN_ID);
ok(ar.created === 3, "three actors created");
const mol = game.actors.find((a) => a.name === "Gravekeeper Mol");
ok(mol.items.length === 0 && /guards/.test(mol.system.details.biography.value), "NPC actor: biography, no items");
const skel = game.actors.find((a) => a.name === "Skeleton");
ok(skel.system.attributes.ac.flat === 13 && skel.items.length > 0, "enemy actor: full system + items");
const wraith = game.actors.find((a) => a.name === "Wraith");
ok(wraith.system.attributes.ac.flat === 13 && wraith.system.attributes.hp.max === 67, "fallback ac/hp actor");
ok(ar.idByName.get("skeleton") === skel.id, "idByName maps name → actor id");

console.log("\n[9] actor idempotency");
const before9 = game.actors.length;
const ar2 = await buildActors(ACTORS, ids, PLAN_ID);
ok(game.actors.length === before9, "re-import creates no duplicate actors");
ok(ar2.updated === 3 && ar2.created === 0, "re-import updates in place");

console.log("\n[10] reference-linker @UUID into GM Notes");
const payload10 = { meta: { planId: PLAN_ID }, actors: ACTORS };
const linkRes = await linkActorReferences(payload10, ar2.idByName, PLAN_ID);
const gmPage = game.journal
  .find((j) => j.flags["tablecodex-sync"]?.sceneId === "scene-the-gate-abc12345")
  .pages.find((p) => p.name === "GM Notes");
ok(linkRes.linked >= 1, "linker reports links");
ok(/@UUID\[Actor\./.test(gmPage.text.content), "GM Notes page contains an @UUID actor link");

// ── Phase 6: scenes ──────────────────────────────────────────────────
console.log("\n[11] scene-builder");
await game.settings.set("tablecodex-sync", "apiUrl", "https://api.example.com");
const sceneFolders = await buildFolders([{ key: "scenes-root", name: "The Vault", type: "Scene" }], PLAN_ID);
const SCENES = [
  { name: "The Gate", folderKey: "scenes-root", backgroundSrc: "/api/storage/objects/battle-maps/plan-42/gate.png", journalSceneKey: "scene-the-gate-abc12345", flags: { tablecodex: { planId: PLAN_ID, sceneId: "scene-the-gate-abc12345" } } },
  { name: "Hall of Bones", folderKey: "scenes-root", backgroundSrc: null, journalSceneKey: "scene-hall-xyz", flags: { tablecodex: { planId: PLAN_ID, sceneId: "scene-hall-xyz" } } },
];
const sr = await buildScenes(SCENES, sceneFolders, PLAN_ID);
ok(sr.created === 2, "two scenes created");
const gateScene = game.scenes.find((s) => s.name === "The Gate");
ok(
  gateScene.background?.src === "https://api.example.com/api/storage/objects/battle-maps/plan-42/gate.png",
  "relative background resolved against API base",
);
const gateJournalId = game.journal.find((j) => j.flags["tablecodex-sync"]?.sceneId === "scene-the-gate-abc12345").id;
ok(gateScene.journal === gateJournalId, "scene linked to its narrative journal");
ok(gateScene.folder === sceneFolders.get("scenes-root"), "scene placed in scenes folder");
const hallScene = game.scenes.find((s) => s.name === "Hall of Bones");
ok(hallScene.background === undefined, "scene without a map has no background");

console.log("\n[12] scene idempotency");
const before12 = game.scenes.length;
const sr2 = await buildScenes(SCENES, sceneFolders, PLAN_ID);
ok(game.scenes.length === before12, "re-import creates no duplicate scenes");
ok(sr2.updated === 2, "re-import updates scenes in place");

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
