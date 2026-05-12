// MoxMox popup — displays connection state and message log from the
// content script running on the active Moxfield playtest tab.
//
// Gets initial state via chrome.tabs.sendMessage, then listens for
// live pushes via chrome.runtime.onMessage so the UI updates in
// real time without reopening the popup.

document.addEventListener('DOMContentLoaded', async () => {
  const contentEl = document.getElementById('content');

  // Always show username section at the top.
  await renderUsernameSection(contentEl);

  // Query the active tab's content script for initial state.
  const state = await queryContentScript();

  if (!state || !state.isGoldfish) {
    const msg = document.createElement('div');
    msg.className = 'not-playtest';
    msg.append('Navigate to a Moxfield playtest page', document.createElement('br'), 'to use MoxMox.');
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

async function queryContentScript() {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) return null;

    return await chrome.tabs.sendMessage(tab.id, {
      type: 'moxmox:get-state',
    });
  } catch {
    return null;
  }
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

  // ── Message log ───────────────────────────────────────────────────
  const section = document.createElement('div');
  section.className = 'section';

  const label = document.createElement('span');
  label.className = 'section-label';
  label.textContent = 'Message Log';
  section.appendChild(label);

  logEl = document.createElement('div');
  logEl.id = 'log';
  appendLogEntries(state.log || [], 0);
  section.appendChild(logEl);
  container.appendChild(section);

  logEl.scrollTop = logEl.scrollHeight;
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
    createStatusRow('Opponent', statusText(state.remoteStatus), {
      dotClassName: dotClass(state.remoteStatus),
    }),
    createStatusRow('Role', roleText),
    createStatusRow('Game', gameTypeText),
  ];

  if (state.maxPlayers) {
    rows.push(createStatusRow('Max Players', state.maxPlayers));
  }
  if (state.roomId) {
    rows.push(createStatusRow('Room', state.roomId, { valueClassName: 'room-id' }));
  }
  for (const player of state.players || []) {
    rows.push(createStatusRow(player.username || 'Player', playerStatusText(player), {
      dotClassName: player.connected === false ? '' : 'green',
    }));
  }

  panelEl.replaceChildren(...rows);
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
