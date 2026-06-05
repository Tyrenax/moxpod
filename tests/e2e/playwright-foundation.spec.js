import { expect, test } from '@playwright/test';

import { installNetworkGuard, launchExtensionContext } from './extension-fixture.js';

const MOXFIELD_PLAYTEST_URL = 'https://moxfield.com/decks/e2e/goldfish';
const ARCHIDEKT_PLAYTEST_URL = 'https://archidekt.com/playtester-v2/21256567';
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

test('injects the widget after Archidekt playtester life counters', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    await routeGithubLatest(extension.context);
    await routeArchidektPlaytester(extension.context);

    const page = await extension.context.newPage();
    await page.goto(ARCHIDEKT_PLAYTEST_URL);

    const lifeCounters = page.locator(
      'div[class*="archidektDropdown_trigger"][class*="lifePlayerCounters_fullHeight"]',
    );
    await expect(page.locator('.moxmox-widget')).toContainText('MoxMox — Play Together');
    await expect(page.locator('.moxmox-set-username-btn')).toHaveText('Set Username');

    await expect.poll(() => lifeCounters.evaluate(element =>
      element.nextElementSibling?.classList.contains('moxmox-widget') ?? false,
    )).toBe(true);

    await page.locator('.moxmox-menu-btn').click();
    await expect(page.locator('.moxmox-menu')).toBeVisible();
    const menuPlacement = await page.evaluate(() => {
      const menu = document.querySelector('.moxmox-menu');
      const button = document.querySelector('.moxmox-menu-btn');
      const menuRect = menu.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        menuBottom: menuRect.bottom,
        buttonTop: buttonRect.top,
      };
    });
    expect(menuPlacement.menuBottom).toBeLessThanOrEqual(menuPlacement.buttonTop);
    guard.assertNoEscapes();
  } finally {
    await extension.close();
  }
});

test('detects an Archidekt shared invite added after content script initialization', async () => {
  const extension = await launchExtensionContext();
  try {
    const guard = await installNetworkGuard(extension.context);
    await routeGithubLatest(extension.context);
    await routeArchidektPlaytester(extension.context);

    const page = await extension.context.newPage();
    await page.goto(ARCHIDEKT_PLAYTEST_URL);
    await expect(page.locator('.moxmox-widget')).toContainText('MoxMox — Play Together');
    await expect(page.locator('.moxmox-popup')).toHaveCount(0);

    await page.evaluate(() => {
      history.pushState(null, '', '/playtester-v2/21256567?moxmoxroom=SharedRoom123456');
    });

    await expect(page.locator('.moxmox-popup')).toContainText('Set Your Username');
    await expect.poll(() => page.evaluate(() => location.href)).not.toContain('moxmoxroom=');
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

async function routeArchidektPlaytester(context) {
  await context.route(ARCHIDEKT_PLAYTEST_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: archidektPlaytesterFixture(),
    });
  });
  await context.route('https://archidekt.com/favicon.ico', async (route) => {
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

function archidektPlaytesterFixture() {
  return `<!doctype html>
    <html>
      <head>
        <title>MoxMox Archidekt Playwright Fixture</title>
        <style>
          body { min-height: 720px; margin: 0; }
          .mobileToolbar_bar__Sji09 {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            display: flex;
            align-items: stretch;
          }
        </style>
      </head>
      <body>
        <main>
          <div class="mobileToolbar_bar__Sji09">
            <div class="archidektDropdown_trigger__Wdtom toolbar_fullHeight__ExnOW" tabindex="0">
              <button>Game menu</button>
            </div>
            <div class="archidektDropdown_trigger__Wdtom lifePlayerCounters_fullHeight__CHSee" tabindex="0">
              <div tabindex="-1">
                <div class="lifePlayerCounters_trigger__kiKjl lifePlayerCounters_highlightOnHover__4bqV5">
                  <button>Turn: 0</button>
                  <button>Life: 40</button>
                </div>
              </div>
            </div>
            <button>Other toolbar action</button>
          </div>
        </main>
      </body>
    </html>`;
}
