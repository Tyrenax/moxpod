// ArchidektAdapter — site adapter for Archidekt's playtester-v2 page.
//
// Wraps a Redux store and provides the standard adapter interface consumed
// by content-main.js. Uses store.subscribe() + snapshot diffing for change
// detection, and store.dispatch() for mutations.

import { findArchidektStore, discoverActionType } from './bridge.js';
import { diffZones, snapshotZones } from '../playtest/diff.js';

const GIFT_RETURN_ZONES = new Set(['hand', 'graveyard', 'exile', 'library']);

// Map Archidekt zone names ↔ wire (Moxfield-canonical) zone names.
const ZONE_TO_WIRE = { commandZone: 'command' };
const ZONE_FROM_WIRE = { command: 'commandZone' };

// Map Archidekt card state fields ↔ wire field names.
const STATE_TO_WIRE = { faceDown: 'flipped', upsideDown: 'rotated' };
const STATE_FROM_WIRE = { flipped: 'faceDown', rotated: 'upsideDown' };

export class ArchidektAdapter {
  constructor() {
    this._store = null;
    this._fiberKey = null;
    this._actionType = null; // discovered at runtime
    this._unsubscribe = null;
    this._snapshot = null;
    this._lastLife = null;
    this._listeners = new Map();
    this._giftState = { enabled: false, localPlayerId: null, opponents: [] };
    this._actionTypePromise = null;
  }

  get capabilities() {
    return {
      gifts: true,
      remoteHighlight: false,   // not yet implemented
      battlefieldDivider: false, // not yet implemented
      saveStateDialog: false,    // Archidekt has no equivalent
      librarySync: true,
    };
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  static isPlaytestPath() {
    return /\/playtester-v2\/\d+/.test(window.location.pathname);
  }

  init(retries = 30, delay = 1000) {
    return new Promise((resolve) => {
      this._tryInit(retries, delay, resolve);
    });
  }

  _tryInit(retries, delay, resolve) {
    if (!ArchidektAdapter.isPlaytestPath()) {
      resolve();
      return;
    }
    const result = findArchidektStore();
    if (result) {
      this._store = result.store;
      this._fiberKey = result.fiberKey;
      console.log('[MoxMox MAIN] ArchidektAdapter: Redux store found');
      this._setupChangeDetection();
      // Start action type discovery in the background.
      this._actionTypePromise = discoverActionType(this._store).then(type => {
        this._actionType = type;
      }).catch(err => {
        console.warn('[MoxMox MAIN] Action type discovery failed:', err.message);
      });
      resolve();
      return;
    }

    console.log(`[MoxMox MAIN] Archidekt init retry ${30 - retries + 1}/30`);
    if (retries > 0) {
      setTimeout(() => this._tryInit(retries - 1, delay, resolve), delay);
    } else {
      console.warn('[MoxMox MAIN] Could not find Archidekt Redux store');
      resolve();
    }
  }

  isAvailable() {
    return this._store !== null;
  }

  destroy() {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    this._store = null;
    this._snapshot = null;
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

  _setupChangeDetection() {
    const state = this._getPlaytestState();
    this._snapshot = this._snapshotGameState(state);
    this._lastLife = state.lifeTotal;

    this._unsubscribe = this._store.subscribe(() => {
      this._onStateChange();
    });
  }

  _onStateChange() {
    const state = this._getPlaytestState();
    const newSnapshot = this._snapshotGameState(state);

    // Diff zones for card events.
    const events = diffZones(this._snapshot.zones, newSnapshot.zones);
    for (const event of events) {
      // Translate zone names and card fields to wire format.
      const translated = this._translateEventToWire(event);
      this._emit(translated.type, translated);
    }

    // Life change detection.
    if (state.lifeTotal !== this._lastLife) {
      this._emit('life:changed', { type: 'life:changed', to: state.lifeTotal });
      this._lastLife = state.lifeTotal;
    }

    this._snapshot = newSnapshot;
  }

  _snapshotGameState(state) {
    // Normalize Archidekt's zones into the {zoneName: [{...card}]} shape
    // that diffZones expects. Merge cardCoordinates into card objects
    // so position changes are detected by the diff.
    const zoneNames = [
      'battlefield', 'hand', 'library', 'graveyard', 'exile',
      'commandZone', 'sideboard', 'attractions', 'junkyard', 'planes',
    ];
    const zones = {};
    for (const zone of zoneNames) {
      const cards = state[zone] || [];
      const wireZone = ZONE_TO_WIRE[zone] || zone;
      zones[wireZone] = cards.map(c => {
        const card = { ...c, zoneId: c.id, zone: wireZone };
        // Merge coordinates for battlefield cards.
        if (zone === 'battlefield' && state.cardCoordinates?.[c.id]) {
          const [topPct, leftPct] = state.cardCoordinates[c.id];
          card.top = topPct;
          card.left = leftPct;
        }
        // Translate state fields to wire names.
        if ('faceDown' in card) {
          card.flipped = card.faceDown;
          delete card.faceDown;
        }
        if ('upsideDown' in card) {
          card.rotated = card.upsideDown;
          delete card.upsideDown;
        }
        return card;
      });
    }
    return { zones: snapshotZones(zones) };
  }

  _translateEventToWire(event) {
    const ev = { ...event };
    if (ev.fromZone) ev.fromZone = ZONE_TO_WIRE[ev.fromZone] || ev.fromZone;
    if (ev.toZone) ev.toZone = ZONE_TO_WIRE[ev.toZone] || ev.toZone;
    if (ev.zone) ev.zone = ZONE_TO_WIRE[ev.zone] || ev.zone;
    if (ev.card) {
      ev.card = { ...ev.card };
      // Use cardId from allCards lookup for scryfallId.
      const allCards = this._getPlaytestState().allCards;
      const cardData = allCards?.[ev.card.cardId];
      if (cardData?.uid) {
        ev.card.scryfall_id = cardData.uid;
      }
    }
    return ev;
  }

  // ── Command dispatch ────────────────────────────────────────────────

  async dispatch(action, params) {
    switch (action) {
      case 'reset-to-library': return await this._resetHandToLibrary();
      case 'shuffle-library': return this._shuffleLibrary();
      case 'draw': return this._drawCards(params.count || 1);
      case 'get-library': return this._getLibrary();
      case 'set-library-from-sync': return this._setLibraryFromSync(params.cards);
      case 'remove-top-from-library': return this._removeTopFromLibrary(params.count || 1);
      case 'sync-remove': return this._syncRemoveFromZone(params.zone, params.syncId);
      case 'sync-add': return this._syncAddToZone(params.zone, params.cardId, params.syncId);
      case 'sync-add-battlefield': return this._syncAddToBattlefield(params);
      case 'sync-move': return this._syncMoveBetweenZones(params.fromZone, params.toZone, params.syncId);
      case 'sync-update-state': return this._syncUpdateCardState(params.syncId, params.updates);
      case 'get-battlefield-size': return this._getBattlefieldSize();
      case 'get-life': return { life: this._getPlaytestState().lifeTotal };
      case 'get-hand-count': return { handCount: (this._getPlaytestState().hand || []).length };
      case 'get-hand-cards': return this._getZoneCards('hand');
      case 'get-zone-cards': return this._getZoneCards(params.zone);
      case 'gift-add-battlefield': return await this._addGiftedCardToBattlefield(params.gift, {
        preserveGift: params.preserveGift !== false,
      });
      case 'gift-add-zone': return await this._addGiftedCardToZone(params.zone, params.gift);
      case 'gift-remove': return this._removeGiftedCard(params.giftId);
      case 'apply-remote-highlight': return { ok: true }; // not yet supported
      case 'inject-divider': return { ok: true }; // not yet supported
      case 'discard-save-state': return { ok: true, noDialog: true };
      default: return { error: `Unknown action: ${action}` };
    }
  }

  // ── Gift state ──────────────────────────────────────────────────────

  setGiftState(state) {
    this._giftState = state;
  }

  findCardByZoneId(zoneId) {
    const state = this._getPlaytestState();
    const zoneNames = [
      'battlefield', 'hand', 'library', 'graveyard', 'exile',
      'commandZone', 'sideboard', 'attractions', 'junkyard', 'planes',
    ];
    for (const zone of zoneNames) {
      const cards = state[zone] || [];
      const card = cards.find(c => c.id === zoneId);
      if (card) return { ...card, zoneId: card.id, zone };
    }
    return null;
  }

  async giveCardToOpponent(targetId, zoneId) {
    if (!targetId || !zoneId || !this._giftState.enabled || !this._giftState.localPlayerId) return null;
    const found = this.findCardByZoneId(zoneId);
    if (!found) throw new Error('Card no longer exists');

    if (found.moxmoxGift) {
      if (found.moxmoxGift.ownerId !== targetId) {
        throw new Error('Gifted cards can only be returned to their owner');
      }
      const gift = {
        ...found.moxmoxGift,
        card: this._serializeGiftCard(found),
      };
      this._removeCardById(zoneId);
      return { type: 'gift-return-battlefield', gift };
    }

    const giftId = found.syncId || this._generateId();
    const card = { ...found, syncId: giftId };
    this._removeCardById(zoneId);
    return {
      type: 'gift-card',
      gift: {
        ownerId: this._giftState.localPlayerId,
        ownerUsername: this._giftState.localUsername || 'Opponent',
        giftId,
        fromZone: found.zone,
        card: this._serializeGiftCard(card),
      },
    };
  }

  // ── Private: State access ───────────────────────────────────────────

  _getPlaytestState() {
    return this._store.getState().playtesterV2;
  }

  _dispatchState(payload) {
    if (!this._actionType) {
      console.warn('[MoxMox MAIN] Cannot dispatch — action type not yet discovered');
      return;
    }
    this._store.dispatch({ type: this._actionType, payload });
  }

  async _ensureCanDispatch() {
    if (this._actionType) return;
    if (this._actionTypePromise) {
      await this._actionTypePromise;
    }
    if (!this._actionType) {
      throw new Error('Archidekt action type not yet discovered. Interact with the playtester first.');
    }
  }

  // ── Private: Reads ──────────────────────────────────────────────────

  _getZoneCards(zone) {
    // Translate wire zone name to local.
    const localZone = ZONE_FROM_WIRE[zone] || zone;
    if (!['hand', 'graveyard', 'exile'].includes(localZone) &&
        !['hand', 'graveyard', 'exile'].includes(zone)) {
      return { error: `Unsupported zone: ${zone}` };
    }
    const state = this._getPlaytestState();
    const cards = state[localZone] || [];
    const allCards = state.allCards || {};
    return {
      cards: cards.map(c => {
        const data = allCards[c.cardId] || {};
        return {
          name: data.name || c.cardId,
          set: data.setCode || '',
          cn: data.collectorNumber || '',
          layout: data.layout || 'normal',
          card_faces: data.front && data.back ? [data.front, data.back] : [],
        };
      }),
    };
  }

  _getLibrary() {
    const state = this._getPlaytestState();
    const lib = state.library || [];
    const allCards = state.allCards || {};
    return {
      cards: lib.map(c => ({
        cardId: c.cardId,
        syncId: c.syncId,
        scryfallId: allCards[c.cardId]?.uid,
      })),
    };
  }

  _getBattlefieldSize() {
    const playArea = document.getElementById('play-area-v2');
    if (!playArea) {
      return { width: 0, height: 0, usableWidth: 0, cardW: 100, cardH: 140 };
    }
    const rect = playArea.getBoundingClientRect();
    // Archidekt uses percentage-based positions, so "card size" is estimated
    // from the CSS card size setting.
    const cardW = 100; // reasonable default
    const cardH = 140;
    return {
      width: rect.width,
      height: rect.height,
      usableWidth: rect.width,
      cardW,
      cardH,
    };
  }

  // ── Private: Game operations ────────────────────────────────────────

  async _resetHandToLibrary() {
    await this._ensureCanDispatch();
    const state = this._getPlaytestState();
    const hand = state.hand || [];
    if (hand.length === 0) return { moved: 0 };
    const library = [...(state.library || []), ...hand];
    this._dispatchState({ hand: [], library });
    return { moved: hand.length };
  }

  _shuffleLibrary() {
    const state = this._getPlaytestState();
    const lib = [...(state.library || [])];
    // Fisher-Yates shuffle.
    for (let i = lib.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lib[i], lib[j]] = [lib[j], lib[i]];
    }
    // Assign syncIds.
    for (const card of lib) {
      if (!card.syncId) card.syncId = this._generateId();
    }
    this._dispatchState({ library: lib });
    return { ok: true };
  }

  _drawCards(count) {
    const state = this._getPlaytestState();
    const lib = [...(state.library || [])];
    const hand = [...(state.hand || [])];
    const drawn = [];
    const n = Math.min(count, lib.length);
    for (let i = 0; i < n; i++) {
      const card = lib.pop();
      hand.push(card);
      drawn.push({ cardId: card.cardId, syncId: card.syncId });
    }
    this._dispatchState({ library: lib, hand });
    return { drawn, count: n };
  }

  _setLibraryFromSync(syncCards) {
    const state = this._getPlaytestState();
    const current = [...(state.library || [])];
    const byCardId = new Map();
    for (const card of current) {
      if (!byCardId.has(card.cardId)) byCardId.set(card.cardId, []);
      byCardId.get(card.cardId).push(card);
    }
    const newLib = [];
    for (const { cardId, syncId } of syncCards) {
      const pool = byCardId.get(cardId);
      if (pool && pool.length > 0) {
        const card = pool.shift();
        card.syncId = syncId;
        newLib.push(card);
      }
    }
    this._dispatchState({ library: newLib });
    return { ok: true, count: newLib.length };
  }

  _removeTopFromLibrary(count) {
    const state = this._getPlaytestState();
    const lib = [...(state.library || [])];
    const removed = [];
    for (let i = 0; i < count && lib.length > 0; i++) {
      removed.push(lib.pop());
    }
    this._dispatchState({ library: lib });
    return { removedCount: removed.length };
  }

  // ── Private: Sync operations ────────────────────────────────────────

  _syncRemoveFromZone(wireZone, syncId) {
    const localZone = ZONE_FROM_WIRE[wireZone] || wireZone;
    const state = this._getPlaytestState();
    const cards = [...(state[localZone] || [])];
    const idx = cards.findIndex(c => c.syncId === syncId);
    if (idx === -1) return { error: `syncId ${syncId} not found in ${wireZone}` };
    cards.splice(idx, 1);
    this._dispatchState({ [localZone]: cards });
    return { ok: true };
  }

  _syncAddToZone(wireZone, cardId, syncId) {
    const localZone = ZONE_FROM_WIRE[wireZone] || wireZone;
    const state = this._getPlaytestState();
    const allCards = state.allCards || {};

    // Find the card template by cardId or scryfallId.
    let templateKey = Object.keys(allCards).find(k =>
      allCards[k].uid === cardId || k === cardId,
    );
    if (!templateKey) return { error: `Card ${cardId} not found in deck data` };

    const newCard = {
      id: this._generateId(),
      cardId: templateKey,
      syncId,
      tapped: false,
      faceDown: false,
      upsideDown: false,
      dimmed: false,
      token: false,
      counters: {},
      customPowerOffset: 0,
      customToughnessOffset: 0,
      commandTax: 0,
    };
    const cards = [...(state[localZone] || []), newCard];
    this._dispatchState({ [localZone]: cards });
    return { ok: true };
  }

  _syncAddToBattlefield({ cardId, syncId, top, left, rotated }) {
    const state = this._getPlaytestState();
    const allCards = state.allCards || {};
    let templateKey = Object.keys(allCards).find(k =>
      allCards[k].uid === cardId || k === cardId,
    );
    if (!templateKey) return { error: `Card ${cardId} not found in deck data` };

    const newId = this._generateId();
    const newCard = {
      id: newId,
      cardId: templateKey,
      syncId,
      tapped: false,
      faceDown: false,
      upsideDown: !!rotated,
      dimmed: false,
      token: false,
      counters: {},
      customPowerOffset: 0,
      customToughnessOffset: 0,
      commandTax: 0,
    };
    const bf = [...(state.battlefield || []), newCard];
    // Convert pixel coordinates to percentages for Archidekt.
    const coords = { ...(state.cardCoordinates || {}) };
    coords[newId] = [top ?? 50, left ?? 50];
    this._dispatchState({ battlefield: bf, cardCoordinates: coords });
    return { ok: true };
  }

  _syncMoveBetweenZones(wireFrom, wireTo, syncId) {
    const localFrom = ZONE_FROM_WIRE[wireFrom] || wireFrom;
    const localTo = ZONE_FROM_WIRE[wireTo] || wireTo;
    const state = this._getPlaytestState();
    const from = [...(state[localFrom] || [])];
    const idx = from.findIndex(c => c.syncId === syncId);
    if (idx === -1) return { error: `syncId ${syncId} not found in ${wireFrom}` };
    const card = { ...from[idx] };
    from.splice(idx, 1);
    // Clear battlefield state when leaving battlefield.
    if (localFrom === 'battlefield') {
      card.tapped = false;
      card.faceDown = false;
      card.upsideDown = false;
    }
    const to = [...(state[localTo] || []), card];
    const update = { [localFrom]: from, [localTo]: to };
    // Remove coordinates if leaving battlefield.
    if (localFrom === 'battlefield') {
      const coords = { ...(state.cardCoordinates || {}) };
      delete coords[card.id];
      update.cardCoordinates = coords;
    }
    this._dispatchState(update);
    return { ok: true };
  }

  _syncUpdateCardState(syncId, wireUpdates) {
    const state = this._getPlaytestState();
    const bf = [...(state.battlefield || [])];
    const idx = bf.findIndex(c => c.syncId === syncId);
    if (idx === -1) return { error: `syncId ${syncId} not found on battlefield` };

    const card = { ...bf[idx] };
    const update = {};

    // Translate wire field names to Archidekt field names.
    for (const [key, value] of Object.entries(wireUpdates)) {
      const localKey = STATE_FROM_WIRE[key] || key;
      if (localKey === 'top' || localKey === 'left') continue; // handled below
      if (localKey === 'doesntUntap') continue; // no Archidekt equivalent
      if (localKey === 'counters') {
        // Wire sends named counters {"+1/+1": 5}. Map to Archidekt format.
        if (typeof value === 'object' && value !== null) {
          const counters = {};
          for (const [name, count] of Object.entries(value)) {
            counters[name] = { count, primary: name === '+1/+1' };
          }
          card.counters = counters;
        } else if (typeof value === 'number') {
          // Legacy single-integer format.
          card.counters = value > 0 ? { '+1/+1': { count: value, primary: true } } : {};
        }
        continue;
      }
      if (localKey === 'adjustedPower') {
        // Wire sends absolute value. Convert to offset.
        const allCards = state.allCards || {};
        const cardData = allCards[card.cardId];
        const basePower = parseInt(cardData?.power, 10) || 0;
        card.customPowerOffset = value - basePower;
        continue;
      }
      if (localKey === 'adjustedToughness') {
        const allCards = state.allCards || {};
        const cardData = allCards[card.cardId];
        const baseToughness = parseInt(cardData?.toughness, 10) || 0;
        card.customToughnessOffset = value - baseToughness;
        continue;
      }
      card[localKey] = value;
    }
    bf[idx] = card;
    update.battlefield = bf;

    // Handle coordinate updates.
    if ('top' in wireUpdates || 'left' in wireUpdates) {
      const coords = { ...(state.cardCoordinates || {}) };
      const current = coords[card.id] || [50, 50];
      coords[card.id] = [
        'top' in wireUpdates ? wireUpdates.top : current[0],
        'left' in wireUpdates ? wireUpdates.left : current[1],
      ];
      update.cardCoordinates = coords;
    }

    this._dispatchState(update);
    return { ok: true };
  }

  // ── Private: Gift operations ────────────────────────────────────────

  _serializeGiftCard(card) {
    const state = this._getPlaytestState();
    const allCards = state.allCards || {};
    const cardData = allCards[card.cardId] || {};
    return {
      scryfallId: cardData.uid || '',
      name: cardData.name || card.cardId,
      set: cardData.setCode || '',
      cn: cardData.collectorNumber || '',
    };
  }

  async _addGiftedCardToBattlefield(gift, { preserveGift = true } = {}) {
    await this._ensureCanDispatch();
    const state = this._getPlaytestState();
    const newId = this._generateId();

    // Try to find the card in our deck data by scryfallId.
    const allCards = state.allCards || {};
    let templateKey = null;
    if (gift.card?.scryfallId) {
      templateKey = Object.keys(allCards).find(k => allCards[k].uid === gift.card.scryfallId);
    }

    const newCard = {
      id: newId,
      cardId: templateKey || `gift_${gift.giftId}`,
      syncId: gift.giftId,
      tapped: false,
      faceDown: false,
      upsideDown: false,
      dimmed: false,
      token: false,
      counters: {},
      customPowerOffset: 0,
      customToughnessOffset: 0,
      commandTax: 0,
    };
    if (preserveGift) {
      newCard.moxmoxGift = {
        ownerId: gift.ownerId,
        ownerUsername: gift.ownerUsername || 'Opponent',
        giftId: gift.giftId,
      };
    }

    // If the card isn't in our deck, inject a synthetic entry into allCards.
    if (!templateKey && gift.card) {
      const syntheticKey = `gift_${gift.giftId}`;
      const newAllCards = { ...allCards };
      newAllCards[syntheticKey] = {
        name: gift.card.name || 'Unknown Card',
        uid: gift.card.scryfallId || '',
        setCode: gift.card.set || '',
        collectorNumber: gift.card.cn || '',
        layout: 'normal',
        power: '', toughness: '', loyalty: '',
      };
      this._dispatchState({ allCards: newAllCards });
    }

    const bf = [...(state.battlefield || []), newCard];
    const coords = { ...(state.cardCoordinates || {}) };
    coords[newId] = [50, 50]; // center of battlefield
    this._dispatchState({ battlefield: bf, cardCoordinates: coords });
    return { ok: true };
  }

  async _addGiftedCardToZone(wireZone, gift) {
    if (!GIFT_RETURN_ZONES.has(wireZone)) {
      return { error: `Unsupported gift return zone: ${wireZone}` };
    }
    await this._ensureCanDispatch();
    const localZone = ZONE_FROM_WIRE[wireZone] || wireZone;
    const state = this._getPlaytestState();
    const allCards = state.allCards || {};
    let templateKey = null;
    if (gift.card?.scryfallId) {
      templateKey = Object.keys(allCards).find(k => allCards[k].uid === gift.card.scryfallId);
    }

    const newCard = {
      id: this._generateId(),
      cardId: templateKey || `gift_${gift.giftId}`,
      syncId: gift.giftId,
      tapped: false,
      faceDown: false,
      upsideDown: false,
      dimmed: false,
      token: false,
      counters: {},
      customPowerOffset: 0,
      customToughnessOffset: 0,
      commandTax: 0,
    };

    const cards = [...(state[localZone] || []), newCard];
    this._dispatchState({ [localZone]: cards });
    return { ok: true };
  }

  _removeGiftedCard(giftId) {
    if (!giftId) return { error: 'Missing giftId' };
    const state = this._getPlaytestState();
    const zoneNames = [
      'battlefield', 'hand', 'library', 'graveyard', 'exile',
      'commandZone', 'sideboard', 'attractions', 'junkyard', 'planes',
    ];
    const update = {};
    let removed = 0;
    for (const zone of zoneNames) {
      const cards = state[zone] || [];
      const filtered = cards.filter(c => c.moxmoxGift?.giftId !== giftId);
      if (filtered.length !== cards.length) {
        update[zone] = filtered;
        removed += cards.length - filtered.length;
      }
    }
    if (removed === 0) return { error: `Gifted card ${giftId} not found` };
    this._dispatchState(update);
    return { ok: true, removed };
  }

  _removeCardById(cardId) {
    const state = this._getPlaytestState();
    const zoneNames = [
      'battlefield', 'hand', 'library', 'graveyard', 'exile',
      'commandZone', 'sideboard', 'attractions', 'junkyard', 'planes',
    ];
    const update = {};
    for (const zone of zoneNames) {
      const cards = state[zone] || [];
      const filtered = cards.filter(c => c.id !== cardId);
      if (filtered.length !== cards.length) {
        update[zone] = filtered;
      }
    }
    this._dispatchState(update);
  }

  // ── Private: Helpers ────────────────────────────────────────────────

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
  }
}
