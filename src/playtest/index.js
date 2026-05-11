// PlaytestController — programmatic interface to Moxfield's playtest engine.
//
// Usage:
//   import { PlaytestController } from './playtest/index.js';
//   const pt = new PlaytestController();
//   await pt.draw(2);
//   await pt.moveCard(zoneId, 'battlefield');
//   pt.on('card:zone-changed', (e) => console.log(e));

import { findPlaytestInstance } from './bridge.js';
import { diffZones, snapshotZones } from './diff.js';

/** All recognized zone names in Moxfield's playtest engine. */
export const ZONES = [
  'hand', 'library', 'battlefield', 'graveyard', 'exile',
  'junkyard', 'scrapyard', 'sideboard', 'command',
  'signatureSpells', 'attractions', 'contraptions',
  'schemes', 'stickers', 'planes',
];

/** Battlefield card properties that may be safely modified. */
const BATTLEFIELD_MUTABLE_PROPS = new Set([
  'tapped', 'flipped', 'rotated', 'doesntUntap',
  'top', 'left', 'counters',
  'adjustedPower', 'adjustedToughness', 'adjustedLoyalty',
]);

export class PlaytestController {
  /**
   * @param {object|null} instance — React component instance. Pass null
   *   (default) for auto-discovery via the DOM, or pass a mock for testing.
   */
  constructor(instance = null) {
    this._instance = instance;
    this._queue = Promise.resolve();
    this._listeners = new Map();
    this._snapshot = null;
    this._lastLife = null;
    this._lastTurn = null;
    this._hooked = false;
  }

  // ── Event System ──────────────────────────────────────────────────

  /**
   * Subscribe to a playtest event. Returns `this` for chaining.
   *
   * Event types:
   *   card:zone-changed  — { card, fromZone, toZone }
   *   card:added         — { card, toZone }
   *   card:removed       — { card, fromZone }
   *   card:state-changed — { card, changes }
   *   zone:reordered     — { zone, cardIds }
   *   life:changed       — { from, to }
   *   turn:changed       — { from, to }
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return this;
  }

  /** Unsubscribe from a playtest event. */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) set.delete(callback);
    return this;
  }

  _emit(event, data) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try {
        cb(data);
      } catch (e) {
        console.error(`PlaytestController event error (${event}):`, e);
      }
    }
  }

  // ── Instance Access ───────────────────────────────────────────────

  /** @returns {boolean} Whether the playtest component is reachable. */
  isAvailable() {
    try {
      this._getInstance();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns the React component instance, re-discovering if stale.
   * Installs event hooks on first successful access.
   * @throws {Error} if not on a playtest page.
   */
  _getInstance() {
    if (!this._instance?.state?.zones) {
      this._instance = findPlaytestInstance();
    }
    if (!this._instance) {
      throw new Error(
        'Not on a Moxfield playtest page, or the playtest has not loaded yet',
      );
    }
    if (!this._hooked) {
      this._installHooks();
    }
    return this._instance;
  }

  /**
   * Monkey-patches handleSaveData on the live instance so that every
   * mutation (whether triggered by our code or by the user clicking in
   * the Moxfield UI) produces diff events.
   */
  _installHooks() {
    const instance = this._instance;
    this._snapshot = snapshotZones(instance.state.zones);
    this._lastLife = instance.state.life;
    this._lastTurn = instance.state.turn;

    const self = this;
    const originalSave = instance.handleSaveData.bind(instance);

    instance.handleSaveData = function () {
      const newZones = instance.state.zones;
      const events = diffZones(self._snapshot, newZones);

      for (const event of events) {
        self._emit(event.type, event);
      }

      if (instance.state.life !== self._lastLife) {
        self._emit('life:changed', {
          type: 'life:changed',
          from: self._lastLife,
          to: instance.state.life,
        });
        self._lastLife = instance.state.life;
      }
      if (instance.state.turn !== self._lastTurn) {
        self._emit('turn:changed', {
          type: 'turn:changed',
          from: self._lastTurn,
          to: instance.state.turn,
        });
        self._lastTurn = instance.state.turn;
      }

      self._snapshot = snapshotZones(newZones);
      return originalSave();
    };

    this._hooked = true;
  }

  // ── Mutation Queue ────────────────────────────────────────────────

  /** Serialize a mutation so concurrent calls don't clobber each other. */
  _enqueue(fn) {
    this._queue = this._queue.then(fn);
    return this._queue;
  }

  /**
   * Apply a zone update via setState and persist. `buildUpdate` receives
   * the current zones object and must return a partial zones object whose
   * keys will be merged over the current zones.
   * @returns {Promise<void>}
   */
  _updateZones(buildUpdate) {
    const instance = this._getInstance();
    return new Promise((resolve, reject) => {
      try {
        const currentZones = instance.state.zones;
        const zoneUpdates = buildUpdate(currentZones);
        instance.setState(
          { zones: { ...currentZones, ...zoneUpdates } },
          () => {
            instance.handleSaveData();
            resolve();
          },
        );
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── Zone Reading ──────────────────────────────────────────────────

  /** Get a shallow-cloned copy of all cards in a zone. */
  getZone(zoneName) {
    this._assertZone(zoneName);
    return this._getInstance().state.zones[zoneName].map(c => ({ ...c }));
  }

  getZoneCount(zoneName) {
    this._assertZone(zoneName);
    return this._getInstance().state.zones[zoneName].length;
  }

  /** Get a snapshot of every zone. */
  getAllZones() {
    return snapshotZones(this._getInstance().state.zones);
  }

  // ── Library ───────────────────────────────────────────────────────
  // In the internal array, the LAST element is the top card (drawn first).

  getLibrary() {
    return this.getZone('library');
  }

  getLibraryCount() {
    return this.getZoneCount('library');
  }

  /** Return the top N cards of the library (index 0 = top). */
  getTopOfLibrary(n = 1) {
    const lib = this.getZone('library');
    return lib.slice(Math.max(0, lib.length - n)).reverse();
  }

  // ── Graveyard ─────────────────────────────────────────────────────

  getGraveyard() {
    return this.getZone('graveyard');
  }

  getGraveyardCount() {
    return this.getZoneCount('graveyard');
  }

  // ── Zone Reordering ───────────────────────────────────────────────

  /** Move a card within the same zone from one index to another. */
  reorderZone(zoneName, fromIndex, toIndex) {
    this._assertZone(zoneName);
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const cards = [...zones[zoneName]];
        if (fromIndex < 0 || fromIndex >= cards.length) {
          throw new RangeError(
            `fromIndex ${fromIndex} out of bounds (0–${cards.length - 1})`,
          );
        }
        if (toIndex < 0 || toIndex >= cards.length) {
          throw new RangeError(
            `toIndex ${toIndex} out of bounds (0–${cards.length - 1})`,
          );
        }
        const [card] = cards.splice(fromIndex, 1);
        cards.splice(toIndex, 0, card);
        return { [zoneName]: cards };
      }),
    );
  }

  /** Shuffle a zone using Moxfield's built-in Fisher-Yates shuffle. */
  shuffleZone(zoneName = 'library') {
    this._assertZone(zoneName);
    this._getInstance().handleShuffle(zoneName);
  }

  // ── Card Movement ─────────────────────────────────────────────────

  /** Move a single card (by zoneId) to a target zone. */
  moveCard(zoneId, toZone) {
    return this.moveCards([zoneId], toZone);
  }

  /** Move one or more cards (by zoneId) to a target zone. */
  moveCards(zoneIds, toZone) {
    this._assertZone(toZone);
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const targetIds = new Set(zoneIds);

        // Pre-validate: every requested zoneId must exist somewhere.
        const allIds = new Set();
        for (const cards of Object.values(zones)) {
          for (const c of cards) allIds.add(c.zoneId);
        }
        for (const id of targetIds) {
          if (!allIds.has(id)) {
            throw new Error(`Card with zoneId "${id}" not found in any zone`);
          }
        }

        const moved = [];
        const newZones = {};
        for (const [name, cards] of Object.entries(zones)) {
          const kept = [];
          for (const card of cards) {
            if (targetIds.has(card.zoneId)) {
              moved.push(this._normalizeCardForZone(card, toZone));
            } else {
              kept.push(card);
            }
          }
          newZones[name] = kept;
        }

        newZones[toZone] = [...newZones[toZone], ...moved];
        return newZones;
      }),
    );
  }

  /** Remove a card from its current zone and place it on top of the library. */
  moveCardToTopOfLibrary(zoneId) {
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const { card, newZones } = this._extractCard(zones, zoneId);
        const normalized = this._normalizeCardForZone(card, 'library');
        newZones.library = [...newZones.library, normalized]; // push → top
        return newZones;
      }),
    );
  }

  /** Remove a card from its current zone and place it on the bottom of the library. */
  moveCardToBottomOfLibrary(zoneId) {
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const { card, newZones } = this._extractCard(zones, zoneId);
        const normalized = this._normalizeCardForZone(card, 'library');
        newZones.library = [normalized, ...newZones.library]; // unshift → bottom
        return newZones;
      }),
    );
  }

  // ── Card Removal ──────────────────────────────────────────────────

  /** Permanently remove a single card from all zones. */
  removeCard(zoneId) {
    return this.removeCards([zoneId]);
  }

  /** Permanently remove one or more cards from all zones. */
  removeCards(zoneIds) {
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const targetIds = new Set(zoneIds);

        // Pre-validate.
        const allIds = new Set();
        for (const cards of Object.values(zones)) {
          for (const c of cards) allIds.add(c.zoneId);
        }
        for (const id of targetIds) {
          if (!allIds.has(id)) {
            throw new Error(`Card with zoneId "${id}" not found in any zone`);
          }
        }

        const newZones = {};
        for (const [name, cards] of Object.entries(zones)) {
          newZones[name] = cards.filter(c => !targetIds.has(c.zoneId));
        }
        return newZones;
      }),
    );
  }

  // ── Battlefield ───────────────────────────────────────────────────

  getBattlefield() {
    return this.getZone('battlefield');
  }

  tapCard(zoneId) {
    return this._setBattlefieldProp(zoneId, 'tapped', true);
  }

  untapCard(zoneId) {
    return this._setBattlefieldProp(zoneId, 'tapped', false);
  }

  toggleTap(zoneId) {
    return this._enqueue(() => {
      const card = this._findBattlefieldCard(zoneId);
      return this._updateBattlefieldCardImpl(zoneId, {
        tapped: !card.tapped,
      });
    });
  }

  /** Toggle the face-down state of a battlefield card. */
  flipCard(zoneId) {
    return this._enqueue(() => {
      const card = this._findBattlefieldCard(zoneId);
      return this._updateBattlefieldCardImpl(zoneId, {
        flipped: !card.flipped,
      });
    });
  }

  setFaceDown(zoneId) {
    return this._setBattlefieldProp(zoneId, 'flipped', true);
  }

  setFaceUp(zoneId) {
    return this._setBattlefieldProp(zoneId, 'flipped', false);
  }

  /** Toggle the 180° rotation on a battlefield card. */
  rotateCard(zoneId) {
    return this._enqueue(() => {
      const card = this._findBattlefieldCard(zoneId);
      return this._updateBattlefieldCardImpl(zoneId, {
        rotated: !card.rotated,
      });
    });
  }

  setDoesntUntap(zoneId, value = true) {
    return this._setBattlefieldProp(zoneId, 'doesntUntap', value);
  }

  /** Move a battlefield card to an absolute pixel position. */
  moveCardPosition(zoneId, top, left) {
    return this.updateBattlefieldCard(zoneId, { top, left });
  }

  /**
   * Set one or more mutable properties on a battlefield card.
   * Only whitelisted properties are accepted; unknown keys are ignored.
   */
  updateBattlefieldCard(zoneId, updates) {
    const sanitized = {};
    for (const key of Object.keys(updates)) {
      if (BATTLEFIELD_MUTABLE_PROPS.has(key)) {
        sanitized[key] = updates[key];
      }
    }
    if (Object.keys(sanitized).length === 0) {
      throw new Error(
        `No valid battlefield properties in updates. ` +
          `Allowed: ${[...BATTLEFIELD_MUTABLE_PROPS].join(', ')}`,
      );
    }
    return this._enqueue(() =>
      this._updateBattlefieldCardImpl(zoneId, sanitized),
    );
  }

  /** Untap every card on the battlefield. */
  untapAll() {
    this._getInstance().handleUntapAll();
  }

  // ── Game Actions ──────────────────────────────────────────────────

  /**
   * Draw cards from the top of the library into the hand.
   * Implemented as a single atomic setState for consistency.
   */
  draw(count = 1) {
    return this._enqueue(() =>
      this._updateZones((zones) => {
        const lib = [...zones.library];
        const hand = [...zones.hand];
        const drawCount = Math.min(count, lib.length);

        for (let i = 0; i < drawCount; i++) {
          const card = lib.pop(); // last element = top of library
          hand.push(this._normalizeCardForZone(card, 'hand'));
        }

        return { library: lib, hand };
      }),
    );
  }

  /** Advance to the next turn (delegates to Moxfield's handler). */
  nextTurn() {
    this._getInstance().handleNextTurn();
  }

  getLife() {
    return this._getInstance().state.life;
  }

  getTurn() {
    return this._getInstance().state.turn;
  }

  // ── Search ────────────────────────────────────────────────────────

  /** Find all cards with a given name across every zone. */
  findCardsByName(name) {
    const zones = this._getInstance().state.zones;
    const results = [];
    for (const [zoneName, cards] of Object.entries(zones)) {
      for (const card of cards) {
        if (card.name === name) {
          results.push({ ...card, zone: zoneName });
        }
      }
    }
    return results;
  }

  /** Find a single card by its unique zoneId. Returns null if not found. */
  findCardByZoneId(zoneId) {
    const zones = this._getInstance().state.zones;
    for (const [zoneName, cards] of Object.entries(zones)) {
      const card = cards.find(c => c.zoneId === zoneId);
      if (card) return { ...card, zone: zoneName };
    }
    return null;
  }

  // ── Private Helpers ───────────────────────────────────────────────

  _assertZone(zoneName) {
    if (!ZONES.includes(zoneName)) {
      throw new Error(
        `Invalid zone: "${zoneName}". Valid zones: ${ZONES.join(', ')}`,
      );
    }
  }

  /**
   * Prepare a card object for a target zone: update the `zone` field
   * and clear battlefield-specific properties when leaving the battlefield.
   */
  _normalizeCardForZone(card, toZone) {
    const normalized = { ...card, zone: toZone };
    if (toZone !== 'battlefield') {
      normalized.top = undefined;
      normalized.left = undefined;
      normalized.tapped = false;
      normalized.flipped = false;
      normalized.rotated = false;
      normalized.doesntUntap = false;
    }
    return normalized;
  }

  /**
   * Remove a card from whichever zone it lives in.
   * Returns { card, newZones } where newZones has the card filtered out.
   */
  _extractCard(zones, zoneId) {
    let card = null;
    const newZones = {};
    for (const [name, cards] of Object.entries(zones)) {
      newZones[name] = cards.filter(c => {
        if (c.zoneId === zoneId) {
          card = c;
          return false;
        }
        return true;
      });
    }
    if (!card) {
      throw new Error(`Card with zoneId "${zoneId}" not found in any zone`);
    }
    return { card, newZones };
  }

  _findBattlefieldCard(zoneId) {
    const bf = this._getInstance().state.zones.battlefield;
    const card = bf.find(c => c.zoneId === zoneId);
    if (!card) {
      throw new Error(
        `Card with zoneId "${zoneId}" not found on battlefield`,
      );
    }
    return card;
  }

  _setBattlefieldProp(zoneId, prop, value) {
    return this._enqueue(() =>
      this._updateBattlefieldCardImpl(zoneId, { [prop]: value }),
    );
  }

  _updateBattlefieldCardImpl(zoneId, updates) {
    return this._updateZones((zones) => {
      if (!zones.battlefield.some(c => c.zoneId === zoneId)) {
        throw new Error(
          `Card with zoneId "${zoneId}" not found on battlefield`,
        );
      }
      return {
        battlefield: zones.battlefield.map(c =>
          c.zoneId === zoneId ? { ...c, ...updates } : c,
        ),
      };
    });
  }
}
