# TableCodex Sync — Foundry VTT Module

Capture Foundry VTT session events and sync or export them to [TableCodex](https://tablecodes.io) for AI-assisted recaps, session timelines, and campaign memory.

## Requirements

- Foundry VTT V14+
- A TableCodex account and API key _(optional for local-only export)_

## Installation

Install directly from the Foundry module browser, or copy the `tablecodex-foundry/` folder into your `Data/modules/` directory and reload Foundry.

## Quick Start

1. Open **Game Settings → Module Settings → TableCodex Sync**.
2. Enter your **API URL** and **API Key** (leave blank for local-only capture).
3. Click the **scroll icon** in the scene toolbar (GM only) to open the TableCodex panel.
4. Press **Start Capture** and enter a session title.
5. Play your session.
6. When done, press **Stop Capture**, then **Export Markdown** to download a `.md` file.

## Features

| Feature | Notes |
|---|---|
| Chat capture | Public messages and rolls; whispers optional |
| Combat events | Started, round, turn, ended |
| Scene changes | On canvas ready |
| Actor HP changes | D&D 5e only; safe for other systems |
| Local archive | Always written; survives API sync |
| Markdown export | YAML frontmatter + human-readable timeline |
| API sync | Batch flush every 15s or 50 events |
| Local-only mode | Works without API key |

## Capture Modes

| Mode | Description |
|---|---|
| `safe` | Minimal data — event type and timestamp only |
| `standard` | Balanced — actor, speaker, summary (default) |
| `detailed` | Full payloads including raw HTML |

## Privacy

- Whispers are **not** captured by default.
- Hidden token names are **not** captured by default.
- Only the GM client captures and syncs events.

## Export Format

The exported `.md` file includes YAML frontmatter compatible with the TableCodex import API and a human-readable timeline with fenced JSON blocks for each event.

## License

MIT
