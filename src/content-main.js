// MoxMox content-main script — runs in the page's MAIN world.
//
// Has access to React internals. Communicates with the ISOLATED-world
// content script via window.postMessage (CustomEvent.detail does not
// cross MV3 content-script worlds).

import { PlaytestController } from './playtest/index.js';

const SHARED_ZONES = new Set(['library', 'graveyard', 'exile']);
const MSG_TAG = 'moxmox';
const URL_CHECK_MS = 500;
const GIFT_RETURN_ZONES = new Set(['hand', 'graveyard', 'exile', 'library']);

let controller = null;
let syncDepth = 0;
let controllerReady;
let resolveControllerReady;
let controllerReadyResolved = false;
let controllerInitInProgress = false;
let forwardedController = null;
let lastSeenUrl = window.location.href;
let selectionPollTimer = null;
let giftState = { enabled: false, localPlayerId: null, opponents: [] };
let lastContextCard = null;
let lastContextPoint = null;
let giftMenuObserver = null;

// Promise that resolves when the controller is initialized.
resetControllerReady();

/** Get the live React component instance from the controller. */
function getInstance() {
  return controller._getInstance();
}

// ── Initialization ──────────────────────────────────────────────────

function initController(retries = 30, delay = 1000) {
  if (!isGoldfishPath()) {
    controllerInitInProgress = false;
    return;
  }
  if (controllerInitInProgress && retries === 30) return;
  controllerInitInProgress = true;
  controller = new PlaytestController();
  if (controller.isAvailable()) {
    console.log('[MoxMox MAIN] PlaytestController ready');
    controllerInitInProgress = false;
    setupEventForwarding();
    controllerReadyResolved = true;
    resolveControllerReady();
    post({ type: 'ready' });
    return;
  }

  // Diagnostics: manually walk the fiber tree to understand what we find.
  const mainEl = document.querySelector('main');
  const fiberKey = mainEl ? Object.keys(mainEl).find(k => k.startsWith('__reactFiber')) : null;
  if (mainEl && fiberKey) {
    let current = mainEl[fiberKey];
    let foundAnyStateNode = false;
    for (let depth = 0; depth < 50 && current; depth++) {
      const s = current.stateNode;
      if (s && s !== window) {
        if (s.state) {
          const stateKeys = Object.keys(s.state).slice(0, 10);
          console.log(`[MoxMox MAIN] depth ${depth}: stateNode has state keys:`, stateKeys);
          foundAnyStateNode = true;
          if (s.state.zones) {
            const zoneKeys = Object.keys(s.state.zones);
            console.log(`[MoxMox MAIN] depth ${depth}: FOUND ZONES!`, {
              zoneKeys,
              hasSetState: typeof s.setState === 'function',
              hasSaveData: typeof s.handleSaveData === 'function',
              hasDraw: typeof s.handleDraw === 'function',
              hasShuffle: typeof s.handleShuffle === 'function',
            });
            break;
          }
        }
      }
      current = current.return;
    }
    if (!foundAnyStateNode) {
      console.log('[MoxMox MAIN] No stateNode with state found in 50 levels');
      // Check if we can read the fiber at all.
      const firstFiber = mainEl[fiberKey];
      console.log('[MoxMox MAIN] fiber type:', typeof firstFiber, 'has return:', !!firstFiber?.return);
    }
  }

  console.log(`[MoxMox MAIN] init retry ${30 - retries + 1}/30: main=${!!mainEl}, fiber=${!!fiberKey}`);

  controller = null;
  if (retries > 0) {
    setTimeout(() => initController(retries - 1, delay), delay);
  } else {
    controllerInitInProgress = false;
    console.warn('[MoxMox MAIN] Could not find playtest component');
  }
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
  }
});

async function handleCommand(id, action, params) {
  let data;
  try {
    await controllerReady;
    console.log(`[MoxMox MAIN] cmd: ${action}`, params);
    data = await dispatch(action, params);
    console.log(`[MoxMox MAIN] result: ${action}`, data);
  } catch (err) {
    console.error(`[MoxMox MAIN] error: ${action}`, err);
    data = { error: err.message };
  }
  post({ type: 'result', id, data });
}

// ── Command dispatch ────────────────────────────────────────────────

async function dispatch(action, params) {
  switch (action) {
    // Game-start operations — suppress event forwarding.
    case 'reset-to-library': return await withSync(() => resetHandToLibrary());
    case 'shuffle-library':
      return await withSync(() => {
        controller.shuffleZone('library');
        assignSyncIds('library');
        return { ok: true };
      });
    case 'draw': return await withSync(() => drawCards(params.count || 1));
    case 'get-library': return getLibrary();
    case 'set-library-from-sync': return await withSync(() => setLibraryFromSync(params.cards));
    case 'remove-top-from-library': return await withSync(() => removeTopFromLibrary(params.count || 1));
    // Remote sync operations — also suppress event forwarding.
    case 'sync-remove': return await withSync(() => syncRemoveFromZone(params.zone, params.syncId));
    case 'sync-add': return await withSync(() => syncAddToZone(params.zone, params.cardId, params.syncId));
    case 'sync-add-battlefield': return await withSync(() => syncAddToBattlefield(params));
    case 'sync-move': return await withSync(() => syncMoveBetweenZones(params.fromZone, params.toZone, params.syncId));
    case 'sync-update-state': return await withSync(() => syncUpdateCardState(params.syncId, params.updates));
    case 'get-battlefield-size': return getBattlefieldSize();
    case 'get-life': return { life: getInstance().state.life };
    case 'get-hand-count': return { handCount: getHandCount() };
    case 'get-hand-cards': return getHandCards();
    case 'get-zone-cards': return getZoneCards(params.zone);
    case 'gift-add-battlefield': return await withSync(() => addGiftedCardToBattlefield(params.gift, {
      preserveGift: params.preserveGift !== false,
    }));
    case 'gift-add-zone': return await withSync(() => addGiftedCardToZone(params.zone, params.gift));
    case 'gift-remove': return await withSync(() => removeGiftedCard(params.giftId));
    case 'apply-remote-highlight': return applyRemoteHighlight(params.syncIds);
    case 'inject-divider': return injectBattlefieldDivider();
    case 'discard-save-state': return discardSaveState();
    default: return { error: `Unknown action: ${action}` };
  }
}

async function withSync(fn) {
  syncDepth++;
  try { return await fn(); }
  finally { syncDepth--; }
}

// ── Event forwarding (PlaytestController → ISOLATED) ────────────────

function setupEventForwarding() {
  if (forwardedController === controller) return;
  forwardedController = controller;
  if (selectionPollTimer) {
    clearInterval(selectionPollTimer);
    selectionPollTimer = null;
  }

  controller.on('card:zone-changed', (ev) => {
    if (syncDepth > 0) return;
    const clean = sanitizeEvent(ev);
    if (ev.fromZone === 'hand' || ev.toZone === 'hand') {
      clean.handCount = getHandCount();
    }
    if (ev.toZone === 'battlefield' && ev.card) {
      clean.card.top = ev.card.top;
      clean.card.left = ev.card.left;
    }
    post({ type: 'game-event', event: clean });
  });
  controller.on('card:removed', (ev) => {
    if (syncDepth > 0) return;
    const clean = sanitizeEvent(ev);
    if (ev.fromZone === 'hand') {
      clean.handCount = getHandCount();
    }
    post({ type: 'game-event', event: clean });
  });
  controller.on('card:state-changed', (ev) => {
    if (syncDepth > 0) {
      console.log('[MoxMox MAIN] state-changed suppressed (syncDepth=' + syncDepth + ')');
      return;
    }
    console.log('[MoxMox MAIN] state-changed forwarding:', ev.card?.name, ev.card?.syncId,
      Object.keys(ev.changes || {}));
    post({
      type: 'game-event',
      event: {
        type: ev.type,
        card: { id: ev.card.id, name: ev.card.name, syncId: ev.card.syncId,
                top: ev.card.top, left: ev.card.left },
        changes: ev.changes,
      },
    });
  });
  controller.on('zone:reordered', (ev) => {
    if (syncDepth > 0) return;
    const zone = getInstance().state.zones[ev.zone];
    const syncIds = zone.map(c => c.syncId).filter(Boolean);
    post({ type: 'game-event', event: { type: 'zone:reordered', zone: ev.zone, syncIds } });
  });

  // Poll for selection changes (selectedCards is component state, not per-card).
  let lastSelectedSyncIds = [];
  selectionPollTimer = setInterval(() => {
    if (syncDepth > 0) return;
    try {
      const inst = getInstance();
      const selected = inst.state.selectedCards || [];
      const syncIds = selected.map(c => c.syncId).filter(Boolean);
      const key = syncIds.join(',');
      if (key !== lastSelectedSyncIds.join(',')) {
        lastSelectedSyncIds = syncIds;
        post({ type: 'game-event', event: { type: 'selection-changed', syncIds } });
      }
    } catch { /* controller not ready */ }
  }, 200);

  // Detect life changes via componentDidUpdate (catches all state updates).
  const inst = getInstance();
  const originalDidUpdate = inst.componentDidUpdate;
  inst.componentDidUpdate = function (prevProps, prevState, snapshot) {
    if (typeof originalDidUpdate === 'function') {
      originalDidUpdate.call(this, prevProps, prevState, snapshot);
    }
    if (prevState?.life !== undefined && prevState.life !== this.state.life) {
      if (syncDepth === 0) {
        post({ type: 'game-event', event: { type: 'life:changed', to: this.state.life } });
      }
    }
  };
}

/** Strip non-cloneable / oversized fields from card data before posting. */
function sanitizeEvent(ev) {
  const clean = { type: ev.type };
  if (ev.fromZone) clean.fromZone = ev.fromZone;
  if (ev.toZone) clean.toZone = ev.toZone;
  if (ev.card) {
    clean.card = { id: ev.card.id, name: ev.card.name, syncId: ev.card.syncId };
    if (ev.card.moxmoxGift) {
      clean.card.moxmoxGift = ev.card.moxmoxGift;
      clean.card.gift = {
        ...ev.card.moxmoxGift,
        card: serializeGiftCard(ev.card),
      };
    }
  }
  return clean;
}

// ── Remote highlight ────────────────────────────────────────────────

/**
 * Apply a visual highlight (CSS class) to battlefield cards by syncId.
 * This doesn't use Moxfield's selection — it's a pure DOM overlay so
 * it doesn't interfere with the local player's own selection.
 */
function applyRemoteHighlight(syncIds) {
  const targetIds = new Set(syncIds || []);
  const bf = getInstance().state.zones.battlefield;

  // Remove all existing remote highlights.
  document.querySelectorAll('.moxmox-remote-highlight').forEach(el => {
    el.classList.remove('moxmox-remote-highlight');
  });

  if (targetIds.size === 0) return { ok: true };

  // Build a map of syncId → zoneId for the targeted cards.
  const zoneIdsBySyncId = new Map();
  for (const card of bf) {
    if (card.syncId && targetIds.has(card.syncId)) {
      zoneIdsBySyncId.set(card.syncId, card.zoneId);
    }
  }

  // Find the DOM elements for these cards. Moxfield renders battlefield
  // cards as draggable divs with data attributes or unique structure.
  // We find them by matching the card image or container.
  const fiberKey = Object.keys(document.querySelector('main') || {}).find(k => k.startsWith('__reactFiber'));
  if (!fiberKey) return { ok: true };

  const containers = document.querySelectorAll('[style*="position"]');
  for (const el of containers) {
    const fiber = el[fiberKey];
    if (!fiber) continue;
    // Walk up a few levels to find the card's props with zoneId.
    let cur = fiber;
    for (let d = 0; d < 5 && cur; d++) {
      const props = cur.memoizedProps || cur.pendingProps;
      if (props?.card?.zoneId && zoneIdsBySyncId.has(props.card.syncId)) {
        el.classList.add('moxmox-remote-highlight');
        break;
      }
      // Also check the id prop which might be the zoneId.
      if (props?.id && [...zoneIdsBySyncId.values()].includes(props.id)) {
        el.classList.add('moxmox-remote-highlight');
        break;
      }
      cur = cur.return;
    }
  }

  return { ok: true };
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
  if (!controller?.isAvailable()) return null;
  let el = element instanceof Element ? element : element?.parentElement;
  while (el) {
    const card = findCardFromFiberElement(el);
    if (card) return card;
    el = el.parentElement;
  }
  return null;
}

function findCardFromPoint(x, y) {
  if (!controller?.isAvailable()) return null;
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
      const card = controller.findCardByZoneId(zoneId);
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
    const found = controller.findCardByZoneId(zoneId);
    if (!found) throw new Error('Card no longer exists');
    if (found.moxmoxGift) {
      if (found.moxmoxGift.ownerId !== targetId) {
        throw new Error('Gifted cards can only be returned to their owner');
      }
      const gift = {
        ...found.moxmoxGift,
        card: serializeGiftCard(found),
      };
      await removeCardByZoneId(zoneId);
      return { type: 'gift-return-battlefield', gift };
    }
    const giftId = found.syncId || generateZoneId();
    const card = { ...found, syncId: giftId };
    await removeCardByZoneId(zoneId);
    return { type: 'gift-card', gift: {
      ownerId: giftState.localPlayerId,
      ownerUsername: giftState.localUsername || 'Opponent',
      giftId,
      fromZone: found.zone,
      card: serializeGiftCard(card),
    } };
  });
  post({ type: result.type, targetId, gift: result.gift });
}

async function removeCardByZoneId(zoneId) {
  const zones = getInstance().state.zones;
  const updates = {};
  let removed = 0;
  for (const [zone, cards] of Object.entries(zones)) {
    const filtered = cards.filter(card => card.zoneId !== zoneId);
    if (filtered.length !== cards.length) {
      updates[zone] = filtered;
      removed += cards.length - filtered.length;
    }
  }
  if (removed === 0) throw new Error(`Card with zoneId "${zoneId}" not found`);
  await setState(updates);
}

// ── Game operations ─────────────────────────────────────────────────

function getHandCards() {
  return getZoneCards('hand');
}

function getHandCount() {
  return getInstance().state.zones.hand.length;
}

function getZoneCards(zone) {
  if (!['hand', 'graveyard', 'exile'].includes(zone)) {
    return { error: `Unsupported zone: ${zone}` };
  }
  const cards = getInstance().state.zones[zone] || [];
  return {
    cards: cards.map(c => ({
      name: c.name,
      set: c.set,
      cn: c.cn,
      layout: c.layout,
      card_faces: c.card_faces,
    })),
  };
}

function serializeGiftCard(card) {
  const clone = JSON.parse(JSON.stringify(card));
  delete clone.zoneId;
  delete clone.top;
  delete clone.left;
  delete clone.zone;
  return clone;
}

function materializeGiftedCard(gift, zone, { preserveGift = true } = {}) {
  if (!gift?.card || !gift.ownerId || !gift.giftId) {
    throw new Error('Invalid gifted card payload');
  }

  const card = {
    ...JSON.parse(JSON.stringify(gift.card)),
    zone,
    syncId: gift.giftId,
    zoneId: generateZoneId(),
  };
  delete card.moxmoxGift;
  if (preserveGift) {
    card.moxmoxGift = {
      ownerId: gift.ownerId,
      ownerUsername: gift.ownerUsername || 'Opponent',
      giftId: gift.giftId,
    };
  }
  return card;
}

async function addGiftedCardToBattlefield(gift, { preserveGift = true } = {}) {
  const size = getBattlefieldSize();
  const card = {
    ...materializeGiftedCard(gift, 'battlefield', { preserveGift }),
    top: Math.max(0, Math.round((size.height - size.cardH) / 2)),
    left: Math.max(0, Math.round((size.usableWidth - size.cardW) / 2)),
    tapped: false,
    flipped: false,
    rotated: false,
    doesntUntap: false,
  };
  const bf = [...getInstance().state.zones.battlefield, card];
  await setState({ battlefield: bf });
  return { ok: true };
}

async function addGiftedCardToZone(zone, gift) {
  if (!GIFT_RETURN_ZONES.has(zone)) {
    return { error: `Unsupported gift return zone: ${zone}` };
  }
  const card = materializeGiftedCard(gift, zone, { preserveGift: false });
  card.top = undefined;
  card.left = undefined;
  card.tapped = false;
  card.flipped = false;
  card.rotated = false;
  card.doesntUntap = false;
  const cards = [...getInstance().state.zones[zone], card];
  await setState({ [zone]: cards });
  return { ok: true };
}

async function removeGiftedCard(giftId) {
  if (!giftId) return { error: 'Missing giftId' };
  const zones = getInstance().state.zones;
  const updates = {};
  let removed = 0;
  for (const [zone, cards] of Object.entries(zones)) {
    const filtered = cards.filter(card => card.moxmoxGift?.giftId !== giftId);
    if (filtered.length !== cards.length) {
      updates[zone] = filtered;
      removed += cards.length - filtered.length;
    }
  }
  if (removed === 0) return { error: `Gifted card ${giftId} not found` };
  await setState(updates);
  return { ok: true, removed };
}

function setState(zoneUpdates) {
  return new Promise((resolve) => {
    const zones = { ...getInstance().state.zones, ...zoneUpdates };
    getInstance().setState({ zones }, () => {
      getInstance().handleSaveData();
      resolve();
    });
  });
}

async function resetHandToLibrary() {
  const { hand, library } = getInstance().state.zones;
  if (hand.length === 0) return { moved: 0 };
  const returned = hand.map(c => ({ ...c, zone: 'library' }));
  await setState({ hand: [], library: [...library, ...returned] });
  return { moved: returned.length };
}

async function drawCards(count) {
  const lib = [...getInstance().state.zones.library];
  const hand = [...getInstance().state.zones.hand];
  const drawn = [];
  const n = Math.min(count, lib.length);
  for (let i = 0; i < n; i++) {
    const card = lib.pop();
    card.zone = 'hand';
    hand.push(card);
    drawn.push({ cardId: card.id, syncId: card.syncId });
  }
  await setState({ library: lib, hand });
  return { drawn, count: n };
}

function getLibrary() {
  return {
    cards: getInstance().state.zones.library.map(c => ({
      cardId: c.id, syncId: c.syncId,
    })),
  };
}

/**
 * Replace the library with a specific set of cards in order.
 * Each entry has { cardId, syncId }. We match our current library
 * cards by cardId (greedy) and assign the syncId from the host.
 */
async function setLibraryFromSync(syncCards) {
  const current = [...getInstance().state.zones.library];

  // Group by cardId for greedy matching.
  const byId = new Map();
  for (const card of current) {
    if (!byId.has(card.id)) byId.set(card.id, []);
    byId.get(card.id).push(card);
  }

  const newLib = [];
  for (const { cardId, syncId } of syncCards) {
    const pool = byId.get(cardId);
    if (pool && pool.length > 0) {
      const card = pool.shift();
      card.syncId = syncId;
      card.zone = 'library';
      newLib.push(card);
    }
  }
  await setState({ library: newLib });
  return { ok: true, count: newLib.length };
}

async function removeTopFromLibrary(count) {
  const lib = [...getInstance().state.zones.library];
  const removed = [];
  for (let i = 0; i < count && lib.length > 0; i++) {
    removed.push(lib.pop());
  }
  await setState({ library: lib });
  return { removedCount: removed.length };
}

// ── Sync operations (applied from remote player) ────────────────────

async function syncRemoveFromZone(zone, syncId) {
  const cards = [...getInstance().state.zones[zone]];
  const idx = cards.findIndex(c => c.syncId === syncId);
  if (idx === -1) return { error: `syncId ${syncId} not found in ${zone}` };
  cards.splice(idx, 1);
  await setState({ [zone]: cards });
  return { ok: true };
}

async function syncAddToZone(zone, cardId, syncId) {
  // Materialize a card from the deck data.
  const usedZoneIds = [];
  for (const cards of Object.values(getInstance().state.zones)) {
    for (const c of cards) usedZoneIds.push(c.zoneId);
  }
  const template = getInstance().getCardFromId(cardId, usedZoneIds);
  if (!template) return { error: `Card ${cardId} not found in deck data` };

  const card = {
    ...template,
    zone,
    syncId,
    zoneId: generateZoneId(),
    tapped: false,
    flipped: false,
    rotated: false,
    top: undefined,
    left: undefined,
  };
  const cards = [...getInstance().state.zones[zone], card];
  await setState({ [zone]: cards });
  return { ok: true };
}

async function syncMoveBetweenZones(fromZone, toZone, syncId) {
  const from = [...getInstance().state.zones[fromZone]];
  const idx = from.findIndex(c => c.syncId === syncId);
  if (idx === -1) return { error: `syncId ${syncId} not found in ${fromZone}` };
  const card = { ...from[idx], zone: toZone };
  // Clear battlefield props when leaving battlefield.
  if (fromZone === 'battlefield' && toZone !== 'battlefield') {
    card.top = undefined;
    card.left = undefined;
    card.tapped = false;
    card.flipped = false;
    card.rotated = false;
  }
  from.splice(idx, 1);
  const to = [...getInstance().state.zones[toZone], card];
  await setState({ [fromZone]: from, [toZone]: to });
  return { ok: true };
}

/**
 * Add a card to the battlefield at a specific pixel position.
 * The ISOLATED world has already translated percentage coords → pixels.
 */
async function syncAddToBattlefield({ cardId, syncId, top, left, rotated }) {
  const usedZoneIds = [];
  for (const cards of Object.values(getInstance().state.zones)) {
    for (const c of cards) usedZoneIds.push(c.zoneId);
  }
  const template = getInstance().getCardFromId(cardId, usedZoneIds);
  if (!template) return { error: `Card ${cardId} not found in deck data` };

  const card = {
    ...template,
    zone: 'battlefield',
    syncId,
    zoneId: generateZoneId(),
    tapped: false,
    flipped: false,
    rotated: !!rotated,
    doesntUntap: false,
    top: top ?? 0,
    left: left ?? 0,
  };
  const bf = [...getInstance().state.zones.battlefield, card];
  await setState({ battlefield: bf });
  return { ok: true };
}

/**
 * Update state properties on a battlefield card (by syncId).
 * Coordinates (top/left) should already be translated to local pixels.
 */
async function syncUpdateCardState(syncId, updates) {
  const bf = getInstance().state.zones.battlefield;
  const idx = bf.findIndex(c => c.syncId === syncId);
  if (idx === -1) return { error: `syncId ${syncId} not found on battlefield` };

  const allowed = [
    'tapped', 'flipped', 'rotated', 'doesntUntap',
    'top', 'left',
    'counters', 'adjustedPower', 'adjustedToughness', 'adjustedLoyalty',
  ];
  const sanitized = {};
  for (const key of allowed) {
    if (key in updates) sanitized[key] = updates[key];
  }

  const newBf = bf.map((c, i) => (i === idx ? { ...c, ...sanitized } : c));
  await setState({ battlefield: newBf });
  return { ok: true };
}

/**
 * Get battlefield container dimensions, card size, and usable area.
 * The toolbar buttons overlay the top-right of the battlefield.
 * We subtract their width to prevent mirrored cards landing behind them.
 */
function getBattlefieldSize() {
  const inst = getInstance();
  const zoom = inst.state.zoomLevel / 100;
  const cardW = inst.state.baseWidth * zoom;
  const cardH = inst.state.baseHeight * zoom;

  const container = inst._battlefieldContainer?.current;
  if (!container) {
    return { width: 0, height: 0, usableWidth: 0, cardW, cardH };
  }

  const rect = container.getBoundingClientRect();

  // The toolbar buttons are ~120px wide at 100% zoom and scale with zoom.
  // Add one card width of padding so cards don't touch buttons.
  const toolbarWidth = 120 * zoom + cardW;
  const usableWidth = Math.max(cardW, rect.width - toolbarWidth);

  return { width: rect.width, height: rect.height, usableWidth, cardW, cardH };
}

function generateZoneId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
}

/**
 * Inject a horizontal divider line at the vertical center of the
 * battlefield container. Uses position:absolute + top:50% so it
 * stays centered even if the battlefield resizes.
 */
function injectBattlefieldDivider() {
  const container = getInstance()._battlefieldContainer?.current;
  if (!container) return { error: 'no battlefield container' };

  // Don't inject twice.
  if (container.querySelector('.moxmox-divider')) return { ok: true };

  // The container needs relative positioning for the absolute child.
  const style = getComputedStyle(container);
  if (style.position === 'static') {
    container.style.position = 'relative';
  }

  const line = document.createElement('div');
  line.className = 'moxmox-divider';
  container.appendChild(line);

  return { ok: true };
}

/**
 * Dismiss Moxfield's "Save State Found" dialog by calling the
 * component's handleDiscardSaveState method.
 */
function discardSaveState() {
  const inst = getInstance();
  if (typeof inst.handleDiscardSaveState === 'function') {
    inst.handleDiscardSaveState();
    return { ok: true };
  }
  // Fallback: close the modal via state if the method isn't available.
  if (inst.state.isSaveStateModalOpen) {
    inst.setState({ isSaveStateModalOpen: false });
    return { ok: true, fallback: true };
  }
  return { ok: true, noDialog: true };
}

/** Assign a unique syncId to every card in a zone (if not already set). */
function assignSyncIds(zone) {
  const zones = getInstance().state.zones;
  const cards = zones[zone];
  for (const card of cards) {
    if (!card.syncId) {
      card.syncId = generateZoneId();
    }
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

  const isPlaytest = isGoldfishPath();
  lastSeenUrl = nextUrl;

  if (!isPlaytest) {
    resetController();
    return;
  }
  ensureControllerInitialized();
}

function ensureControllerInitialized() {
  if (!isGoldfishPath()) return;
  if (controller?.isAvailable()) return;
  initController();
}

function resetController() {
  controllerInitInProgress = false;
  controller = null;
  forwardedController = null;
  if (controllerReadyResolved) {
    resetControllerReady();
  }
  if (selectionPollTimer) {
    clearInterval(selectionPollTimer);
    selectionPollTimer = null;
  }
}

function resetControllerReady() {
  controllerReadyResolved = false;
  controllerReady = new Promise((resolve) => { resolveControllerReady = resolve; });
}

function isGoldfishPath() {
  return /\/decks\/[^/]+\/goldfish$/.test(window.location.pathname);
}
