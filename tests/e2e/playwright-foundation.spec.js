import { expect, test } from '@playwright/test';

import { installNetworkGuard, launchExtensionContext } from './extension-fixture.js';

const MOXFIELD_PLAYTEST_URL = 'https://moxfield.com/decks/e2e/goldfish';
const GITHUB_LATEST_URL = 'https://api.github.com/repos/natefinch/moxmox/releases/latest';

test('loads the built extension on a manifest-matched Moxfield playtest origin', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    await routeGithubLatest(extension.context);
    await routeMoxfieldPlaytest(extension.context);

    const page = await extension.context.newPage();
    await page.goto(MOXFIELD_PLAYTEST_URL);

    await expect(page.locator('.moxmox-widget')).toContainText('MoxMox — Play Together');
    await expect(page.locator('.moxmox-set-username-btn')).toHaveText('Set Username');
    expect(extension.serviceWorker.url()).toBe(`chrome-extension://${extension.extensionId}/background.js`);

    await expect.poll(() => page.evaluate(() =>
      window.__moxmoxMessages?.some(message =>
        message?.moxmox === 'moxmox' &&
        message?.from === 'main' &&
        message?.type === 'ready',
      ) ?? false,
    )).toBe(true);

    const result = await sendMainWorldCommand(page, 'get-life');
    expect(result).toEqual({ life: 20 });
    guard.assertNoEscapes();
  } finally {
    await extension.close();
  }
});

test('stores a username through the injected playtest widget prompt', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    await routeGithubLatest(extension.context);
    await routeMoxfieldPlaytest(extension.context);

    const page = await extension.context.newPage();
    await page.goto(MOXFIELD_PLAYTEST_URL);
    await page.locator('.moxmox-set-username-btn').click();

    await expect(page.locator('.moxmox-popup')).toContainText('Set Your Username');
    await page.locator('.moxmox-popup-copy-btn', { hasText: 'Continue' }).click();
    await expect(page.locator('.moxmox-popup')).toContainText('Please enter a username.');

    await page.locator('input[placeholder="Your name"]').fill('Nate');
    await page.locator('.moxmox-popup-copy-btn', { hasText: 'Continue' }).click();

    await expect(page.locator('.moxmox-popup')).toHaveCount(0);
    await expect(page.locator('.moxmox-player-name')).toHaveText('Nate');
    guard.assertNoEscapes();
  } finally {
    await extension.close();
  }
});

test('mocks background service-worker update checks through the real runtime handler', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    await routeGithubLatest(extension.context, {
      tag_name: 'v9.9.9',
      name: 'MoxMox 9.9.9',
      html_url: 'https://github.com/natefinch/moxmox/releases/tag/v9.9.9',
    });

    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extension.extensionId}/popup.html`);

    const response = await page.evaluate(() =>
      chrome.runtime.sendMessage({ type: 'moxmox:check-update-now' }),
    );

    expect(response.ok).toBe(true);
    expect(response.state.latestVersion).toBe('9.9.9');
    expect(response.state.updateAvailable).toBe(true);
    expect(response.state.latestUrl).toBe('https://github.com/natefinch/moxmox/releases/tag/v9.9.9');
    guard.assertNoEscapes();
  } finally {
    await extension.close();
  }
});

test('network guard reports unmocked page and service-worker requests', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    const page = await extension.context.newPage();

    await page.evaluate(async () => {
      try {
        await fetch('https://unexpected.example.test/page');
      } catch {}
      try {
        await chrome.runtime.sendMessage({ type: 'moxmox:check-update-now' });
      } catch {}
    });

    expect(guard.violations.map(violation => violation.url).sort()).toEqual([
      GITHUB_LATEST_URL,
      'https://unexpected.example.test/page',
    ].sort());
    expect(() => guard.assertNoEscapes()).toThrow(/Unexpected external network request/);
  } finally {
    await extension.close();
  }
});

async function routeGithubLatest(context, body = {}) {
  await context.route(GITHUB_LATEST_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        tag_name: 'v1.2.0',
        name: 'MoxMox 1.2.0',
        html_url: 'https://github.com/natefinch/moxmox/releases/tag/v1.2.0',
        ...body,
      }),
    });
  });
}

async function routeMoxfieldPlaytest(context) {
  await context.route(MOXFIELD_PLAYTEST_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: moxfieldPlaytestFixture(),
    });
  });
  await context.route('https://moxfield.com/favicon.ico', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });
}

async function sendMainWorldCommand(page, action, params = {}) {
  return page.evaluate(({ action, params }) => new Promise((resolve, reject) => {
    const id = `e2e-${action}-${Math.random().toString(36).slice(2)}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error(`Timed out waiting for ${action} result`));
    }, 5_000);

    function onMessage(event) {
      const message = event.data;
      if (
        message?.moxmox === 'moxmox' &&
        message?.from === 'main' &&
        message?.type === 'result' &&
        message?.id === id
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', onMessage);
        resolve(message.data);
      }
    }

    window.addEventListener('message', onMessage);
    window.postMessage({
      moxmox: 'moxmox',
      from: 'isolated',
      type: 'cmd',
      id,
      action,
      params,
    }, '*');
  }), { action, params });
}

function moxfieldPlaytestFixture() {
  return `<!doctype html>
    <html>
      <head>
        <title>MoxMox Playwright Fixture</title>
        <style>
          nav ul { display: flex; gap: 8px; list-style: none; }
        </style>
      </head>
      <body>
        <main>
          <nav aria-label="Playtest controls">
            <ul>
              <li>100%</li>
              <li>Untap</li>
            </ul>
          </nav>
          <section id="battlefield"></section>
        </main>
        <script>
          window.__moxmoxMessages = [];
          window.addEventListener('message', event => {
            if (event.data?.moxmox === 'moxmox') {
              window.__moxmoxMessages.push(event.data);
            }
          });

          const zones = {
            hand: [{ id: 'hand-card', zoneId: 'hand-card', name: 'Island', set: 'lea', cn: '287' }],
            library: [{ id: 'library-card', zoneId: 'library-card', name: 'Mountain', set: 'lea', cn: '292' }],
            battlefield: [],
            graveyard: [],
            exile: [],
          };

          const playtestInstance = {
            state: { zones, life: 20, turn: 1, selectedCards: [] },
            setState(update, callback) {
              const next = typeof update === 'function' ? update(this.state) : update;
              this.state = { ...this.state, ...next };
              if (callback) queueMicrotask(callback);
            },
            handleSaveData() {},
            handleDraw() {},
            handleShuffle() {},
            componentDidUpdate() {},
          };

          const toolbarItem = document.querySelector('nav li');
          toolbarItem.__reactFiber$e2e = {
            stateNode: null,
            return: {
              stateNode: playtestInstance,
              return: null,
            },
          };
        </script>
      </body>
    </html>`;
}
