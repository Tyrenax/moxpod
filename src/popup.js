// MoxMox popup — displays connection state and message log from the
// content script running on the active Moxfield playtest tab.
//
// Gets initial state via chrome.tabs.sendMessage, then listens for
// live pushes via chrome.runtime.onMessage so the UI updates in
// real time without reopening the popup.

const UPDATE_STATE_KEY = 'moxmox_update_state';

document.addEventListener('DOMContentLoaded', async () => {
  const contentEl = document.getElementById('content');

  // Always show username section at the top.
  await renderUsernameSection(contentEl);
  await renderUpdateBanner(contentEl);
  await renderSettingsSections(contentEl);

  // Query the active tab's content script for initial state.
  const state = await queryContentScript();

  if (!state || !state.isGoldfish) {
    const msg = document.createElement('div');
    msg.className = 'not-playtest';
    // Distinguish "wrong page" from "orphaned tab": after a reload of the
    // extension in chrome://extensions, the old content script cannot answer
    // and the fix is to refresh the tab, not to navigate somewhere.
    if (isPlaytestUrl(activeTab?.url)) {
      msg.append(
        'Cet onglet a perdu le contact avec l’extension',
        document.createElement('br'),
        '(extension rechargée). Fais F5 sur l’onglet Moxfield.',
      );
    } else {
      msg.append('Navigate to a Moxfield playtest page', document.createElement('br'), 'to use MoxMox.');
    }
    contentEl.appendChild(msg);
    return;
  }

  renderState(contentEl, state);

  // Listen for live updates pushed from the content script.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'moxmox:state-update') {
      updateState(msg);
    }
  });
});

/** The active tab, kept so the room card can build the invite URL and the
 *  panel toggle can address the right content script. */
let activeTab = null;

async function queryContentScript() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return null;
    activeTab = tab;

    return await chrome.tabs.sendMessage(tab.id, {
      type: 'moxmox:get-state',
    });
  } catch {
    return null;
  }
}

function isPlaytestUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.hostname === 'moxfield.com' && /\/decks\/[^/]+\/goldfish$/.test(u.pathname)) ||
      (u.hostname === 'archidekt.com' && /\/playtester-v2\/\d+/.test(u.pathname));
  } catch {
    return false;
  }
}

async function renderUpdateBanner(container) {
  const result = await chrome.storage.local.get(UPDATE_STATE_KEY);
  const state = result[UPDATE_STATE_KEY];
  if (!state?.updateAvailable) return;

  const banner = document.createElement('div');
  banner.className = 'update-banner';

  const title = document.createElement('div');
  title.className = 'update-banner-title';
  title.textContent = `MoxMox ${state.latestVersion} is available`;

  const message = document.createElement('div');
  message.textContent = isFirefox()
    ? 'Firefox can update this signed add-on automatically. Open the release page if you want to install it now.'
    : 'Chrome load-unpacked installs cannot auto-update. Download the new Chrome zip, replace your local folder, then click Reload in chrome://extensions.';

  const actions = document.createElement('div');
  actions.className = 'update-banner-actions';

  const releaseBtn = document.createElement('button');
  releaseBtn.textContent = 'Open release';
  releaseBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: state.latestUrl || 'https://github.com/natefinch/moxmox/releases/latest' });
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', async () => {
    await chrome.storage.local.set({
      [UPDATE_STATE_KEY]: {
        ...state,
        updateAvailable: false,
        dismissedVersion: state.latestVersion,
      },
    });
    chrome.runtime.sendMessage({ type: 'moxmox:check-update-now' }).catch(() => {});
    banner.remove();
  });

  actions.append(releaseBtn, dismissBtn);
  banner.append(title, message, actions);
  container.appendChild(banner);
}

function isFirefox() {
  return !!chrome.runtime.getManifest().browser_specific_settings?.gecko;
}

// ── Rendering ─────────────────────────────────────────────────────

// We keep references to DOM elements so we can update them in-place
// without rebuilding the whole UI.
let panelEl = null;
let logEl = null;
let lastLogLength = 0;

function renderState(container, state) {
  // ── Status panel ──────────────────────────────────────────────────
  panelEl = document.createElement('div');
  panelEl.className = 'status-panel';
  updatePanel(state);
  container.appendChild(panelEl);

  // ── Message log (collapsible) ───────────────────────────────────
  const section = document.createElement('div');
  section.className = 'section';

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'log-toggle';
  toggleBtn.textContent = '▸ Message Log';
  section.appendChild(toggleBtn);

  logEl = document.createElement('div');
  logEl.id = 'log';
  logEl.hidden = true;
  appendLogEntries(state.log || [], 0);
  section.appendChild(logEl);
  container.appendChild(section);

  toggleBtn.addEventListener('click', () => {
    const expanded = !logEl.hidden;
    logEl.hidden = expanded;
    toggleBtn.textContent = expanded ? '▸ Message Log' : '▾ Message Log';
    if (!expanded) logEl.scrollTop = logEl.scrollHeight;
  });
}

/** Called on each live update from the content script. */
function updateState(state) {
  updatePanel(state);

  // Append only new log entries (avoid rebuilding the whole list).
  const entries = state.log || [];
  if (entries.length > lastLogLength) {
    appendLogEntries(entries, lastLogLength);
    logEl.scrollTop = logEl.scrollHeight;
  }
}

function updatePanel(state) {
  if (!panelEl) return;

  const roleText = state.role
    ? state.role.charAt(0).toUpperCase() + state.role.slice(1)
    : 'Not connected';
  const gameTypeText = state.gameType === 'traditional'
    ? 'Traditional'
    : state.gameType === 'shared'
      ? 'Shared Deck'
      : 'Not selected';
  const localExtras = [
    state.localHandCount != null ? `Hand ${state.localHandCount}` : '',
  ].filter(Boolean).join(' · ');

  const rows = [
    createStatusRow('You', localExtras || statusText(state.localStatus), {
      dotClassName: dotClass(state.localStatus),
    }),
    createStatusRow('Role', roleText),
    createStatusRow('Game', gameTypeText),
  ];

  const seatsText = state.roomId
    ? `${(state.players || []).filter(p => p.connected !== false).length}/${state.maxPlayers || 2}`
    : '–';
  rows.push(createStatusRow('Seats', seatsText));
  for (const player of state.players || []) {
    rows.push(createStatusRow(player.username || 'Player', playerStatusText(player), {
      dotClassName: player.connected === false ? '' : 'green',
    }));
  }

  // The room card first: the code is what you need mid-game, and the popup is
  // reachable even while the spectator panel covers Moxfield's own toolbar.
  const blocks = state.roomId ? [buildRoomCard(state)] : [];
  panelEl.replaceChildren(...blocks, ...rows);
}

function buildRoomCard(state) {
  const card = document.createElement('div');
  card.className = 'room-card';

  const label = document.createElement('div');
  label.className = 'room-card-label';
  label.textContent = state.gameType === 'traditional' ? 'Code de la partie' : 'Room';
  card.appendChild(label);

  const code = document.createElement('button');
  code.className = 'room-code-big';
  code.textContent = state.roomId;
  code.title = 'Cliquer pour copier le code';
  code.addEventListener('click', () => copyWithFeedback(code, state.roomId, state.roomId));
  card.appendChild(code);

  const actions = document.createElement('div');
  actions.className = 'room-card-actions';

  const linkBtn = document.createElement('button');
  linkBtn.textContent = 'Copier le lien d’invitation';
  linkBtn.addEventListener('click', () => {
    const link = buildInviteUrl(state.roomId);
    if (link) copyWithFeedback(linkBtn, link, 'Copier le lien d’invitation');
  });
  actions.appendChild(linkBtn);

  if (state.gameType === 'traditional') {
    const panelBtn = document.createElement('button');
    panelBtn.textContent = state.panelVisible ? 'Masquer les boards adverses' : 'Afficher les boards adverses';
    panelBtn.addEventListener('click', async () => {
      try {
        const res = await chrome.tabs.sendMessage(activeTab.id, { type: 'moxpod:toggle-panel' });
        panelBtn.textContent = res?.visible ? 'Masquer les boards adverses' : 'Afficher les boards adverses';
      } catch { /* orphaned tab */ }
    });
    actions.appendChild(panelBtn);
  }

  card.appendChild(actions);
  return card;
}

function buildInviteUrl(roomId) {
  if (!activeTab?.url) return null;
  try {
    const url = new URL(activeTab.url);
    url.searchParams.set('moxmoxroom', roomId);
    return url.toString();
  } catch {
    return null;
  }
}

function copyWithFeedback(el, text, restoreText) {
  navigator.clipboard.writeText(text).then(() => {
    el.classList.add('copied');
    el.textContent = '✓ Copié';
    setTimeout(() => {
      el.classList.remove('copied');
      el.textContent = restoreText;
    }, 1200);
  }, () => {});
}

function createStatusRow(labelText, valueText, { dotClassName = null, valueClassName = 'status-value' } = {}) {
  const row = document.createElement('div');
  row.className = 'status-row';

  const label = document.createElement('span');
  label.className = 'status-label';
  label.textContent = labelText;
  row.appendChild(label);

  if (dotClassName !== null) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    if (dotClassName) dot.classList.add(dotClassName);
    row.appendChild(dot);
  }

  const value = document.createElement('span');
  value.className = valueClassName;
  value.textContent = String(valueText);
  row.appendChild(value);

  return row;
}

function playerStatusText(player) {
  const parts = [];
  if (player.life != null) parts.push(`Life ${player.life}`);
  if (player.handCount != null) parts.push(`Hand ${player.handCount}`);
  return parts.join(' · ') || statusText(player.connected === false ? 'disconnected' : 'connected');
}

function appendLogEntries(entries, fromIndex) {
  if (!logEl) return;

  // Clear the "No messages yet" placeholder on first real entry.
  if (fromIndex === 0 && entries.length > 0) {
    logEl.replaceChildren();
  }

  for (let i = fromIndex; i < entries.length; i++) {
    const entry = entries[i];
    const line = document.createElement('div');
    line.className = entry.direction === 'in' ? 'log-in' : 'log-out';
    const arrow = entry.direction === 'in' ? '◂' : '▸';
    line.textContent = `[${entry.time}] ${arrow} ${entry.text}`;
    logEl.appendChild(line);
  }

  lastLogLength = entries.length;
}

function dotClass(status) {
  if (status === 'connected') return 'green';
  if (status === 'connecting') return 'orange';
  return '';
}

function statusText(status) {
  if (status === 'connected') return 'Connected';
  if (status === 'connecting') return 'Connecting…';
  return 'Disconnected';
}

// ── Username ────────────────────────────────────────────────────────

async function renderUsernameSection(container) {
  const section = document.createElement('div');
  section.className = 'username-section';

  const label = document.createElement('span');
  label.className = 'section-label';
  label.textContent = 'Username';
  section.appendChild(label);

  const row = document.createElement('div');
  row.className = 'username-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Enter your name';
  input.maxLength = 30;

  const saveBtn = document.createElement('button');
  saveBtn.textContent = 'Save';

  row.appendChild(input);
  row.appendChild(saveBtn);
  section.appendChild(row);

  const feedback = document.createElement('div');
  feedback.className = 'username-saved';
  section.appendChild(feedback);

  container.appendChild(section);

  // Load saved username.
  const stored = await chrome.storage.local.get('moxmox_username');
  if (stored.moxmox_username) {
    input.value = stored.moxmox_username;
  }

  // Save on click or Enter.
  async function save() {
    const name = input.value.trim();
    if (!name) {
      feedback.textContent = '⚠️ Enter a username';
      feedback.style.color = '#e53935';
      return;
    }
    await chrome.storage.local.set({ moxmox_username: name });
    feedback.textContent = '✓ Saved';
    feedback.style.color = '#4caf50';
    setTimeout(() => { feedback.textContent = ''; }, 2000);
  }

  saveBtn.addEventListener('click', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
}

// ── Settings ──────────────────────────────────────────────────────

async function renderSettingsSections(container) {
  const stored = await chrome.storage.local.get([
    'moxmox_show_life_shared',
    'moxmox_show_life_traditional',
    'moxmox_shared_mirror_battlefield',
    'moxmox_shared_sync_gy_exile',
  ]);

  container.appendChild(
    createSettingsSection('Shared Library Settings', [
      {
        key: 'moxmox_shared_mirror_battlefield',
        label: 'Share Mirrored Battlefield',
        checked: stored.moxmox_shared_mirror_battlefield !== false,
      },
      {
        key: 'moxmox_shared_sync_gy_exile',
        label: 'Share Graveyard and Exile',
        checked: stored.moxmox_shared_sync_gy_exile !== false,
      },
      {
        key: 'moxmox_show_life_shared',
        label: 'Show Life Totals',
        checked: stored.moxmox_show_life_shared !== false,
      },
    ]),
  );

  container.appendChild(
    createSettingsSection('Traditional Game Settings', [
      {
        key: 'moxmox_show_life_traditional',
        label: 'Show Life Totals',
        checked: stored.moxmox_show_life_traditional !== false,
      },
    ]),
  );
}

function createSettingsSection(title, items) {
  const section = document.createElement('div');
  section.className = 'settings-section';

  const heading = document.createElement('div');
  heading.className = 'settings-heading';
  heading.textContent = title;
  section.appendChild(heading);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'settings-toggle-row';
    if (item.checked) row.classList.add('on');

    const track = document.createElement('button');
    track.type = 'button';
    track.className = 'settings-toggle-track';
    track.setAttribute('role', 'switch');
    track.setAttribute('aria-checked', String(item.checked));

    const thumb = document.createElement('span');
    thumb.className = 'settings-toggle-thumb';
    track.appendChild(thumb);

    const text = document.createElement('span');
    text.className = 'settings-toggle-label';
    text.textContent = item.label;

    row.appendChild(track);
    row.appendChild(text);

    const toggle = () => {
      const on = !row.classList.contains('on');
      row.classList.toggle('on', on);
      track.setAttribute('aria-checked', String(on));
      chrome.storage.local.set({ [item.key]: on });
    };
    track.addEventListener('click', toggle);
    text.addEventListener('click', toggle);
    text.style.cursor = 'pointer';

    section.appendChild(row);
  }

  return section;
}
