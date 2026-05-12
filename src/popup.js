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
    msg.innerHTML = 'Navigate to a Moxfield playtest page<br>to use MoxMox.';
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
  const players = state.players || [];
  const playerRows = players.map(player => `
    <div class="status-row">
      <span class="status-label">${escapeHtml(player.username || 'Player')}</span>
      <span class="dot ${player.connected === false ? '' : 'green'}"></span>
      <span class="status-value">${player.life != null ? `Life ${player.life}` : statusText(player.connected === false ? 'disconnected' : 'connected')}</span>
    </div>
  `).join('');

  panelEl.innerHTML = `
    <div class="status-row">
      <span class="status-label">You</span>
      <span class="dot ${dotClass(state.localStatus)}"></span>
      <span class="status-value">${statusText(state.localStatus)}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Opponent</span>
      <span class="dot ${dotClass(state.remoteStatus)}"></span>
      <span class="status-value">${statusText(state.remoteStatus)}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Role</span>
      <span class="status-value">${roleText}</span>
    </div>
    <div class="status-row">
      <span class="status-label">Game</span>
      <span class="status-value">${gameTypeText}</span>
    </div>
    ${
      state.maxPlayers
        ? `<div class="status-row">
             <span class="status-label">Max Players</span>
             <span class="status-value">${state.maxPlayers}</span>
           </div>`
        : ''
    }
    ${
      state.roomId
        ? `<div class="status-row">
             <span class="status-label">Room</span>
             <span class="room-id">${state.roomId}</span>
           </div>`
        : ''
    }
    ${playerRows}
  `;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function appendLogEntries(entries, fromIndex) {
  if (!logEl) return;

  // Clear the "No messages yet" placeholder on first real entry.
  if (fromIndex === 0 && entries.length > 0) {
    logEl.innerHTML = '';
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
