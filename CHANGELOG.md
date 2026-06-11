# Changelog

## 0.5.1 — Clean Action Metadata

**Speaker sanitization hardened:** `_serializeMessage` now explicitly checks `typeof userId === "string"` before assigning, ensuring the full User document (with hotbar, flags, permissions) can never appear in `speaker.userId`. `sceneName` added to speaker object.

**Title / subtitle extraction:** Both `_extractHtmlTitle` and `_extractHtmlSubtitle` added to `telemetry-recorder.js` and `event-normalizer.js`. Title queries `.item-name`, `.action`, `h3`, `h4`. Subtitle queries `.subtitle`, `.card-subtitle`, `.item-type`. These are used as the fallback when dnd5e flags are absent.

**`_classifyActionType`:** Classifies each action as `spell / weapon / feat / damage / unknown` using itemType → subtitle keywords → HTML content, in priority order. Examples:
- Subtitle containing "Evocation" or "1st Level" → `spell`
- Subtitle containing "Melee", "Natural", "Martial", "Ranged" → `weapon`
- Subtitle containing "Feature" or "Trait" → `feat`
- HTML containing `midi-qol-damage-card` → `damage`

**`_parseSubtitle`:** Extracts `spellLevel` (integer, 0 for cantrip) and `school` (Evocation, Conjuration, etc.) from subtitle text via regex.

**`_resolveItemMeta`:** Tries `fromUuidSync(itemUuid)` → actor's item collection → world items to get spellLevel, school, activation, range, save DC, and damage parts directly from the live item document.

**`_parseMidiQolDamage`:** Detects MIDI-QOL damage card HTML (`.midi-qol-damage-card`, `.midi-qol-dmg-row`). Extracts target name, actor ID (from `data-actor-uuid`), HP before/after/delta, and damage amount per row. Results go into `event.damage[]` and `event.action.type = "damage"`.

**`_extractAction` rewritten:** Chains flags → embedded item doc → subtitle → live item resolution into a single comprehensive action object. Never returns partial data when full data is available via a different path.

**Debug counts:** `telemetryRecorder.getDebugCounts()` returns `spellActionCount`, `weaponActionCount`, `featureActionCount`, `damageCardCount`, `hpChangeCount`, `initiativeRollCount`. All shown in the `syncSession` pre-flight console log.

**Initiative suppression:** When `message.flavor` contains "initiative", `message.category` is set to `"initiative"` and `roll.type` is `"initiative_roll"`.

**`event-normalizer.js`:** Added `subtitle` and `id` fields to normalized chat output. `_extractChatSubtitle` added.

**Schema version:** `1.1.0` → `1.2.0`

## 0.5.0 — Rich Session Telemetry

**New file: `scripts/telemetry-recorder.js`** — parallel event capture system that produces structured `TableCodexTelemetryEvent` objects for gameplay replay.

**Event types captured:**
- `chat_message` + embedded roll events (`attack_roll`, `damage_roll`, `healing_roll`, `saving_throw`, `ability_check`, `skill_check`, `initiative_roll`, `tool_check`)
- `damage_applied` / `healing_applied` / `temp_hp_changed` / `actor_updated` — with HP before/after/delta
- `token_moved` — with position before/after
- `target_selected` / `target_cleared` — per-user target map
- `combat_started` / `combat_round_changed` / `combat_turn_changed` / `combat_ended`
- `initiative_set` / `combatant_defeated` / `combatant_revived`
- `condition_added` / `condition_updated` / `condition_removed`
- `item_created` / `item_updated` / `item_deleted`
- `scene_viewed` / `scene_updated`
- `template_placed` (AOE templates)
- `journal_created` / `journal_updated`
- `audio_cue` / `audio_started` / `audio_stopped`
- `session_started` / `session_ended`

**Each event includes:**
- Full user context (id, name, role, isGM)
- Scene context (id, name, active)
- Combat context (id, round, turn, active combatant)
- Actor/token snapshots where relevant
- Action details (item name, spell level, save DC, damage parts) via dnd5e flag extraction
- HP correlation: `damage_applied` events include a `correlatedAction` field linking to the most recent damage roll that targeted that actor

**Pre-update snapshot pattern:** `preUpdateActor` and `preUpdateToken` hooks run at module scope (always, not just during session) to ensure before-state is captured. Event emission is gated on `_active === true`.

**Target tracking:** `targetToken` hook maintains a per-user Map of current targets. When a chat roll fires, the user's current targets are embedded in the event as `targets[]`.

**dnd5e extraction:** `_extractAction()` reads `message.flags.dnd5e`, `message.item` (3.x), and `message.item` embedded document to extract item name, type, spell level, activation, range, save DC, and damage parts.

**HP correlation buffer:** A rolling buffer of the last 20 attack/damage rolls is maintained. When `damage_applied` fires, `_findRecentAction()` scans backwards for a damage roll that targeted the same actor.

**Settings added:** `captureChat`, `captureCombat`, `captureActorUpdates`, `captureTokenMovement`, `captureConditions`, `captureJournals`, `capturePlaylists` (default off), `includeRawPayloads` (default off), `telemetryQueueMaxSize` (default 2000).

**Payload:** `buildPayload()` now includes `telemetryEvents: []` alongside the existing legacy arrays. Legacy arrays are preserved for backwards compatibility.

**`window.TableCodexSync`** now includes `telemetryRecorder` for console inspection.

## 0.4.0 — Capture Modes & Payload Sanitization

**New setting: `captureMode`** — `minimal` / `standard` (default) / `full_snapshot`

**`standard` mode (new default):** Captures chat, rolls, combat events, scene views, actor/item update events during the session, and minimal snapshots of actors/items that appear in chat or rolls. Does NOT dump the full world actor/item/scene list at session start/end. A 664-actor world now produces 0 session-open snapshots; only actors that actually participated in the session are included.

**`full_snapshot` mode:** Preserves old behavior — full world snapshots at session-open and session-close. Use for debug/recovery. Exports may be large and noisy.

**`minimal` mode:** Chat, rolls, combat, scene views, and referenced entities only. No actor/item update events.

**Reference tracking:** `_referencedActorIds`, `_referencedItemIds`, `_referencedSceneIds` sets track entities encountered during the session via chat speaker, roll speaker, item card HTML (`data-actor-id`, `data-item-id`, `data-actor-uuid`, `data-item-uuid`), and combat combatants. At export time, any referenced actor/item not already in the activity records gets a minimal snapshot added.

**Minimal snapshots:** `_minimalActorSnapshot` includes `hp`, `hpMax`, `ac`, `disposition` — no full system blob. `_minimalItemSnapshot` includes `actionType`, `damage.parts`, `activation` — no full system blob. These replace the per-entity system dump for non-`full_snapshot` modes.

**Chat message improvements:** `normalizeChat` now adds `contentText` (HTML stripped), `title` (first heading/item-name), `category` (`roll`/`emote`/`ooc`/`whisper`/`ic`), `referencedActorIds`, `referencedItemIds`. Speaker is sanitized to `{ userId, userName, actorId, actorName, tokenId, sceneId, sceneName }` — never a full User document.

**New setting: `includeRawHtml`** (default `true`) — set to `false` to omit `contentRaw` from chat exports and reduce payload size.

**Schema version bumped to `1.1.0`** — the `captureMode` field is now present at the root of the payload. The web app should continue to accept `1.0.0` exports.

**Summary counts updated:** `actorReferenceCount`, `itemReferenceCount`, `sceneVisitedCount`, `journalReferenceCount` replace the old generic snapshot counts. `snapshotActorCount`/`snapshotItemCount`/`snapshotSceneCount` only appear when `captureMode === full_snapshot`.

## 0.3.9 — Payload Array Logging

Added `console.log` in `syncSession` immediately before the POST fires. Logs the envelope's top-level keys and the length of every array in the nested payload object so it's easy to confirm data was captured before it hits the server.

## 0.3.8 — Sync Success / Intake Flow

**New response shape handled:** `POST /session-import` may now return `{ importId, intakeId, status, message }` in addition to the legacy `{ importId }` shape. Both shapes work.

**`_notifySyncSuccess(result)`** — shared helper called by `syncSession`, `retrySyncSession`, and `forceSyncSession`. Shows `result.message` from the server when present (e.g. "VTT session received. Add audio or continue without audio."), otherwise falls back to "Session uploaded to TableCodex. Finish intake on your campaign dashboard." If the server ever returns `dashboardUrl` or `intakeUrl`, copies it to clipboard automatically.

**`markSynced(importId, intakeId)`** in `session-recorder.js` — stores `remoteIntakeId` on the in-memory session alongside `remoteImportId`.

**`markSessionSynced(localSessionId, remoteImportId, remoteIntakeId)`** in `session-store.js` — persists `remoteIntakeId` to the unsynced sessions store.

**Panel** — synced session now shows: "Uploaded" status indicator, Intake ID (if present), Import ID, and "Finish intake on your campaign dashboard." hint.

Audio upload is intentionally NOT implemented in this module — audio attachment happens in the TableCodex web app intake flow.

## 0.3.7 — campaignId Type Fix

**Root cause:** `selectedCampaignId` is stored as a string in Foundry settings (settings system only accepts `String` type). The TableCodex API schema requires `campaignId: number`. Every API call was sending `campaignId: "6"` when the server expected `campaignId: 6`.

**New helper in `settings.js`:** `getSelectedCampaignIdForApi()` — reads the raw string, coerces with `Number()`, returns `null` if the result is not a finite positive number.

**`api-client.js` `linkWorld`:** uses `getSelectedCampaignIdForApi()`; if it returns null, blocks with "Campaign ID X could not be parsed as a number. Re-select the campaign."

**`exporter.js` `syncSession`:** same guard — uses `getSelectedCampaignIdForApi()`, blocks if null.

**`exporter.js` `retrySyncSession` / `forceSyncSession`:** coerces `rec.campaignId || getSetting(...)` through `Number()` with the same null-check guard.

**Debug logging:** all three sync paths now log `campaignId raw: "6", parsed: 6, type: number` so the coercion is always visible.

**JSON export unchanged** — `buildPayload()` can keep `campaignId` as string for the local export file; only API sync paths use the numeric form.

## 0.3.6 — Exporter Syntax Fix

**Root cause:** `_buildMarkdown` in `exporter.js` contained raw em dash characters (`—`, U+2014) inside `${...}` template expressions (lines 391, 433). Foundry's Electron V8 build rejected these as a `SyntaxError: Missing } in template expression`, which caused the entire import chain to fail — no hooks, no settings, no UI.

**Fix:** `_buildMarkdown` completely rewritten using plain string concatenation (`+`) and indexed `for` loops. No template literals, no raw non-ASCII inside expressions. Em dash defined as `var DASH = "—"` (a safe Unicode escape) and used only in string concatenation context.

**Also replaced** in the rest of `exporter.js`: all template literals in non-Markdown code replaced with `+` concatenation for safety. `??` and `||` operators inside `${}` removed. `Object.assign` used instead of spread in `forceSyncSession` for older-V8 compatibility.

All 10 JS files pass `node --check` after this fix.

## 0.3.5 — Hook Registration Fix

**Root cause fixed:** `class TableCodexPanelMenuShim extends FormApplication` was at module scope (line 16 of main.js). ESModule top-level code executes at parse time — before `init` fires, before Foundry's class globals are ready. If `FormApplication` is undefined at that instant the whole file throws and zero hooks register, which matched the observed symptom exactly.

**Fix:** `TableCodexSettingsMenu` class is now defined inside `registerSettingsMenu()`, which is called from inside the `init` hook callback. It's only evaluated after Foundry's core has initialized.

**`templates/blank.hbs`** — added; `registerMenu` requires a template path even for a shim.

**Per-file diagnostics** — `console.log("[TableCodex Sync] X.js evaluated")` added to `settings.js`, `ui.js`, `session-recorder.js`, and `main.js`. If a file fails to evaluate its log will be absent, pointing directly at the broken import.

**`globalThis.TableCodexSync`** — a loading-state stub is set immediately after imports (before hooks), then replaced with the full object during `ready`. `TableCodexSync.openPanel()` is safe to call from the console at any point after the module loads.

**String concatenation** — replaced all template literals in hook-critical paths with plain string concatenation (`+`) to avoid any edge-case parsing issues.

**`renderSettings` DOM injection removed** — replaced entirely by `game.settings.registerMenu`.

## 0.3.4 — UI Hardening Pass

- `window.TableCodexSync` now includes `openUnsyncedDialog`, `getSetting`, `setSetting` in addition to `openPanel`, `refreshPanel`, `sessionRecorder`, `apiClient`
- `ui.controls?.render?.(true)` — passes `true` to force a full re-render of the toolbar on `ready`
- `injectSceneControls`: resolves token group as `controls.tokens ?? controls.token` to handle both V14 key names; sets `order: 999/1000` and `visible: game.user.isGM`; sets both `onChange` and `onClick` on all tools; expanded debug logging shows isGM, controls shape, key list before and after injection
- Startup diagnostics: logs `game.modules.get(MODULE_ID).url` and `.active` to confirm folder name matches module ID

## 0.3.3 — V14 UI Reliability

- **`registerMenu`**: Proper `TableCodexPanelMenuShim extends FormApplication` defined at module scope in `main.js`. Opens the TableCodex panel when the settings menu button is clicked. Button appears under Configure Settings → Module Settings → TableCodex Sync → "Open TableCodex Sync".
- **`renderSettings` hook removed**: No longer relies on DOM injection into `#settings-game` / `.settings-list`.
- **`injectSceneControls` V14 rewrite**: Detects V14 object-keyed controls (`controls.tokens.tools`) vs V13 array separately. V14 path sets `order`, `visible`, `onChange` exactly per V14 API. V13 path sets `onClick` + `onChange`. Logs the controls shape to console on every call for easy diagnosis.
- **Template paths**: Both `TableCodexPanel` and `UnsyncedSessionsDialog` now use `` `modules/${MODULE_ID}/templates/...` `` instead of the hardcoded string, so they survive any folder-name mismatch.
- **`window.TableCodexSync`**: Exposed on `ready` — `TableCodexSync.openPanel()` works from the browser console.
- **Startup diagnostics**: Full `console.group` on `ready` showing module id, version, Foundry version, system, world id, GM status, and settings registration state.
- **`ui.controls?.render()`**: Called at end of `ready` (GM only) to force toolbar repaint so buttons appear without a manual scene reload.
- **`apiClient` import**: Added to `main.js` imports so it's included in the `window.TableCodexSync` global.

## 0.3.2 — UI Visibility Fix

- **Root cause fixed**: `type: Array` is not a valid Foundry setting type — changed to `type: Object` with `{ sessions: [] }` wrapper. This was silently crashing `registerSettings()`, which prevented ALL hooks from running (no canvas buttons, no settings menu)
- **`FormApplication` shim removed**: The `_PanelLauncher extends FormApplication` approach was unreliable in V14 where `FormApplication` is deprecated
- **`renderSettings` hook added**: Injects an "Open TableCodex Sync" button directly into Foundry's Game Settings sidebar — no class inheritance required, works in all V13/V14 builds
- **`console.error` added around `registerSettings()`**: Init will now log exactly where it fails instead of dying silently
- **`session-store.js`**: All write helpers now use `_saveAll({ sessions: arr })` consistently; `getUnsyncedSessions()` handles both the new wrapper format and legacy plain-array format

## 0.3.1 — UI Entry Points Fix

- **Settings menu restored**: `game.settings.registerMenu` now adds an "Open Panel" button under Game Settings → Module Settings → TableCodex Sync — the most reliable entry point, works even if canvas hooks fail
- **Canvas toolbar fixed**: scene control button callbacks changed from `onChange` (toggle hook) to `onClick` (button hook) for Foundry V14; both `onClick` and `onChange` are set for V13/V14 compatibility
- Extracted `_toggleSession` named function to avoid duplicating the start/stop logic for both callback properties

## 0.3.0 — Unsynced Session Recovery

**New file: `scripts/session-store.js`** — persistent CRUD store for unsynced session records. Each record contains display metadata + the full `normalizedPayload` so retry/force-sync works after a Foundry reload.

**New setting: `unsyncedSessions`** — world-scoped array persisted by the store.

**Session end integration** — `sessionRecorder.stop()` now calls `_persistToStore()` which snapshots the full `buildPayload()` output into the store with `status: "unsynced"`. Every ended session is recoverable.

**`syncSession()` integration** — marks the session pending before the POST, synced on success, failed (with error text) on failure. Failed sessions stay in the store and retain their payload for retry.

**New `exporter.js` functions:**
- `retrySyncSession(id)` — uses stored `normalizedPayload` verbatim; falls through to force sync if payload is absent
- `forceSyncSession(id)` — always rebuilds the envelope, injecting current `campaignId` + `getWorldInfo()` over any missing/stale fields in the stored record
- `exportUnsyncedJson(id)` / `exportUnsyncedMarkdown(id)` — download exports from stored sessions without needing an API connection

**New `UnsyncedSessionsDialog`** — full Application showing all pending sessions (unsynced, sync_failed, sync_pending). Each card shows: title, campaign, world, dates, event/chat/roll counts, attempt count, last error, payload size. Actions: Retry Sync, Force Sync, Export JSON, Export Markdown, Archive.

**Panel notice** — "X unsynced sessions" warning with "Review" button appears when pending sessions exist.

**Load-time warning** — on `ready`, GM sees a Foundry notification with the count of pending sessions and guidance to open the panel.

**Handlebars helpers** — added `gt` alongside existing `eq` for `{{#if (gt count 1)}}` pluralization.

## 0.2.6 — Payload Shape Fix

**Root fix:** `session-import` and JSON export now include `foundryWorldId` / `foundryWorldName` / `localSessionId` / `startedAt` as top-level fields, which the server and web upload validator require.

**New `scripts/world-info.js`** — `getWorldInfo()` returns `{ foundryWorldId, foundryWorldName, foundryVersion, systemId, moduleVersion }` with a full defensive fallback chain:
- `game.world.id` → `game.world._id` → `game.world.title` → stored setting → `"unknown-world"`
- Falls back to stored setting before using the sentinel value
- Logs a warning if any fallback is used

**`buildPayload()` in session-recorder** — now includes flat top-level fields (`foundryWorldId`, `foundryWorldName`, `campaignId`, `campaignName`, `localSessionId`, `startedAt`, `endedAt`) alongside the existing nested `world`/`tablecodex`/`session` objects. Both exist for backwards compatibility.

**`syncSession()` in exporter** — builds a proper envelope for `POST /session-import`:
```
{ campaignId, foundryWorldId, foundryWorldName, foundryVersion, systemId, moduleVersion,
  localSessionId, startedAt, endedAt, source: "api_sync", payload: <normalized> }
```
Validates all required fields before the request; logs a summary in debug mode.

**`exportJson()`** — validates required fields before writing the file; logs export metadata in debug mode; blocks with a clear notification if `foundryWorldId` or `localSessionId` is missing.

**`linkWorld()`** — uses `getWorldInfo()` consistently; no more duplicated world extraction logic.

## 0.2.5 — Ping/Connect Hardening

- `pingApi` 404 → new `"unavailable"` state; shows advisory "Ping endpoint not available yet. Try Fetch Campaigns to verify token access." and still auto-fetches campaigns (token may be valid even if ping route isn't deployed)
- `ApiError` now carries `missingFields` parsed from response body; `linkWorld` surfaces them as "Missing required fields: campaignId, ..."
- `linkWorld` body: `foundryWorldName` falls back to `game.world.id` if title is empty; all four fields pre-validated locally before fetch; full body logged on failure (no token)
- `_safeCampaignId()` helper rejects `undefined`, `null`, `""`, `"[object Object]"` before any API call
- `_onSaveCampaign` validates raw `<select>` value defensively before writing to settings
- `_onFetchCampaigns` auto-select guard checks `typeof c.id === "string"` before saving
- `MODULE_VERSION` imported directly into `api-client.js` as fallback for `game.modules.get()`
- Panel shows amber "Ping N/A — use Fetch Campaigns" for `apiState: "unavailable"`

## 0.2.4 — Decoupled Connection Flow & Localization Fix

**Flow changes:**
- Test API Connection (`pingApi`) now calls GET `/api/integrations/foundry/ping` — no campaign required
- Fetch Campaigns also requires only URL + token, no campaign
- Link World to Campaign calls POST `/api/integrations/foundry/connect` — requires campaign
- Sync still requires campaign; JSON/MD export warns but does not block when no campaign is selected

**Validators split:**
- `validateApiCredentials()` — URL + token only (ping, fetchCampaigns)
- `validateReadyToSync()` — URL + token + campaign (linkWorld, syncSession)

**New `worldLinked` setting** — set true on successful `linkWorld()`, reset automatically when campaign selection changes

**Panel states** — three independent indicators: API (`untested/ok/failed`), Campaign (`selected/not`), World Link (`linked/not`)

**Localization fix:**
- Root cause: `TABLECODEX.Panel.Status` (string) and `TABLECODEX.Panel.Status.Campaign` (child path) cannot coexist — Foundry can't traverse through a string value
- Fix: panel template now uses plain string literals for UI labels; `game.i18n.*` used only in JS for notifications, dialogs, and error messages
- `lang/en.json` fully rebuilt with correct nesting — 34 keys verified to resolve correctly
- Removed all orphaned/unused keys from en.json

## 0.2.3 — Campaign Selector

- New settings: `selectedCampaignId`, `selectedCampaignName` (stored internally, not shown in config)
- New API method: `fetchCampaigns()` — GET `/api/integrations/foundry/campaigns`
- Campaign selector in panel: Fetch Campaigns → dropdown → Link World to Campaign
- Auto-selects and saves if only one campaign is returned
- `testConnection` now requires a campaign to be selected and includes `campaignId` in the connect body
- `syncSession` validates url + token + campaign before sending; blocks with friendly message if missing
- `buildPayload()` now includes `tablecodex: { campaignId, campaignName }` in the export JSON
- Markdown export includes Campaign row in session metadata table
- Panel status section shows campaign name, world, token presence, and sync state
- Sync button disabled in template when no campaign is selected
- Handlebars `eq` helper registered for dropdown selected-state logic
- New i18n strings for all campaign/status UI

## 0.2.2 — Token Hardening & UI

- `cleanToken()` helper strips whitespace and surrounding quotes from any raw token value
- `apiToken` setting `onChange` normalizes and re-saves the value immediately when settings are saved — stored token is always clean
- `_token()` in api-client always applies `cleanToken()` on read as a second safety net
- Debug mode logs token length and first 4 characters only (never the full value)
- Debug mode logs final request URL and body for `/connect` before the fetch fires
- Test Connection and Settings footer buttons now have distinct bright colors with white text (`tc-btn--test` teal, `tc-btn--settings` amber)

## 0.2.1 — Connection Debugging

- Fixed connect body field names to match API (`foundryWorldId`, `foundryWorldName`, `systemId`)
- 401 response now shows: "Missing or invalid TableCodex API token."
- 403 response now shows: "TableCodex rejected the token. Regenerate the Foundry token in TableCodex and paste it here."
- Debug mode logs final URL, HTTP status, response body, auth header presence, and world id/name on failure (token value never logged)
- Removed unnecessary custom `X-` headers that could trigger CORS preflight failures
- `ApiError` class carries HTTP status through catch boundary for status-specific messaging

## 0.2.0 — Full Rebuild

- New module ID: `tablecodex-sync` (was `tablecodex-foundry`)
- Flat script layout: `settings.js`, `logger.js`, `session-recorder.js`, `event-normalizer.js`, `exporter.js`, `api-client.js`, `ui.js`
- GM-only session boundary control (Start/End with optional title prompt)
- Session buffer persisted to world settings — survives page reload with auto-resume
- Captures: chat, rolls, combat lifecycle, scene views, actor/item/journal events, token create/delete
- Opening and closing actor/item/scene snapshots at session start and end
- JSON export (full normalized payload) and Markdown export (human-readable summary)
- Stable export schema (`schemaVersion: 1.0.0`) with summary counters
- API sync: POST session payload to TableCodex; stores remote `importId` on success
- Fixed URL construction: `normalizeBaseUrl` / `buildApiUrl` prevent `/api/api` double-prefix regardless of how the base URL is entered
- Additional request headers: `X-Foundry-Version`, `X-TableCodex-World-Id`
- Improved error messaging for network/CORS failures
- Privacy defaults: whispers, private rolls, and journal text off by default
- Debug logging setting gates `console.debug` output

## 0.1.0 — Initial Release

- Session capture (start/stop) for GM users
- Chat message and dice roll capture
- Combat lifecycle events (started, round, turn, ended)
- Scene change events
- D&D 5e actor HP change events
- Local session archive via localStorage (survives API sync)
- Markdown export with YAML frontmatter for manual TableCodex import
- TableCodex API client with full endpoint stubs
- Local-only mode when API key is not configured
- Event deduplication
- Sync queue with auto-flush (15s interval, 50-event batch threshold)
- GM-only panel with Start/Stop/Sync/Export/Clear actions
- Scene controls toolbar button for quick panel access
