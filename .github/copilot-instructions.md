# MoxMox — Copilot Instructions

## Project Overview

MoxMox is a browser extension for Chrome and Firefox that enables two-player
Magic: The Gathering games on Moxfield's playtest page. It synchronizes game
state between two players over a WebSocket relay server.

## Architecture

The extension uses Manifest V3 with two content scripts:

- **`src/content.js`** — ISOLATED-world content script. Handles UI injection
  (toolbar widget, modals), WebSocket connection to the relay server, game
  flow orchestration, and zone/battlefield sync logic.
- **`src/content-main.js`** — MAIN-world content script. Has access to React
  internals on the Moxfield page. Runs the PlaytestController, handles game
  state manipulation, and communicates with the ISOLATED script via
  `window.postMessage`.
- **`src/background.js`** — Service worker (currently minimal).
- **`src/popup.html`** / **`src/popup.js`** — Extension popup showing
  connection status, username, and WebSocket message log.
- **`server/`** — Cloudflare Worker + Durable Object relay server.

### Key Directories

- **`src/playtest/`** — PlaytestController library for manipulating Moxfield's
  React game state (bridge.js, diff.js, index.js).
- **`src/shared/`** — Pure utility functions (room ID generation, URL helpers).

## Build & Test

```bash
node build.js              # esbuild IIFE bundles → dist/chrome/ and dist/firefox/
node build.js --watch      # watch mode
node --test tests/*.test.js # run all tests
cd server && npm run deploy # deploy relay server to Cloudflare
```

## Important Conventions

- The two content scripts communicate via `window.postMessage` with tag
  `{ moxmox: 'moxmox' }` and a `from` field.
- All game state mutations in the MAIN world go through `withSync()` to
  prevent echo loops.
- Card positions use center-point percentage mirroring for cross-player sync.
- Always deploy the server after changing `server/src/index.js`:
  `cd server && npm run deploy`
