// MoxMox content-main script — runs in the page's MAIN world.
//
// Thin dispatcher that detects the current site, creates the appropriate
// adapter, and bridges postMessage commands to the adapter. All site-specific
// game state logic lives in the adapters (src/moxfield/adapter.js, etc.).

import { MoxfieldAdapter } from './moxfield/adapter.js';
import { ArchidektAdapter } from './archidekt/adapter.js';

const MSG_TAG = 'moxmox';
const URL_CHECK_MS = 500;

// Commands that mutate game state and need sync suppression (withSync).
const SYNC_COMMANDS = new Set([
  'reset-to-library', 'shuffle-library', 'draw',
  'set-library-from-sync', 'remove-top-from-library',
  'sync-remove', 'sync-add', 'sync-add-battlefield',
  'sync-move', 'sync-update-state',
  'gift-add-battlefield', 'gift-add-zone', 'gift-remove',
]);

let adapter = null;
let syncDepth = 0;
let controllerReady;
let resolveControllerReady;
let controllerReadyResolved = false;
let controllerInitInProgress = false;
let lastSeenUrl = window.location.href;
let giftState = { enabled: false, localPlayerId: null, opponents: [] };
let lastContextCard = null;
let lastContextPoint = null;
let giftMenuObserver = null;

resetControllerReady();

// ── Initialization ──────────────────────────────────────────────────

function createAdapterForSite() {
  const site = detectSite();
  if (site === 'moxfield') return new MoxfieldAdapter();
  if (site === 'archidekt') return new ArchidektAdapter();
  return null;
}

function initController(retries = 30, delay = 1000) {
  if (!isPlaytestPath()) {
    controllerInitInProgress = false;
    return;
  }
  if (controllerInitInProgress && retries === 30) return;
  controllerInitInProgress = true;

  adapter = createAdapterForSite();
  if (!adapter) {
    controllerInitInProgress = false;
    return;
  }

  adapter.init(retries, delay).then(() => {
    controllerInitInProgress = false;
    if (!adapter.isAvailable()) {
      adapter = null;
      return;
    }
    setupEventForwarding();
    controllerReadyResolved = true;
    resolveControllerReady();
    post({ type: 'ready' });
  });
}

// ── Event forwarding (adapter → ISOLATED world) ─────────────────────

function setupEventForwarding() {
  adapter.on('card:zone-changed', (ev) => {
    if (syncDepth > 0) return;
    post({ type: 'game-event', event: ev });
  });
  adapter.on('card:removed', (ev) => {
    if (syncDepth > 0) return;
    post({ type: 'game-event', event: ev });
  });
  adapter.on('card:state-changed', (ev) => {
    if (syncDepth > 0) {
      console.log('[MoxMox MAIN] state-changed suppressed (syncDepth=' + syncDepth + ')');
      return;
    }
    post({ type: 'game-event', event: ev });
  });
  adapter.on('zone:reordered', (ev) => {
    if (syncDepth > 0) return;
    post({ type: 'game-event', event: ev });
  });
  adapter.on('selection-changed', (ev) => {
    if (syncDepth > 0) return;
    post({ type: 'game-event', event: ev });
  });
  adapter.on('life:changed', (ev) => {
    if (syncDepth > 0) return;
    post({ type: 'game-event', event: ev });
  });
}

// ── postMessage bridge ──────────────────────────────────────────────

function post(msg) {
  window.postMessage({ ...msg, moxmox: MSG_TAG, from: 'main' }, '*');
}

window.addEventListener('message', (e) => {
  if (e.data?.moxmox !== MSG_TAG) return;
  if (e.data?.from === 'isolated' && e.data.type === 'cmd') {
    handleCommand(e.data.id, e.data.action, e.data.params || {});
  } else if (e.data?.from === 'isolated' && e.data.type === 'gift-state') {
    giftState = {
      enabled: !!e.data.enabled,
      localPlayerId: e.data.localPlayerId || null,
      localUsername: e.data.localUsername || 'Opponent',
      opponents: Array.isArray(e.data.opponents) ? e.data.opponents : [],
    };
    if (adapter) adapter.setGiftState(giftState);
  }
});

async function handleCommand(id, action, params) {
  let data;
  try {
    await controllerReady;
    console.log(`[MoxMox MAIN] cmd: ${action}`, params);
    if (SYNC_COMMANDS.has(action)) {
      data = await withSync(() => adapter.dispatch(action, params));
    } else {
      data = await adapter.dispatch(action, params);
    }
    console.log(`[MoxMox MAIN] result: ${action}`, data);
  } catch (err) {
    console.error(`[MoxMox MAIN] error: ${action}`, err);
    data = { error: err.message };
  }
  post({ type: 'result', id, data });
}

async function withSync(fn) {
  syncDepth++;
  try { return await fn(); }
  finally { syncDepth--; }
}

// ── Gift context menu ────────────────────────────────────────────────

function startGiftMenuIntegration() {
  document.addEventListener('contextmenu', (event) => {
    captureCardInteraction(event);
  }, true);
  document.addEventListener('pointerdown', (event) => {
    captureCardInteraction(event);
  }, true);
  document.addEventListener('click', (event) => {
    captureCardInteraction(event);
  }, true);

  giftMenuObserver = new MutationObserver(() => injectGiftMenuItems());
  if (document.body) {
    giftMenuObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      giftMenuObserver.observe(document.body, { childList: true, subtree: true });
    }, { once: true });
  }
}

function captureCardInteraction(event) {
  if (event.target instanceof Element && event.target.closest('.moxmox-gift-menu-item')) return;
  const card = findCardFromElement(event.target) ||
    findCardFromPoint(event.clientX, event.clientY);
  if (!card) return;

  lastContextPoint = { x: event.clientX, y: event.clientY };
  lastContextCard = card;
  for (const delay of [0, 50, 150, 300]) {
    setTimeout(injectGiftMenuItems, delay);
  }
}

function findCardFromElement(element) {
  if (!adapter?.isAvailable()) return null;
  let el = element instanceof Element ? element : element?.parentElement;
  while (el) {
    const card = findCardFromFiberElement(el);
    if (card) return card;
    el = el.parentElement;
  }
  return null;
}

function findCardFromPoint(x, y) {
  if (!adapter?.isAvailable()) return null;
  for (const element of document.elementsFromPoint(x, y)) {
    const card = findCardFromElement(element);
    if (card) return card;
  }
  return null;
}

function findCardFromFiberElement(element) {
  const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber'));
  if (!fiberKey) return null;

  let current = element[fiberKey];
  for (let depth = 0; depth < 50 && current; depth++) {
    const props = current.memoizedProps || current.pendingProps;
    const zoneId = props?.card?.zoneId || props?.id;
    if (zoneId) {
      const card = adapter.findCardByZoneId(zoneId);
      if (card) return card;
    }
    current = current.return;
  }
  return null;
}

function injectGiftMenuItems() {
  if (!lastContextCard && lastContextPoint) {
    lastContextCard = findCardFromPoint(lastContextPoint.x, lastContextPoint.y);
  }
  if (!giftState.enabled || giftState.opponents.length === 0 || !lastContextCard) return;
  const giftOpponents = getGiftMenuOpponents(lastContextCard);
  if (giftOpponents.length === 0) return;

  const moveItems = findMoveToMenuItems();
  for (const { parent, items } of moveItems) {
    if (parent.querySelector('.moxmox-gift-menu-item')) continue;
    const contextZoneId = lastContextCard.zoneId;
    const fragment = document.createDocumentFragment();
    const separator = document.createElement('div');
    separator.className = 'moxmox-gift-menu-separator';
    separator.setAttribute('role', 'separator');
    fragment.appendChild(separator);

    for (const opponent of giftOpponents) {
      const item = items[items.length - 1].cloneNode(true);
      item.classList.add('moxmox-gift-menu-item');
      item.textContent = `Give to ${opponent.username || 'Opponent'}`;
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
      item.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await giveCardToOpponent(opponent.id, contextZoneId);
      }, true);
      fragment.appendChild(item);
    }

    const trailingSeparator = document.createElement('div');
    trailingSeparator.className = 'moxmox-gift-menu-separator';
    trailingSeparator.setAttribute('role', 'separator');
    fragment.appendChild(trailingSeparator);

    parent.insertBefore(fragment, items[items.length - 1].nextSibling);
  }
}

function getGiftMenuOpponents(card) {
  const ownerId = card?.moxmoxGift?.ownerId;
  if (!ownerId) return giftState.opponents;
  return giftState.opponents.filter(opponent => opponent.id === ownerId);
}

function findMoveToMenuItems() {
  const candidates = [...document.querySelectorAll('button, a, [role="menuitem"], [tabindex], li, div, span')]
    .filter(el => {
      const text = (el.textContent || '').trim();
      return isVisible(el) && text.length < 100 && /^Move\s+To\b/i.test(text);
    });
  const byParent = new Map();
  for (const candidate of candidates) {
    const item = candidate.closest('button, a, [role="menuitem"], [tabindex], li') ||
      candidate.closest('div') ||
      candidate;
    const parent = item.parentElement;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    const items = byParent.get(parent);
    if (!items.includes(item)) items.push(item);
  }

  return [...byParent.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([parent, items]) => ({ parent, items }));
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

async function giveCardToOpponent(targetId, zoneId) {
  if (!targetId || !zoneId || !giftState.enabled || !giftState.localPlayerId) return;
  await controllerReady;
  const result = await withSync(async () => {
    return adapter.giveCardToOpponent(targetId, zoneId);
  });
  if (result) {
    post({ type: result.type, targetId, gift: result.gift });
  }
}

// ── Start ───────────────────────────────────────────────────────────

watchForPlaytestNavigation();
startGiftMenuIntegration();
ensureControllerInitialized();

function watchForPlaytestNavigation() {
  window.addEventListener('popstate', () => setTimeout(handlePlaytestRouteChange, 0));
  window.addEventListener('hashchange', () => setTimeout(handlePlaytestRouteChange, 0));
  setInterval(() => {
    handlePlaytestRouteChange();
  }, URL_CHECK_MS);
}

function handlePlaytestRouteChange() {
  const nextUrl = window.location.href;
  if (nextUrl === lastSeenUrl) return;

  const isPlaytest = isPlaytestPath();
  lastSeenUrl = nextUrl;

  if (!isPlaytest) {
    resetController();
    return;
  }
  ensureControllerInitialized();
}

function ensureControllerInitialized() {
  if (!isPlaytestPath()) return;
  if (adapter?.isAvailable()) return;
  initController();
}

function resetController() {
  controllerInitInProgress = false;
  if (adapter) {
    adapter.destroy();
    adapter = null;
  }
  if (controllerReadyResolved) {
    resetControllerReady();
  }
}

function resetControllerReady() {
  controllerReadyResolved = false;
  controllerReady = new Promise((resolve) => { resolveControllerReady = resolve; });
}

function isPlaytestPath() {
  const host = window.location.hostname;
  if (host === 'moxfield.com') {
    return /\/decks\/[^/]+\/goldfish$/.test(window.location.pathname);
  }
  if (host === 'archidekt.com') {
    return /\/playtester-v2\/\d+/.test(window.location.pathname);
  }
  return false;
}

function detectSite() {
  const host = window.location.hostname;
  if (host === 'moxfield.com') return 'moxfield';
  if (host === 'archidekt.com') return 'archidekt';
  return null;
}
