// Build smoke tests for generated browser extension artifacts.
// Run with: npm run test:build

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// which join() then turns into "C:\C:\...".
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(ROOT, 'dist');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function distPath(browser, ...parts) {
  return join(DIST, browser, ...parts);
}

function assertFileExists(path, message = `${path} should exist`) {
  assert.ok(existsSync(path), message);
  assert.ok(statSync(path).isFile(), `${path} should be a file`);
}

function assertDirExists(path, message = `${path} should exist`) {
  assert.ok(existsSync(path), message);
  assert.ok(statSync(path).isDirectory(), `${path} should be a directory`);
}

function assertManifestReferencedFilesExist(browser, manifest) {
  for (const iconPath of Object.values(manifest.icons || {})) {
    assertFileExists(distPath(browser, iconPath), `${browser} icon ${iconPath} should exist`);
  }

  if (manifest.action?.default_popup) {
    assertFileExists(
      distPath(browser, manifest.action.default_popup),
      `${browser} popup should exist`,
    );
  }

  for (const script of manifest.background?.scripts || []) {
    assertFileExists(distPath(browser, script), `${browser} background script ${script} should exist`);
  }

  if (manifest.background?.service_worker) {
    assertFileExists(
      distPath(browser, manifest.background.service_worker),
      `${browser} service worker should exist`,
    );
  }

  for (const contentScript of manifest.content_scripts || []) {
    for (const js of contentScript.js || []) {
      assertFileExists(distPath(browser, js), `${browser} content script ${js} should exist`);
    }
    for (const css of contentScript.css || []) {
      assertFileExists(distPath(browser, css), `${browser} stylesheet ${css} should exist`);
    }
  }
}

function findContentScript(manifest, jsFile) {
  return manifest.content_scripts.find(script => script.js?.includes(jsFile));
}

describe('built extension artifacts', () => {
  for (const browser of ['chrome', 'firefox']) {
    it(`builds ${browser} manifest and referenced files`, () => {
      const manifestPath = distPath(browser, 'manifest.json');
      assertFileExists(manifestPath);

      const manifest = readJson(manifestPath);
      assert.equal(manifest.manifest_version, 3);
      assert.equal(manifest.name, 'MoxPod');
      assert.equal(typeof manifest.version, 'string');
      assertManifestReferencedFilesExist(browser, manifest);

      assertFileExists(distPath(browser, 'popup.js'));
      assertFileExists(distPath(browser, 'popup.html'));
      assertFileExists(distPath(browser, 'styles.css'));
      assertFileExists(distPath(browser, 'moxpod.css'));
      assertDirExists(distPath(browser, 'icons'));
    });
  }

  it('builds Chrome with an MV3 service worker background', () => {
    const manifest = readJson(distPath('chrome', 'manifest.json'));

    assert.deepEqual(manifest.background, { service_worker: 'background.js' });
    assertFileExists(distPath('chrome', 'background.js'));
  });

  it('builds Firefox with background scripts and Gecko ID', () => {
    const manifest = readJson(distPath('firefox', 'manifest.json'));

    assert.ok(manifest.background?.scripts?.includes('background.js'));
    assert.equal(manifest.browser_specific_settings?.gecko?.id, 'moxmox@natefinch.com');
    assertFileExists(distPath('firefox', 'background.js'));
  });

  it('injects the isolated content script and styles at document_idle', () => {
    for (const browser of ['chrome', 'firefox']) {
      const manifest = readJson(distPath(browser, 'manifest.json'));
      const contentScript = findContentScript(manifest, 'content.js');

      assert.ok(contentScript, `${browser} should include content.js`);
      assert.ok(contentScript.matches.includes('https://moxfield.com/*'));
      assert.ok(contentScript.matches.includes('https://archidekt.com/*'));
      assert.deepEqual(contentScript.css, ['styles.css', 'moxpod.css']);
      assert.equal(contentScript.run_at, 'document_idle');
    }
  });

  it('injects the MAIN-world playtest bridge at document_idle', () => {
    for (const browser of ['chrome', 'firefox']) {
      const manifest = readJson(distPath(browser, 'manifest.json'));
      const contentMain = findContentScript(manifest, 'content-main.js');

      assert.ok(contentMain, `${browser} should include content-main.js`);
      assert.ok(contentMain.matches.includes('https://moxfield.com/*'));
      assert.ok(contentMain.matches.includes('https://archidekt.com/*'));
      assert.equal(contentMain.run_at, 'document_idle');
      assert.equal(contentMain.world, 'MAIN');
    }
  });
});
