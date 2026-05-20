// MoxfieldAdapter — site adapter for Moxfield's playtest (goldfish) page.
//
// Wraps the PlaytestController and all Moxfield-specific game state
// operations. Exposes the standard adapter interface consumed by
// content-main.js.

import { PlaytestController } from '../playtest/index.js';

const GIFT_RETURN_ZONES = new Set(['hand', 'graveyard', 'exile', 'library']);

export class MoxfieldAdapter {
  constructor() {
    this._controller = null;
    this._listeners = new Map();
    this._selectionPollTimer = null;
    this._originalDidUpdate = null;
    this._giftState = { enabled: false, localPlayerId: null, opponents: [] };
    this._forwardedController = null;
  }

  get capabilities() {
    return {
      gifts: true,
      remoteHighlight: true,
      battlefieldDivider: true,
      saveStateDialog: true,
      librarySync: true,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  static isPlaytestPath() {
    return /\/decks\/[^/]+\/goldfish$/.test(window.location.pathname);
  }

  init(retries = 30, delay = 1000) {
    return new Promise((resolve) => {
      this._tryInit(retries, delay, resolve);
    });
  }

  _tryInit(retries, delay, resolve) {
    if (!MoxfieldAdapter.isPlaytestPath()) {
      resolve();
      return;
    }
    this._controller = new PlaytestController();
    if (this._controller.isAvailable()) {
      console.log('[MoxMox MAIN] MoxfieldAdapter ready');
      this._setupEventDetection();
      resolve();
      return;
    }

    // Diagnostics for retry logging.
    const mainEl = document.querySelector('main');
    const fiberKey = mainEl ? Object.keys(mainEl).find(k => k.startsWith('__reactFiber')) : null;
    if (mainEl && fiberKey) {
      let current = mainEl[fiberKey];
      for (let depth = 0; depth < 50 && current; depth++) {
        const s = current.stateNode;
        if (s && s !== window && s.state?.zones) {
          const zoneKeys = Object.keys(s.state.zones);
          console.log(`[MoxMox MAIN] depth ${depth}: FOUND ZONES!`, {
            zoneKeys,
            hasSetState: typeof s.setState === 'function',
            hasSaveData: typeof s.handleSaveData === 'function',
          });
          break;
        }
        current = current.return;
      }
    }
    console.log(`[MoxMox MAIN] init retry ${30 - retries + 1}/30`);

    this._controller = null;
    if (retries > 0) {
      setTimeout(() => this._tryInit(retries - 1, delay, resolve), delay);
    } else {
      console.warn('[MoxMox MAIN] Could not find playtest component');
      resolve();
    }
  }

  isAvailable() {
    return this._controller?.isAvailable() ?? false;
  }

  destroy() {
    if (this._selectionPollTimer) {
      clearInterval(this._selectionPollTimer);
      this._selectionPollTimer = null;
    }
    this._controller = null;
    this._forwardedController = null;
    this._listeners.clear();
  }

  // ── Events ──────────────────────────────────────────────────────────

  on(eventType, callback) {
    if (!this._listeners.has(eventType)) {
      this._listeners.set(eventType, new Set());
    }
    this._listeners.get(eventType).add(callback);
  }

  _emit(eventType, event) {
    const cbs = this._listeners.get(eventType);
    if (cbs) {
      for (const cb of cbs) cb(event);
    }
  }

  _setupEventDetection() {
    if (this._forwardedController === this._controller) return;
    this._forwardedController = this._controller;

    if (this._selectionPollTimer) {
      clearInterval(this._selectionPollTimer);
      this._selectionPollTimer = null;
    }

    this._controller.on('card:zone-changed', (ev) => {
      const clean = this._sanitizeEvent(ev);
      if (ev.fromZone === 'hand' || ev.toZone === 'hand') {
        clean.handCount = this._getHandCount();
      }
      if (ev.toZone === 'battlefield' && ev.card) {
        clean.card.top = ev.card.top;
        clean.card.left = ev.card.left;
      }
      this._emit('card:zone-changed', clean);
    });

    this._controller.on('card:removed', (ev) => {
      const clean = this._sanitizeEvent(ev);
      if (ev.fromZone === 'hand') {
        clean.handCount = this._getHandCount();
      }
      this._emit('card:removed', clean);
    });

    this._controller.on('card:state-changed', (ev) => {
      this._emit('card:state-changed', {
        type: ev.type,
        card: {
          id: ev.card.id, name: ev.card.name, syncId: ev.card.syncId,
          top: ev.card.top, left: ev.card.left,
        },
        changes: ev.changes,
      });
    });

    this._controller.on('zone:reordered', (ev) => {
      const zone = this._getInstance().state.zones[ev.zone];
      const syncIds = zone.map(c => c.syncId).filter(Boolean);
      this._emit('zone:reordered', { type: 'zone:reordered', zone: ev.zone, syncIds });
    });

    // Poll for selection changes.
    let lastSelectedSyncIds = [];
    this._selectionPollTimer = setInterval(() => {
      try {
        const inst = this._getInstance();
        const selected = inst.state.selectedCards || [];
        const syncIds = selected.map(c => c.syncId).filter(Boolean);
        const key = syncIds.join(',');
        if (key !== lastSelectedSyncIds.join(',')) {
          lastSelectedSyncIds = syncIds;
          this._emit('selection-changed', { type: 'selection-changed', syncIds });
        }
      } catch { /* controller not ready */ }
    }, 200);

    // Detect life changes via componentDidUpdate.
    const inst = this._getInstance();
    this._originalDidUpdate = inst.componentDidUpdate;
    const self = this;
    inst.componentDidUpdate = function (prevProps, prevState, snapshot) {
      if (typeof self._originalDidUpdate === 'function') {
        self._originalDidUpdate.call(this, prevProps, prevState, snapshot);
      }
      if (prevState?.life !== undefined && prevState.life !== this.state.life) {
        self._emit('life:changed', { type: 'life:changed', to: this.state.life });
      }
    };
  }

  _sanitizeEvent(ev) {
    const clean = { type: ev.type };
    if (ev.fromZone) clean.fromZone = ev.fromZone;
    if (ev.toZone) clean.toZone = ev.toZone;
    if (ev.card) {
      clean.card = {
        id: ev.card.id, name: ev.card.name, syncId: ev.card.syncId,
        scryfall_id: ev.card.scryfall_id,
      };
      if (ev.card.moxmoxGift) {
        clean.card.moxmoxGift = ev.card.moxmoxGift;
        clean.card.gift = {
          ...ev.card.moxmoxGift,
          card: this._serializeGiftCard(ev.card),
        };
      }
    }
    return clean;
  }

  // ── Command Dispatch ────────────────────────────────────────────────

  async dispatch(action, params) {
    switch (action) {
      case 'reset-to-library': return await this._resetHandToLibrary();
      case 'shuffle-library':
        this._controller.shuffleZone('library');
        this._assignSyncIds('library');
        return { ok: true };
      case 'draw': return await this._drawCards(params.count || 1);
      case 'get-library': return this._getLibrary();
      case 'set-library-from-sync': return await this._setLibraryFromSync(params.cards);
      case 'remove-top-from-library': return await this._removeTopFromLibrary(params.count || 1);
      case 'sync-remove': return await this._syncRemoveFromZone(params.zone, params.syncId);
      case 'sync-add': return await this._syncAddToZone(params.zone, params.cardId, params.syncId);
      case 'sync-add-battlefield': return await this._syncAddToBattlefield(params);
      case 'sync-move': return await this._syncMoveBetweenZones(params.fromZone, params.toZone, params.syncId);
      case 'sync-update-state': return await this._syncUpdateCardState(params.syncId, params.updates);
      case 'get-battlefield-size': return this._getBattlefieldSize();
      case 'get-life': return { life: this._getInstance().state.life };
      case 'get-hand-count': return { handCount: this._getHandCount() };
      case 'get-hand-cards': return this._getZoneCards('hand');
      case 'get-zone-cards': return this._getZoneCards(params.zone);
      case 'gift-add-battlefield': return await this._addGiftedCardToBattlefield(params.gift, {
        preserveGift: params.preserveGift !== false,
      });
      case 'gift-add-zone': return await this._addGiftedCardToZone(params.zone, params.gift);
      case 'gift-remove': return await this._removeGiftedCard(params.giftId);
      case 'apply-remote-highlight': return this._applyRemoteHighlight(params.syncIds);
      case 'inject-divider': return this._injectBattlefieldDivider();
      case 'discard-save-state': return this._discardSaveState();
      default: return { error: `Unknown action: ${action}` };
    }
  }

  // ── Gift State ──────────────────────────────────────────────────────

  setGiftState(state) {
    this._giftState = state;
  }

  // ── Card search (for gift menu) ─────────────────────────────────────

  findCardByZoneId(zoneId) {
    return this._controller?.findCardByZoneId(zoneId) ?? null;
  }

  // ── Give card to opponent (called from gift menu) ───────────────────

  async giveCardToOpponent(targetId, zoneId) {
    if (!targetId || !zoneId || !this._giftState.enabled || !this._giftState.localPlayerId) return null;
    const found = this._controller.findCardByZoneId(zoneId);
    if (!found) throw new Error('Card no longer exists');
    if (found.moxmoxGift) {
      if (found.moxmoxGift.ownerId !== targetId) {
        throw new Error('Gifted cards can only be returned to their owner');
      }
      const gift = {
        ...found.moxmoxGift,
        card: this._serializeGiftCard(found),
      };
      await this._removeCardByZoneId(zoneId);
      return { type: 'gift-return-battlefield', gift };
    }
    const giftId = found.syncId || this._generateZoneId();
    const card = { ...found, syncId: giftId };
    await this._removeCardByZoneId(zoneId);
    return { type: 'gift-card', gift: {
      ownerId: this._giftState.localPlayerId,
      ownerUsername: this._giftState.localUsername || 'Opponent',
      giftId,
      fromZone: found.zone,
      card: this._serializeGiftCard(card),
    } };
  }

  // ── Private: Instance access ────────────────────────────────────────

  _getInstance() {
    return this._controller._getInstance();
  }

  _setState(zoneUpdates) {
    return new Promise((resolve) => {
      const zones = { ...this._getInstance().state.zones, ...zoneUpdates };
      this._getInstance().setState({ zones }, () => {
        this._getInstance().handleSaveData();
        resolve();
      });
    });
  }

  // ── Private: Reads ──────────────────────────────────────────────────

  _getHandCount() {
    return this._getInstance().state.zones.hand.length;
  }

  _getZoneCards(zone) {
    if (!['hand', 'graveyard', 'exile'].includes(zone)) {
      return { error: `Unsupported zone: ${zone}` };
    }
    const cards = this._getInstance().state.zones[zone] || [];
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

  _getLibrary() {
    return {
      cards: this._getInstance().state.zones.library.map(c => ({
        cardId: c.id, syncId: c.syncId,
      })),
    };
  }

  _getBattlefieldSize() {
    const inst = this._getInstance();
    const zoom = inst.state.zoomLevel / 100;
    const cardW = inst.state.baseWidth * zoom;
    const cardH = inst.state.baseHeight * zoom;
    const container = inst._battlefieldContainer?.current;
    if (!container) {
      return { width: 0, height: 0, usableWidth: 0, cardW, cardH };
    }
    const rect = container.getBoundingClientRect();
    const toolbarWidth = 120 * zoom + cardW;
    const usableWidth = Math.max(cardW, rect.width - toolbarWidth);
    return { width: rect.width, height: rect.height, usableWidth, cardW, cardH };
  }

  // ── Private: Game operations ────────────────────────────────────────

  async _resetHandToLibrary() {
    const { hand, library } = this._getInstance().state.zones;
    if (hand.length === 0) return { moved: 0 };
    const returned = hand.map(c => ({ ...c, zone: 'library' }));
    await this._setState({ hand: [], library: [...library, ...returned] });
    return { moved: returned.length };
  }

  async _drawCards(count) {
    const lib = [...this._getInstance().state.zones.library];
    const hand = [...this._getInstance().state.zones.hand];
    const drawn = [];
    const n = Math.min(count, lib.length);
    for (let i = 0; i < n; i++) {
      const card = lib.pop();
      card.zone = 'hand';
      hand.push(card);
      drawn.push({ cardId: card.id, syncId: card.syncId });
    }
    await this._setState({ library: lib, hand });
    return { drawn, count: n };
  }

  async _setLibraryFromSync(syncCards) {
    const current = [...this._getInstance().state.zones.library];
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
    await this._setState({ library: newLib });
    return { ok: true, count: newLib.length };
  }

  async _removeTopFromLibrary(count) {
    const lib = [...this._getInstance().state.zones.library];
    const removed = [];
    for (let i = 0; i < count && lib.length > 0; i++) {
      removed.push(lib.pop());
    }
    await this._setState({ library: lib });
    return { removedCount: removed.length };
  }

  _assignSyncIds(zone) {
    const cards = this._getInstance().state.zones[zone];
    for (const card of cards) {
      if (!card.syncId) {
        card.syncId = this._generateZoneId();
      }
    }
  }

  // ── Private: Sync operations ────────────────────────────────────────

  async _syncRemoveFromZone(zone, syncId) {
    const cards = [...this._getInstance().state.zones[zone]];
    const idx = cards.findIndex(c => c.syncId === syncId);
    if (idx === -1) return { error: `syncId ${syncId} not found in ${zone}` };
    cards.splice(idx, 1);
    await this._setState({ [zone]: cards });
    return { ok: true };
  }

  async _syncAddToZone(zone, cardId, syncId) {
    const usedZoneIds = [];
    for (const cards of Object.values(this._getInstance().state.zones)) {
      for (const c of cards) usedZoneIds.push(c.zoneId);
    }
    const template = this._getInstance().getCardFromId(cardId, usedZoneIds);
    if (!template) return { error: `Card ${cardId} not found in deck data` };
    const card = {
      ...template, zone, syncId,
      zoneId: this._generateZoneId(),
      tapped: false, flipped: false, rotated: false,
      top: undefined, left: undefined,
    };
    const cards = [...this._getInstance().state.zones[zone], card];
    await this._setState({ [zone]: cards });
    return { ok: true };
  }

  async _syncAddToBattlefield({ cardId, syncId, top, left, rotated }) {
    const usedZoneIds = [];
    for (const cards of Object.values(this._getInstance().state.zones)) {
      for (const c of cards) usedZoneIds.push(c.zoneId);
    }
    const template = this._getInstance().getCardFromId(cardId, usedZoneIds);
    if (!template) return { error: `Card ${cardId} not found in deck data` };
    const card = {
      ...template, zone: 'battlefield', syncId,
      zoneId: this._generateZoneId(),
      tapped: false, flipped: false,
      rotated: !!rotated, doesntUntap: !!rotated,
      top: top ?? 0, left: left ?? 0,
    };
    const bf = [...this._getInstance().state.zones.battlefield, card];
    await this._setState({ battlefield: bf });
    return { ok: true };
  }

  async _syncMoveBetweenZones(fromZone, toZone, syncId) {
    const from = [...this._getInstance().state.zones[fromZone]];
    const idx = from.findIndex(c => c.syncId === syncId);
    if (idx === -1) return { error: `syncId ${syncId} not found in ${fromZone}` };
    const card = { ...from[idx], zone: toZone };
    if (fromZone === 'battlefield' && toZone !== 'battlefield') {
      card.top = undefined;
      card.left = undefined;
      card.tapped = false;
      card.flipped = false;
      card.rotated = false;
    }
    from.splice(idx, 1);
    const to = [...this._getInstance().state.zones[toZone], card];
    await this._setState({ [fromZone]: from, [toZone]: to });
    return { ok: true };
  }

  async _syncUpdateCardState(syncId, updates) {
    const bf = this._getInstance().state.zones.battlefield;
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
    await this._setState({ battlefield: newBf });
    return { ok: true };
  }

  // ── Private: Gift operations ────────────────────────────────────────

  _serializeGiftCard(card) {
    const clone = JSON.parse(JSON.stringify(card));
    delete clone.zoneId;
    delete clone.top;
    delete clone.left;
    delete clone.zone;
    return clone;
  }

  _materializeGiftedCard(gift, zone, { preserveGift = true } = {}) {
    if (!gift?.card || !gift.ownerId || !gift.giftId) {
      throw new Error('Invalid gifted card payload');
    }
    const card = {
      ...JSON.parse(JSON.stringify(gift.card)),
      zone,
      syncId: gift.giftId,
      zoneId: this._generateZoneId(),
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

  async _addGiftedCardToBattlefield(gift, { preserveGift = true } = {}) {
    const size = this._getBattlefieldSize();
    const card = {
      ...this._materializeGiftedCard(gift, 'battlefield', { preserveGift }),
      top: Math.max(0, Math.round((size.height - size.cardH) / 2)),
      left: Math.max(0, Math.round((size.usableWidth - size.cardW) / 2)),
      tapped: false, flipped: false, rotated: false, doesntUntap: false,
    };
    const bf = [...this._getInstance().state.zones.battlefield, card];
    await this._setState({ battlefield: bf });
    return { ok: true };
  }

  async _addGiftedCardToZone(zone, gift) {
    if (!GIFT_RETURN_ZONES.has(zone)) {
      return { error: `Unsupported gift return zone: ${zone}` };
    }
    const card = this._materializeGiftedCard(gift, zone, { preserveGift: false });
    card.top = undefined;
    card.left = undefined;
    card.tapped = false;
    card.flipped = false;
    card.rotated = false;
    card.doesntUntap = false;
    const cards = [...this._getInstance().state.zones[zone], card];
    await this._setState({ [zone]: cards });
    return { ok: true };
  }

  async _removeGiftedCard(giftId) {
    if (!giftId) return { error: 'Missing giftId' };
    const zones = this._getInstance().state.zones;
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
    await this._setState(updates);
    return { ok: true, removed };
  }

  async _removeCardByZoneId(zoneId) {
    const zones = this._getInstance().state.zones;
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
    await this._setState(updates);
  }

  // ── Private: Site-specific UI ───────────────────────────────────────

  _discardSaveState() {
    const inst = this._getInstance();
    if (typeof inst.handleDiscardSaveState === 'function') {
      inst.handleDiscardSaveState();
      return { ok: true };
    }
    if (inst.state.isSaveStateModalOpen) {
      inst.setState({ isSaveStateModalOpen: false });
      return { ok: true, fallback: true };
    }
    return { ok: true, noDialog: true };
  }

  _injectBattlefieldDivider() {
    const container = this._getInstance()._battlefieldContainer?.current;
    if (!container) return { error: 'no battlefield container' };
    if (container.querySelector('.moxmox-divider')) return { ok: true };
    const style = getComputedStyle(container);
    if (style.position === 'static') {
      container.style.position = 'relative';
    }
    const line = document.createElement('div');
    line.className = 'moxmox-divider';
    container.appendChild(line);
    return { ok: true };
  }

  _applyRemoteHighlight(syncIds) {
    const targetIds = new Set(syncIds || []);
    const bf = this._getInstance().state.zones.battlefield;
    document.querySelectorAll('.moxmox-remote-highlight').forEach(el => {
      el.classList.remove('moxmox-remote-highlight');
    });
    if (targetIds.size === 0) return { ok: true };
    const zoneIdsBySyncId = new Map();
    for (const card of bf) {
      if (card.syncId && targetIds.has(card.syncId)) {
        zoneIdsBySyncId.set(card.syncId, card.zoneId);
      }
    }
    if (zoneIdsBySyncId.size === 0) return { ok: true };
    const mainEl = document.querySelector('main');
    if (!mainEl) return { ok: true };
    const fiberKey = Object.keys(mainEl).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) return { ok: true };
    const containers = document.querySelectorAll('[style*="position"]');
    for (const el of containers) {
      const fiber = el[fiberKey];
      if (!fiber) continue;
      let current = fiber;
      for (let depth = 0; depth < 5 && current; depth++) {
        const props = current.memoizedProps || current.pendingProps;
        if (props?.card?.zoneId && zoneIdsBySyncId.has(props.card.syncId)) {
          el.classList.add('moxmox-remote-highlight');
          break;
        }
        current = current.return;
      }
    }
    return { ok: true };
  }

  // ── Private: Helpers ────────────────────────────────────────────────

  _generateZoneId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }
}
