// MoxMox content script — runs in the ISOLATED world.
//
// Handles UI injection, WebSocket connection, game start flow, and
// ongoing zone sync for the "Play Together" feature.

import {
  generateRoomId,
  buildShareUrl,
  extractRoomId,
  stripRoomParam,
  isGoldfishPage,
} from './shared/room.js';

const WS_URL = 'wss://moxmox-relay.nate-finch.workers.dev';
const SESSION_KEY = 'moxmox_room';
const SESSION_ROLE_KEY = 'moxmox_role';
const SESSION_PLAYER_KEY = 'moxmox_player_key';
const MSG_TAG = 'moxmox';
const SHARED_ZONES = new Set(['library', 'graveyard', 'exile']);

// ── State ───────────────────────────────────────────────────────────

let ws = null;
let currentRoomId = null;
let localDot = null;
let remoteDot = null;
let popupBackdrop = null;
let role = null;         // 'host' or 'guest'
let localStatus = 'disconnected';
let remoteStatus = 'disconnected';
let gameStarted = false;   // true only after Start button is clicked (sync active)
let gameSetupDone = false; // true once the game-start handshake completes
let gameModal = null;
let playerKey = null;      // unique secret for this tab's player slot
const messageLog = [];

/** Generate a unique playerKey for this tab. */
function getOrCreatePlayerKey() {
  if (playerKey) return playerKey;
  // Check sessionStorage — survives refresh of the same tab.
  const stored = sessionStorage.getItem(SESSION_PLAYER_KEY);
  if (stored) {
    playerKey = stored;
    return playerKey;
  }
  // Generate fresh. Use crypto for uniqueness.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  playerKey = Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 32);
  sessionStorage.setItem(SESSION_PLAYER_KEY, playerKey);
  return playerKey;
}

// ── Entry point ─────────────────────────────────────────────────────

if (isGoldfishPage(window.location.href)) {
  init();
}

function init() {
  let roomToJoin = extractRoomId(window.location.href);
  let initialRole = null;
  if (roomToJoin) {
    initialRole = 'guest';
    // Fresh key for the new guest tab.
    playerKey = null;
    sessionStorage.removeItem(SESSION_PLAYER_KEY);
    history.replaceState(null, '', stripRoomParam(window.location.href));
  } else {
    roomToJoin = sessionStorage.getItem(SESSION_KEY) || null;
    initialRole = sessionStorage.getItem(SESSION_ROLE_KEY) || null;
  }

  chrome.runtime.onMessage.addListener(handlePopupMessage);

  // Listen for postMessage from MAIN world.
  window.addEventListener('message', handleMainMessage);

  waitForNavbar((navbar) => {
    injectButton(navbar);
    if (roomToJoin) {
      role = initialRole;
      connectToRoom(roomToJoin);
    }
  });
}

// ── postMessage bridge (ISOLATED → MAIN) ────────────────────────────

let cmdCounter = 0;
const pendingCmds = new Map();

function sendCmd(action, params = {}) {
  return new Promise((resolve, reject) => {
    const id = String(++cmdCounter);
    const timeout = setTimeout(() => {
      pendingCmds.delete(id);
      reject(new Error(`Command ${action} timed out`));
    }, 10000);
    pendingCmds.set(id, { resolve, timeout });
    window.postMessage({
      moxmox: MSG_TAG, from: 'isolated', type: 'cmd', id, action, params,
    }, '*');
  });
}

function handleMainMessage(e) {
  if (e.data?.moxmox !== MSG_TAG || e.data?.from !== 'main') return;

  switch (e.data.type) {
    case 'result': {
      const pending = pendingCmds.get(e.data.id);
      if (pending) {
        pendingCmds.delete(e.data.id);
        clearTimeout(pending.timeout);
        pending.resolve(e.data.data);
      }
      break;
    }
    case 'game-event':
      if (gameStarted) handleLocalGameEvent(e.data.event);
      break;
    case 'ready':
      console.log('[MoxMox] MAIN-world bridge ready');
      break;
  }
}

// ── Navbar detection ────────────────────────────────────────────────

function waitForNavbar(callback, retries = 30, delay = 500) {
  const zoomText = findZoomElement();
  if (zoomText) {
    callback(zoomText);
    return;
  }
  if (retries > 0) {
    setTimeout(() => waitForNavbar(callback, retries - 1, delay), delay);
  } else {
    console.warn('[MoxMox] Could not find playtest navbar');
  }
}

function findZoomElement() {
  const listItems = document.querySelectorAll('nav li');
  for (const li of listItems) {
    if (/^\d+%$/.test(li.textContent.trim())) return li;
  }
  return null;
}

// ── Button injection ────────────────────────────────────────────────

function injectButton(zoomElement) {
  const btn = document.createElement('button');
  btn.className = 'moxmox-play-btn';
  btn.type = 'button';

  const shareIcon = document.createElement('span');
  shareIcon.className = 'moxmox-icon-share';

  const label = document.createElement('span');
  label.textContent = 'Play Together';

  const statusContainer = document.createElement('span');
  statusContainer.className = 'moxmox-status-dots';

  localDot = document.createElement('span');
  localDot.className = 'moxmox-status-dot';
  localDot.title = 'You: Disconnected';

  remoteDot = document.createElement('span');
  remoteDot.className = 'moxmox-status-dot';
  remoteDot.title = 'Opponent: Disconnected';

  statusContainer.appendChild(localDot);
  statusContainer.appendChild(remoteDot);

  btn.appendChild(shareIcon);
  btn.appendChild(label);
  btn.appendChild(statusContainer);
  btn.addEventListener('click', handlePlayButtonClick);

  const li = document.createElement('li');
  li.appendChild(btn);
  const parentList = zoomElement.parentElement;
  if (parentList) parentList.insertBefore(li, zoomElement);
}

// ── Button click handler ────────────────────────────────────────────

function handlePlayButtonClick() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    showSharePopup();
    return;
  }
  role = 'host';
  // Generate a fresh player key for the new room.
  playerKey = null;
  sessionStorage.removeItem(SESSION_PLAYER_KEY);
  const roomId = generateRoomId();
  connectToRoom(roomId);
  showSharePopup();
}

// ── WebSocket connection ────────────────────────────────────────────

function connectToRoom(roomId) {
  currentRoomId = roomId;
  sessionStorage.setItem(SESSION_KEY, roomId);
  sessionStorage.setItem(SESSION_ROLE_KEY, role);
  setLocalStatus('connecting');
  setRemoteStatus('disconnected');
  addLog('out', `Connecting to room ${roomId}…`);

  const url = `${WS_URL}/room/${encodeURIComponent(roomId)}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setLocalStatus('connected');
    addLog('in', 'WebSocket connected');
    sendWs({ type: 'join', playerKey: getOrCreatePlayerKey() });
  });

  ws.addEventListener('message', (event) => {
    handleServerMessage(event.data);
  });

  ws.addEventListener('close', () => {
    setLocalStatus('disconnected');
    setRemoteStatus('disconnected');
    addLog('in', 'WebSocket disconnected');
    ws = null;
  });

  ws.addEventListener('error', () => {
    setLocalStatus('disconnected');
    addLog('in', '⚠️ WebSocket error');
  });
}

function sendWs(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
  addLog('out', `SEND: ${msg.type}`);
}

function handleServerMessage(data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }

  switch (msg.type) {
    case 'system': {
      if (msg.rejected) {
        addLog('in', `⛔ REJECTED: ${msg.text}`);
        setLocalStatus('disconnected');
        setRemoteStatus('disconnected');
        sessionStorage.removeItem(SESSION_KEY);
        sessionStorage.removeItem(SESSION_ROLE_KEY);
        sessionStorage.removeItem(SESSION_PLAYER_KEY);
        showRoomFullModal();
        break;
      }
      let peerCount = msg.peerCount;
      if (typeof peerCount !== 'number') {
        const m = msg.text?.match(/(\d+)\s+player\(s\)/);
        if (m) peerCount = parseInt(m[1], 10);
      }
      if (typeof peerCount === 'number') {
        setRemoteStatus(peerCount >= 2 ? 'connected' : 'disconnected');
      }
      addLog('in', `SYSTEM: ${msg.text}`);
      break;
    }
    case 'join':
      setRemoteStatus('connected');
      addLog('in', 'RECV: join');
      break;
    case 'game-init':
      addLog('in', `RECV: game-init (${msg.library?.length} cards)`);
      runGuestGameStart(msg.library);
      break;
    case 'game-ready':
      addLog('in', `RECV: game-ready (${msg.drawnCount} cards drawn)`);
      finishHostGameStart(msg.drawnCount);
      break;
    case 'game-start':
      addLog('in', 'RECV: game-start');
      enableStartButton();
      break;
    case 'zone-sync':
      addLog('in', `RECV: zone-sync ${msg.action} ${msg.zone || ''}`);
      handleRemoteSync(msg);
      break;
    default:
      addLog('in', `RECV: ${msg.type}`);
  }
}

// ── Status indicators ───────────────────────────────────────────────

function setLocalStatus(state) {
  localStatus = state;
  applyDotState(localDot, state, 'You');
}

function setRemoteStatus(state) {
  const wasConnected = remoteStatus === 'connected';
  remoteStatus = state;
  applyDotState(remoteDot, state, 'Opponent');

  // Trigger game start when both players are connected for the first time.
  if (!wasConnected && state === 'connected' && localStatus === 'connected' && !gameStarted && !gameSetupDone) {
    startGameFlow();
  }
}

function applyDotState(dot, state, label) {
  if (!dot) return;
  dot.classList.remove('connected', 'connecting');
  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      dot.title = `${label}: Connected`;
      break;
    case 'connecting':
      dot.classList.add('connecting');
      dot.title = `${label}: Connecting…`;
      break;
    default:
      dot.title = `${label}: Disconnected`;
  }
}

// ── Game start flow ─────────────────────────────────────────────────

function startGameFlow() {
  gameSetupDone = false;
  showGameModal();
  if (role === 'host') {
    runHostGameStart();
  }
  // Guest waits for game-init message.
}

async function runHostGameStart() {
  try {
    updateGameModalStatus('Resetting…');
    const resetResult = await sendCmd('reset-to-library');
    addLog('out', `DEBUG: reset-to-library → ${JSON.stringify(resetResult)}`);

    updateGameModalStatus('Shuffling…');
    const shuffleResult = await sendCmd('shuffle-library');
    addLog('out', `DEBUG: shuffle-library → ${JSON.stringify(shuffleResult)}`);

    updateGameModalStatus('Drawing 7 cards…');
    const drawResult = await sendCmd('draw', { count: 7 });
    addLog('out', `DEBUG: draw → ${JSON.stringify(drawResult)}`);

    updateGameModalStatus('Sending library to opponent…');
    const libResult = await sendCmd('get-library');
    addLog('out', `DEBUG: get-library → ${libResult?.cards?.length} cards, first: ${JSON.stringify(libResult?.cards?.[0])}`);
    const msg = { type: 'game-init', library: libResult.cards };
    addLog('out', `DEBUG: game-init message size: ${JSON.stringify(msg).length} bytes`);
    sendWs(msg);

    updateGameModalStatus('Waiting for opponent to draw…');
  } catch (err) {
    addLog('out', `DEBUG: host error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

async function finishHostGameStart(drawnCount) {
  try {
    addLog('in', `DEBUG: finishHostGameStart drawnCount=${drawnCount}`);
    updateGameModalStatus('Finalizing…');
    const removeResult = await sendCmd('remove-top-from-library', { count: drawnCount });
    addLog('out', `DEBUG: remove-top → ${JSON.stringify(removeResult)}`);
    sendWs({ type: 'game-start' });
    enableStartButton();
  } catch (err) {
    addLog('out', `DEBUG: finishHost error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

async function runGuestGameStart(libraryCards) {
  try {
    addLog('in', `DEBUG: game-init received ${libraryCards?.length} cards, first: ${JSON.stringify(libraryCards?.[0])}`);

    updateGameModalStatus('Resetting…');
    const resetResult = await sendCmd('reset-to-library');
    addLog('out', `DEBUG: reset-to-library → ${JSON.stringify(resetResult)}`);

    updateGameModalStatus('Syncing library…');
    const syncResult = await sendCmd('set-library-from-sync', { cards: libraryCards });
    addLog('out', `DEBUG: set-library-from-sync → ${JSON.stringify(syncResult)}`);

    updateGameModalStatus('Drawing 7 cards…');
    const drawResult = await sendCmd('draw', { count: 7 });
    addLog('out', `DEBUG: draw → ${JSON.stringify(drawResult)}`);

    sendWs({ type: 'game-ready', drawnCount: drawResult.count });
    updateGameModalStatus('Waiting for host…');
  } catch (err) {
    addLog('out', `DEBUG: guest error: ${err.message}`);
    updateGameModalStatus(`Error: ${err.message}`);
  }
}

// ── Game modal UI ───────────────────────────────────────────────────

function showGameModal() {
  if (gameModal) return;

  gameModal = document.createElement('div');
  gameModal.className = 'moxmox-popup-backdrop';
  // No backdrop click to close — this is modal during setup.

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Both Players Connected!';

  const status = document.createElement('p');
  status.id = 'moxmox-game-status';
  status.textContent = 'Starting Game…';

  const startBtn = document.createElement('button');
  startBtn.className = 'moxmox-popup-copy-btn';
  startBtn.id = 'moxmox-start-btn';
  startBtn.textContent = 'Start!';
  startBtn.disabled = true;
  startBtn.style.marginTop = '16px';
  startBtn.style.padding = '10px 32px';
  startBtn.style.fontSize = '15px';
  startBtn.addEventListener('click', () => {
    gameStarted = true; // Enable ongoing sync now that setup is complete.
    gameModal.remove();
    gameModal = null;
  });

  popup.appendChild(heading);
  popup.appendChild(status);
  popup.appendChild(startBtn);
  gameModal.appendChild(popup);
  document.body.appendChild(gameModal);
}

function updateGameModalStatus(text) {
  const el = document.getElementById('moxmox-game-status');
  if (el) el.textContent = text;
}

function enableStartButton() {
  gameSetupDone = true;
  updateGameModalStatus('Ready to play!');
  const btn = document.getElementById('moxmox-start-btn');
  if (btn) btn.disabled = false;
  sendCmd('inject-divider').catch(() => {});
}

function showRoomFullModal() {
  // Replace whatever modal is showing with a "Room is Full" message.
  if (gameModal) {
    gameModal.remove();
    gameModal = null;
  }

  gameModal = document.createElement('div');
  gameModal.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';
  popup.style.textAlign = 'center';

  const heading = document.createElement('h3');
  heading.textContent = 'Room is Full';

  const msg = document.createElement('p');
  msg.textContent = 'This game already has two players connected.';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-copy-btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.marginTop = '16px';
  closeBtn.style.padding = '10px 32px';
  closeBtn.style.fontSize = '15px';
  closeBtn.addEventListener('click', () => {
    gameModal.remove();
    gameModal = null;
  });

  popup.appendChild(heading);
  popup.appendChild(msg);
  popup.appendChild(closeBtn);
  gameModal.appendChild(popup);
  document.body.appendChild(gameModal);
}

// ── Ongoing sync: local events → remote ─────────────────────────────

async function handleLocalGameEvent(event) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const { type, card, fromZone, toZone } = event;

  if (type === 'card:zone-changed') {
    const fromShared = SHARED_ZONES.has(fromZone);
    const toShared = SHARED_ZONES.has(toZone);
    const fromBF = fromZone === 'battlefield';
    const toBF = toZone === 'battlefield';

    if (toBF) {
      // Anything → battlefield: send card position as percentage of usable bounds.
      const size = await sendCmd('get-battlefield-size');
      const maxLeft = size.usableWidth;
      const maxTop = Math.max(0, size.height - size.cardH);
      const pctX = maxLeft > 0 ? (card.left ?? 0) / maxLeft : 0.5;
      const pctY = maxTop > 0 ? (card.top ?? 0) / maxTop : 0.5;
      sendWs({
        type: 'zone-sync', action: 'add-battlefield',
        cardId: card.id, syncId: card.syncId,
        pctX, pctY,
        fromZone: fromShared ? fromZone : undefined,
      });
      // Also remove from the shared source zone on the other side.
      if (fromShared) {
        sendWs({ type: 'zone-sync', action: 'remove', zone: fromZone, syncId: card.syncId });
      }
    } else if (fromBF && toZone === 'hand') {
      // Battlefield → hand: just remove from opponent's battlefield.
      sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield', syncId: card.syncId });
    } else if (fromBF && toShared) {
      // Battlefield → shared zone: remove from opponent's BF, add to shared zone.
      sendWs({ type: 'zone-sync', action: 'remove', zone: 'battlefield', syncId: card.syncId });
      sendWs({ type: 'zone-sync', action: 'add', zone: toZone, cardId: card.id, syncId: card.syncId });
    } else if (!fromShared && toShared) {
      // Private (hand) → shared: opponent adds to their shared zone.
      sendWs({ type: 'zone-sync', action: 'add', zone: toZone,
        cardId: card.id, syncId: card.syncId });
    } else if (fromShared && !toShared) {
      // Shared → private (hand): opponent removes from shared zone.
      sendWs({ type: 'zone-sync', action: 'remove', zone: fromZone,
        syncId: card.syncId });
    } else if (fromShared && toShared) {
      // Shared → shared: opponent moves between zones.
      sendWs({ type: 'zone-sync', action: 'move', fromZone, toZone,
        syncId: card.syncId });
    }
  } else if (type === 'card:state-changed' && card) {
    // Battlefield state changes: sync all properties.
    const syncUpdates = {};
    const changes = event.changes || {};

    // Non-positional state.
    for (const prop of ['tapped', 'flipped', 'rotated', 'doesntUntap',
                         'counters', 'adjustedPower', 'adjustedToughness', 'adjustedLoyalty']) {
      if (changes[prop]) syncUpdates[prop] = changes[prop].to;
    }

    // Position — send each axis independently as a percentage.
    // Uses top-left coordinates normalized against usable bounds.
    if (changes.left || changes.top) {
      const size = await sendCmd('get-battlefield-size');
      const maxLeft = size.usableWidth;
      const maxTop = Math.max(0, size.height - size.cardH);

      if (changes.left) {
        syncUpdates.pctX = maxLeft > 0 ? (card.left ?? 0) / maxLeft : 0.5;
      }
      if (changes.top) {
        syncUpdates.pctY = maxTop > 0 ? (card.top ?? 0) / maxTop : 0.5;
      }
    }

    if (Object.keys(syncUpdates).length > 0) {
      sendWs({ type: 'zone-sync', action: 'update-state',
        syncId: card.syncId, updates: syncUpdates });
    }
  } else if (type === 'card:removed' && event.fromZone) {
    if (SHARED_ZONES.has(event.fromZone) || event.fromZone === 'battlefield') {
      sendWs({ type: 'zone-sync', action: 'remove', zone: event.fromZone,
        syncId: card.syncId });
    }
  } else if (type === 'zone:reordered' && SHARED_ZONES.has(event.zone)) {
    sendWs({ type: 'zone-sync', action: 'reorder', zone: event.zone,
      syncIds: event.syncIds });
  } else if (type === 'selection-changed') {
    sendWs({ type: 'zone-sync', action: 'highlight',
      syncIds: event.syncIds || [] });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ── Ongoing sync: remote → local ────────────────────────────────────

async function handleRemoteSync(msg) {
  try {
    switch (msg.action) {
      case 'add':
        await sendCmd('sync-add', { zone: msg.zone, cardId: msg.cardId, syncId: msg.syncId });
        break;
      case 'remove':
        await sendCmd('sync-remove', { zone: msg.zone, syncId: msg.syncId });
        break;
      case 'move':
        await sendCmd('sync-move', { fromZone: msg.fromZone, toZone: msg.toZone, syncId: msg.syncId });
        break;
      case 'add-battlefield': {
        // Mirror position using top-left model.
        const size = await sendCmd('get-battlefield-size');
        const maxLeft = size.usableWidth;
        const maxTop = Math.max(0, size.height - size.cardH);
        const localLeft = clamp(Math.round((1 - msg.pctX) * maxLeft), 0, maxLeft);
        const localTop = clamp(Math.round((1 - msg.pctY) * maxTop), 0, maxTop);
        await sendCmd('sync-add-battlefield', {
          cardId: msg.cardId, syncId: msg.syncId,
          top: localTop, left: localLeft, rotated: true,
        });
        // If the card came from a shared zone, remove it there too.
        if (msg.fromZone && SHARED_ZONES.has(msg.fromZone)) {
          await sendCmd('sync-remove', { zone: msg.fromZone, syncId: msg.syncId });
        }
        break;
      }
      case 'update-state': {
        const updates = { ...msg.updates };
        // Translate each axis independently — don't invent the missing axis.
        if ('pctX' in updates || 'pctY' in updates) {
          const size = await sendCmd('get-battlefield-size');
          const maxLeft = size.usableWidth;
          const maxTop = Math.max(0, size.height - size.cardH);

          if ('pctX' in updates) {
            updates.left = clamp(Math.round((1 - updates.pctX) * maxLeft), 0, maxLeft);
            delete updates.pctX;
          }
          if ('pctY' in updates) {
            updates.top = clamp(Math.round((1 - updates.pctY) * maxTop), 0, maxTop);
            delete updates.pctY;
          }
        }
        await sendCmd('sync-update-state', { syncId: msg.syncId, updates });
        break;
      }
      case 'highlight':
        await sendCmd('apply-remote-highlight', { syncIds: msg.syncIds || [] });
        break;
    }
  } catch (err) {
    console.error('[MoxMox] Sync error:', err);
  }
}

// ── Share popup ─────────────────────────────────────────────────────

function showSharePopup() {
  if (popupBackdrop) {
    popupBackdrop.remove();
    popupBackdrop = null;
  }

  const shareUrl = buildShareUrl(
    stripRoomParam(window.location.href),
    currentRoomId,
  );
  copyToClipboard(shareUrl);

  popupBackdrop = document.createElement('div');
  popupBackdrop.className = 'moxmox-popup-backdrop';

  const popup = document.createElement('div');
  popup.className = 'moxmox-popup';

  const heading = document.createElement('h3');
  heading.textContent = 'Play Together';

  const subtitle = document.createElement('p');
  subtitle.textContent = 'Send this link to your opponent. They\'ll need the MoxMox extension installed.';

  const urlRow = document.createElement('div');
  urlRow.className = 'moxmox-popup-url-row';

  const urlBox = document.createElement('div');
  urlBox.className = 'moxmox-popup-url';
  urlBox.textContent = shareUrl;

  const copyBtn = document.createElement('button');
  copyBtn.className = 'moxmox-popup-copy-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', () => {
    copyToClipboard(shareUrl);
    showCopiedFeedback();
  });

  urlRow.appendChild(urlBox);
  urlRow.appendChild(copyBtn);

  const copiedMsg = document.createElement('div');
  copiedMsg.className = 'moxmox-popup-copied';
  copiedMsg.id = 'moxmox-copied-msg';
  copiedMsg.textContent = '✓ Link copied to clipboard';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'moxmox-popup-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => {
    popupBackdrop.remove();
    popupBackdrop = null;
  });

  popup.appendChild(heading);
  popup.appendChild(subtitle);
  popup.appendChild(urlRow);
  popup.appendChild(copiedMsg);
  popup.appendChild(closeBtn);
  popupBackdrop.appendChild(popup);

  popupBackdrop.addEventListener('click', (e) => {
    if (e.target === popupBackdrop) {
      popupBackdrop.remove();
      popupBackdrop = null;
    }
  });

  document.body.appendChild(popupBackdrop);
}

function showCopiedFeedback() {
  const msg = document.getElementById('moxmox-copied-msg');
  if (msg) {
    msg.style.opacity = '0';
    requestAnimationFrame(() => {
      msg.style.transition = 'opacity 0.2s';
      msg.style.opacity = '1';
    });
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
}

// ── Message log ─────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 200;

function addLog(direction, text) {
  const entry = {
    time: new Date().toLocaleTimeString(),
    direction,
    text,
  };
  messageLog.push(entry);
  if (messageLog.length > MAX_LOG_ENTRIES) messageLog.shift();
  notifyPopup();
}

function notifyPopup() {
  chrome.runtime.sendMessage({
    type: 'moxmox:state-update',
    localStatus,
    remoteStatus,
    role,
    roomId: currentRoomId,
    log: messageLog,
    isGoldfish: true,
  }).catch(() => {});
}

// ── Popup message handler ───────────────────────────────────────────

function handlePopupMessage(message, _sender, sendResponse) {
  if (message?.type === 'moxmox:get-state') {
    sendResponse({
      localStatus,
      remoteStatus,
      role,
      roomId: currentRoomId,
      log: messageLog,
      isGoldfish: true,
    });
    return true;
  }
}
