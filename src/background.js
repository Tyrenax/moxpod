// MoxPod background service worker.

const UPDATE_ALARM = 'moxmox:update-check';
const UPDATE_STATE_KEY = 'moxmox_update_state';
const UPDATE_CHECK_MINUTES = 6 * 60;
const LATEST_RELEASE_URL = 'https://api.github.com/repos/Tyrenax/moxpod/releases/latest';

chrome.runtime.onInstalled.addListener(() => {
  scheduleUpdateChecks();
  checkForUpdate();
});

chrome.runtime.onStartup.addListener(() => {
  scheduleUpdateChecks();
  checkForUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    checkForUpdate();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'moxmox:check-update-now') return false;
  checkForUpdate()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

scheduleUpdateChecks();
restoreBadgeFromStorage();

function scheduleUpdateChecks() {
  chrome.alarms.create(UPDATE_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: UPDATE_CHECK_MINUTES,
  });
}

async function checkForUpdate() {
  const currentVersion = normalizeVersion(chrome.runtime.getManifest().version);
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { Accept: 'application/vnd.github+json' },
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`GitHub release check failed (${response.status})`);
    }

    const release = await response.json();
    const latestVersion = normalizeVersion(release.tag_name || release.name || '');
    const previous = await chrome.storage.local.get(UPDATE_STATE_KEY);
    const dismissedVersion = previous[UPDATE_STATE_KEY]?.dismissedVersion || null;
    const newerVersionAvailable = isVersionNewer(latestVersion, currentVersion);
    const updateAvailable = newerVersionAvailable && dismissedVersion !== latestVersion;
    const state = {
      checkedAt,
      currentVersion,
      latestVersion,
      latestUrl: release.html_url || 'https://github.com/Tyrenax/moxpod/releases/latest',
      updateAvailable,
      dismissedVersion,
    };

    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
    await applyUpdateBadge(state);
    return { ok: true, state };
  } catch (error) {
    const state = {
      checkedAt,
      currentVersion,
      updateAvailable: false,
      error: error.message,
    };
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: state });
    await applyUpdateBadge(state);
    return { ok: false, state };
  }
}

async function restoreBadgeFromStorage() {
  const result = await chrome.storage.local.get(UPDATE_STATE_KEY);
  await applyUpdateBadge(result[UPDATE_STATE_KEY]);
}

async function applyUpdateBadge(state) {
  const action = chrome.action || chrome.browserAction;
  if (!action) return;
  if (state?.updateAvailable) {
    await action.setBadgeText({ text: 'UP' });
    await action.setBadgeBackgroundColor({ color: '#f59e0b' });
    await action.setTitle({ title: `MoxPod : mise à jour disponible — ${state.latestVersion}` });
  } else {
    await action.setBadgeText({ text: '' });
    await action.setTitle({ title: 'MoxPod' });
  }
}

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '');
}

function isVersionNewer(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;

  for (let i = 0; i < next.length; i++) {
    if (next[i] > installed[i]) return true;
    if (next[i] < installed[i]) return false;
  }
  return false;
}

function parseVersion(value) {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}
