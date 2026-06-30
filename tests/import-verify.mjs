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
};
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

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
