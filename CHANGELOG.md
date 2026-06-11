# Changelog

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
