# MoxMox — Copilot Instructions

## Project Overview

MoxMox is a browser extension for Chrome and Firefox.

## Architecture

The extension uses a standard Manifest V3 architecture:

- **`src/content.js`** — Content script injected into web pages. Handles DOM interaction.
- **`src/background.js`** — Service worker. Handles background tasks, API calls, and storage.

Shared pure functions live in `src/shared/`.

## Build & Test

```bash
node build.js              # esbuild IIFE bundles → dist/chrome/ and dist/firefox/
node build.js --watch      # watch mode
node --test tests/*.test.js # run all tests
```
