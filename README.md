# TableCodex Sync — Foundry VTT Module

Capture Foundry VTT session activity and export or sync it to [TableCodex](https://tablecodex.com) for session review, recaps, timelines, and campaign memory.

**The module is a capture/export/sync agent only.** It does not analyze campaign meaning, decide what is canon, or mutate Codex entries. All review, approval, and intelligence lives in the TableCodex web app.

---

## Requirements

- Foundry VTT V14+
- A TableCodex account with API token _(optional — local-only JSON/Markdown export works without it)_

---

## Installation

1. Copy the `tablecodex-sync/` folder into your `Data/modules/` directory, **or** install via the Foundry module browser using the manifest URL.
2. Enable the module in **Game Settings → Manage Modules**.

---

## Configuration

1. Open **Game Settings → Configure Settings → Module Settings → TableCodex Sync**.
2. Enter your **TableCodex API URL** (e.g. `https://app.tablecodex.com`).
3. Paste your **API Token** (found in TableCodex → Settings → Integrations).
4. Click **Test Connection** to verify.
5. Adjust privacy and capture toggles as needed (see [Privacy Settings](#privacy-settings) below).

---

## Starting and Ending a Session

TableCodex Sync records events **only between a defined session start and end**. All capture is GM-only.

### Via the Scene Controls (quickest)

- Click the **scroll icon** (TableCodex Sync) in the token toolbar to open the panel.
- Click the **circle icon** (Start/Stop TC Session) to toggle recording.

### Via the TableCodex Panel

1. Click the scroll icon in the scene toolbar to open the panel.
2. Click **Start Session**, enter an optional session title, and click **Start**.
3. Play your session normally.
4. When done, click **End Session**.

### Reload recovery

If Foundry reloads mid-session (e.g. world restart), the module automatically resumes the active session and notifies the GM. All previously buffered events are preserved.

---

## Exporting a Session

After ending a session (or at any point while recording), use the buttons in the TableCodex panel:

| Button | Output |
|---|---|
| **Export JSON** | Full normalized payload — `tablecodex-session-{world}-{date}-{id}.json` |
| **Export Markdown** | Human-readable summary — `tablecodex-session-{world}-{date}-{id}.md` |

Both files are downloaded directly in the browser.

### Manual upload workflow

1. Export JSON.
2. In TableCodex, go to **Sessions → Import** and upload the JSON file.
3. TableCodex processes it for review and Codex updates.

---

## API Sync Workflow

If API credentials are configured, you can push sessions directly:

1. End the session (or while it is still active for a mid-session sync).
2. Click **Sync to TableCodex** in the panel.
3. The module POSTs to `{apiUrl}/api/integrations/foundry/session-import`.
4. On success, the session is marked synced and the remote import ID is stored locally.
5. If the sync fails, the local buffer is kept intact and you can retry.

Enable **Auto-Sync on Session End** in settings to skip the manual step.

---

## Privacy Settings

All settings default to privacy-safe values.

| Setting | Default | Description |
|---|---|---|
| Capture Whispers | **Off** | Include whispered chat messages in the export |
| Capture Private Rolls | **Off** | Include GM-only and blind rolls |
| Capture Journal Text | **Off** | Include full journal page text |
| Capture Actor Snapshots | On | Actor summaries at session start/end and on changes |
| Capture Item Snapshots | On | Item summaries at session start/end and on changes |
| Capture Scene Snapshots | On | Scene metadata at session start/end and on view |

Only the GM client captures and exports data. Player clients do not record anything.

---

## What Gets Captured

| Category | Events |
|---|---|
| **Chat** | Public messages, speaker, content, flavor, roll data |
| **Rolls** | Formula, total, dice terms, speaker |
| **Combat** | Start, end, round changes, turn changes, combatants |
| **Scenes** | Scene viewed (canvas ready), token created/deleted |
| **Actors** | Created, updated, deleted; snapshots at session open/close |
| **Items** | Created, updated, deleted; snapshots at session open/close |
| **Journals** | Opened (render), updated |

Token movement is not tracked in the current version (MVP priority is chat, rolls, combat, and snapshots).

---

## Export Payload Schema

```json
{
  "schemaVersion": "1.0.0",
  "source": "foundry_vtt",
  "moduleId": "tablecodex-sync",
  "world": { "id": "...", "name": "..." },
  "session": { "localSessionId": "...", "startedAt": "...", "endedAt": "..." },
  "settings": { "captureWhispers": false, ... },
  "summary": { "eventCount": 0, "chatMessageCount": 0, ... },
  "events": [],
  "chatMessages": [],
  "rolls": [],
  "combats": [],
  "actors": [],
  "items": [],
  "scenes": [],
  "journals": []
}
```

---

## Known Limitations

- Token movement is summarized (created/deleted) but not tracked frame-by-frame.
- Large sessions (many actors, many chat messages) may produce large JSON files. A warning appears if the payload exceeds 5 MB.
- The module targets Foundry V14. Earlier versions are not supported.
- Actor/item system summaries capture a shallow subset of the `system` object to avoid excessive data; full system data is not included unless debug logging is enabled.

---

## Development Setup

```bash
# Clone into your Foundry modules directory
cd /path/to/FoundryVTT/Data/modules
git clone <repo-url> tablecodex-sync

# No build step required — plain ES modules, no bundler
```

Reload Foundry after making changes to `.js` files. Templates (`.hbs`) and CSS reload on Foundry soft-refresh.

---

## Foundry V14 Compatibility

This module targets Foundry VTT V14 and uses:
- `Hooks.once("init")` / `Hooks.once("ready")`
- `game.settings.register` / `game.settings.get` / `game.settings.set`
- `Application` base class for the panel
- `getSceneControlButtons` hook with V14 object-keyed controls structure
- ES module imports (no CommonJS)

---

## License

MIT
