# Browser extension E2E tests

These Playwright tests load the built Chrome extension in Chromium and exercise the real content scripts, MAIN-world playtest bridge, background service worker, runtime messaging, DOM injection, and network routing against deterministic fixture pages.

Run them with:

```bash
npm run test:e2e
```

That command rebuilds `dist/chrome/` before launching Chromium.

## Harness

`extension-fixture.js` starts Chromium with `dist/chrome/` installed as an MV3 extension. Each test gets a fresh persistent browser profile so extension storage, service workers, and page state do not leak between tests.

The tests install a catch-all network guard before installing deterministic routes. Playwright invokes route handlers in reverse registration order, so mocked fixture routes win and every unmocked page or service-worker request is recorded as a failure. The launch helper also maps `api.github.com` to localhost so MoxMox's startup update check cannot reach the live network before a test has registered routes.

## Fixture coverage

`playwright-foundation.spec.js` serves small Moxfield and Archidekt playtest pages. The Moxfield fixture includes the navbar shape used by `content.js` and a fake React playtest fiber that satisfies `PlaytestController`'s discovery contract. The Archidekt fixture includes the bottom toolbar and life counter trigger used as the widget insertion anchor. This proves the extension wiring works in a real browser without depending on live site markup or APIs.

These tests intentionally do not cover Firefox extension loading. Firefox manifest compatibility is covered by the build smoke tests and `web-ext lint`.
