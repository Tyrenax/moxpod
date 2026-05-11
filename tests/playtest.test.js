import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { diffZones, snapshotZones } from '../src/playtest/diff.js';
import { PlaytestController, ZONES } from '../src/playtest/index.js';

// ── Test Helpers ────────────────────────────────────────────────────────

function makeCard(name, zoneId, extras = {}) {
  return {
    id: `card-${zoneId}`,
    uniqueCardId: `uniq-${zoneId}`,
    scryfall_id: `scry-${zoneId}`,
    name,
    zoneId,
    zone: extras.zone || 'library',
    tapped: false,
    flipped: false,
    rotated: false,
    doesntUntap: false,
    counters: 0,
    adjustedPower: 0,
    adjustedToughness: 0,
    adjustedLoyalty: 0,
    top: undefined,
    left: undefined,
    ...extras,
  };
}

function makeZones(overrides = {}) {
  const zones = {};
  for (const z of ZONES) {
    zones[z] = [];
  }
  return { ...zones, ...overrides };
}

/**
 * Create a mock instance that mimics Moxfield's playtest React component.
 * setState is synchronous for testing simplicity (calls callback immediately).
 */
function createMockInstance(zones = {}, extras = {}) {
  const instance = {
    state: {
      zones: makeZones(zones),
      life: extras.life ?? 20,
      turn: extras.turn ?? 1,
    },
    saveDataCalls: 0,
    shuffleCalls: [],
    setState(update, callback) {
      if (typeof update === 'function') {
        Object.assign(this.state, update(this.state));
      } else {
        // Shallow merge like React does.
        for (const [key, val] of Object.entries(update)) {
          if (key === 'zones') {
            this.state.zones = val;
          } else {
            this.state[key] = val;
          }
        }
      }
      if (callback) callback.call(this);
    },
    handleSaveData() {
      this.saveDataCalls++;
    },
    handleShuffle(zone = 'library') {
      this.shuffleCalls.push(zone);
      const arr = [...this.state.zones[zone]].reverse(); // deterministic for tests
      this.state.zones = { ...this.state.zones, [zone]: arr };
      this.handleSaveData();
    },
    handleDraw() {},
    handleNextTurn() {
      this.state.turn++;
    },
    handleUntapAll() {
      this.state.zones = {
        ...this.state.zones,
        battlefield: this.state.zones.battlefield.map(c => ({
          ...c,
          tapped: false,
        })),
      };
      this.handleSaveData();
    },
  };
  return instance;
}

// ── diffZones ───────────────────────────────────────────────────────────

describe('diffZones', () => {
  it('detects a card moving between zones', () => {
    const card = makeCard('Island', '1', { zone: 'hand' });
    const old = makeZones({ hand: [card], library: [] });
    const now = makeZones({
      hand: [],
      library: [{ ...card, zone: 'library' }],
    });

    const events = diffZones(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'card:zone-changed');
    assert.equal(events[0].fromZone, 'hand');
    assert.equal(events[0].toZone, 'library');
    assert.equal(events[0].card.name, 'Island');
  });

  it('detects a card being added', () => {
    const card = makeCard('Soldier Token', 'tok-1');
    const old = makeZones({ battlefield: [] });
    const now = makeZones({ battlefield: [card] });

    const events = diffZones(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'card:added');
    assert.equal(events[0].toZone, 'battlefield');
  });

  it('detects a card being removed', () => {
    const card = makeCard('Island', '1');
    const old = makeZones({ hand: [card] });
    const now = makeZones({ hand: [] });

    const events = diffZones(old, now);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'card:removed');
    assert.equal(events[0].fromZone, 'hand');
  });

  it('detects battlefield state changes', () => {
    const old = makeCard('Island', '1', {
      zone: 'battlefield',
      tapped: false,
      top: 100,
      left: 200,
    });
    const now = { ...old, tapped: true, top: 150 };

    const events = diffZones(
      makeZones({ battlefield: [old] }),
      makeZones({ battlefield: [now] }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'card:state-changed');
    assert.deepEqual(events[0].changes.tapped, { from: false, to: true });
    assert.deepEqual(events[0].changes.top, { from: 100, to: 150 });
    assert.equal(events[0].changes.left, undefined); // unchanged
  });

  it('detects zone reordering', () => {
    const a = makeCard('A', '1');
    const b = makeCard('B', '2');
    const c = makeCard('C', '3');
    const old = makeZones({ library: [a, b, c] });
    const now = makeZones({ library: [c, a, b] });

    const events = diffZones(old, now);
    const reorder = events.find(e => e.type === 'zone:reordered');
    assert.ok(reorder);
    assert.equal(reorder.zone, 'library');
    assert.deepEqual(reorder.cardIds, ['3', '1', '2']);
  });

  it('returns empty array when nothing changed', () => {
    const card = makeCard('Island', '1');
    const zones = makeZones({ hand: [card] });
    assert.deepEqual(diffZones(zones, zones), []);
  });

  it('handles multiple simultaneous changes', () => {
    const a = makeCard('A', '1', { zone: 'hand' });
    const b = makeCard('B', '2', { zone: 'library' });
    const c = makeCard('C', '3', { zone: 'graveyard' });

    const old = makeZones({ hand: [a], library: [b], graveyard: [c] });
    const now = makeZones({
      hand: [],
      library: [{ ...a, zone: 'library' }],
      graveyard: [],
    });

    const events = diffZones(old, now);
    assert.equal(events.length, 3); // move + remove + (b removed)
    assert.ok(events.some(e => e.type === 'card:zone-changed' && e.card.name === 'A'));
    assert.ok(events.some(e => e.type === 'card:removed' && e.card.name === 'B'));
    assert.ok(events.some(e => e.type === 'card:removed' && e.card.name === 'C'));
  });
});

describe('snapshotZones', () => {
  it('creates independent shallow clones', () => {
    const card = makeCard('Island', '1');
    const zones = { hand: [card] };
    const snap = snapshotZones(zones);

    snap.hand[0].name = 'mutated';
    assert.equal(card.name, 'Island'); // original untouched
    assert.notEqual(zones.hand, snap.hand); // different array
  });
});

// ── PlaytestController ──────────────────────────────────────────────────

describe('PlaytestController', () => {
  let instance;
  let pt;

  beforeEach(() => {
    instance = createMockInstance({
      library: [
        makeCard('A', '1', { zone: 'library' }),
        makeCard('B', '2', { zone: 'library' }),
        makeCard('C', '3', { zone: 'library' }),
        makeCard('D', '4', { zone: 'library' }),
        makeCard('E', '5', { zone: 'library' }),
      ],
      hand: [
        makeCard('F', '6', { zone: 'hand' }),
        makeCard('G', '7', { zone: 'hand' }),
      ],
      battlefield: [
        makeCard('H', '8', {
          zone: 'battlefield',
          tapped: false,
          flipped: false,
          rotated: false,
          top: 100,
          left: 200,
        }),
      ],
      graveyard: [makeCard('I', '9', { zone: 'graveyard' })],
    });
    pt = new PlaytestController(instance);
  });

  // ── Zone Reading ──────────────────────────────────────────────────

  describe('zone reading', () => {
    it('getZone returns cloned cards', () => {
      const hand = pt.getZone('hand');
      assert.equal(hand.length, 2);
      hand[0].name = 'mutated';
      assert.equal(instance.state.zones.hand[0].name, 'F'); // original safe
    });

    it('getZoneCount returns correct count', () => {
      assert.equal(pt.getZoneCount('library'), 5);
      assert.equal(pt.getZoneCount('hand'), 2);
      assert.equal(pt.getZoneCount('battlefield'), 1);
      assert.equal(pt.getZoneCount('graveyard'), 1);
    });

    it('getAllZones returns snapshot of all zones', () => {
      const all = pt.getAllZones();
      assert.equal(all.hand.length, 2);
      assert.equal(all.library.length, 5);
    });

    it('throws on invalid zone name', () => {
      assert.throws(() => pt.getZone('fake'), /Invalid zone/);
    });
  });

  // ── Library ───────────────────────────────────────────────────────

  describe('library', () => {
    it('getTopOfLibrary returns cards from the top', () => {
      const top3 = pt.getTopOfLibrary(3);
      assert.equal(top3.length, 3);
      // Last element = top card, reversed for display order.
      assert.equal(top3[0].name, 'E');
      assert.equal(top3[1].name, 'D');
      assert.equal(top3[2].name, 'C');
    });

    it('getTopOfLibrary(1) returns the top card', () => {
      const top = pt.getTopOfLibrary(1);
      assert.equal(top.length, 1);
      assert.equal(top[0].name, 'E');
    });

    it('shuffleZone delegates to handleShuffle', () => {
      pt.shuffleZone('library');
      assert.deepEqual(instance.shuffleCalls, ['library']);
    });
  });

  // ── Zone Reordering ───────────────────────────────────────────────

  describe('reorderZone', () => {
    it('moves a card within a zone', async () => {
      await pt.reorderZone('library', 0, 4);
      const names = instance.state.zones.library.map(c => c.name);
      assert.deepEqual(names, ['B', 'C', 'D', 'E', 'A']);
    });

    it('throws on out-of-bounds index', async () => {
      await assert.rejects(
        () => pt.reorderZone('library', 0, 99),
        /out of bounds/,
      );
    });

    it('persists after reorder', async () => {
      const before = instance.saveDataCalls;
      await pt.reorderZone('library', 0, 1);
      assert.equal(instance.saveDataCalls, before + 1);
    });
  });

  // ── Card Movement ─────────────────────────────────────────────────

  describe('moveCard / moveCards', () => {
    it('moves a card from hand to graveyard', async () => {
      await pt.moveCard('6', 'graveyard');
      assert.equal(instance.state.zones.hand.length, 1);
      assert.equal(instance.state.zones.graveyard.length, 2);
      assert.equal(instance.state.zones.graveyard[1].name, 'F');
      assert.equal(instance.state.zones.graveyard[1].zone, 'graveyard');
    });

    it('moves multiple cards at once', async () => {
      await pt.moveCards(['6', '7'], 'battlefield');
      assert.equal(instance.state.zones.hand.length, 0);
      assert.equal(instance.state.zones.battlefield.length, 3);
    });

    it('normalizes battlefield props when leaving battlefield', async () => {
      // Card '8' is on battlefield with top/left set.
      await pt.moveCard('8', 'hand');
      const card = instance.state.zones.hand.find(c => c.zoneId === '8');
      assert.equal(card.top, undefined);
      assert.equal(card.left, undefined);
      assert.equal(card.tapped, false);
    });

    it('throws for unknown zoneId', async () => {
      await assert.rejects(
        () => pt.moveCard('nonexistent', 'hand'),
        /not found/,
      );
    });

    it('throws for invalid target zone', () => {
      assert.throws(() => pt.moveCard('6', 'fake'), /Invalid zone/);
    });
  });

  describe('moveCardToTopOfLibrary', () => {
    it('places card at end of library array (= top)', async () => {
      await pt.moveCardToTopOfLibrary('6');
      const lib = instance.state.zones.library;
      assert.equal(lib[lib.length - 1].name, 'F');
      assert.equal(lib[lib.length - 1].zone, 'library');
      assert.equal(instance.state.zones.hand.length, 1);
    });
  });

  describe('moveCardToBottomOfLibrary', () => {
    it('places card at start of library array (= bottom)', async () => {
      await pt.moveCardToBottomOfLibrary('7');
      const lib = instance.state.zones.library;
      assert.equal(lib[0].name, 'G');
      assert.equal(lib[0].zone, 'library');
    });
  });

  // ── Card Removal ──────────────────────────────────────────────────

  describe('removeCard / removeCards', () => {
    it('permanently removes a card', async () => {
      await pt.removeCard('6');
      assert.equal(instance.state.zones.hand.length, 1);
      // Not moved anywhere — just gone.
      const totalCards = Object.values(instance.state.zones)
        .reduce((sum, z) => sum + z.length, 0);
      assert.equal(totalCards, 8); // was 9
    });

    it('removes multiple cards', async () => {
      await pt.removeCards(['6', '7']);
      assert.equal(instance.state.zones.hand.length, 0);
    });

    it('throws for unknown zoneId', async () => {
      await assert.rejects(
        () => pt.removeCard('nonexistent'),
        /not found/,
      );
    });
  });

  // ── Battlefield ───────────────────────────────────────────────────

  describe('battlefield operations', () => {
    it('tapCard sets tapped to true', async () => {
      await pt.tapCard('8');
      assert.equal(instance.state.zones.battlefield[0].tapped, true);
    });

    it('untapCard sets tapped to false', async () => {
      await pt.tapCard('8');
      await pt.untapCard('8');
      assert.equal(instance.state.zones.battlefield[0].tapped, false);
    });

    it('toggleTap flips the tapped state', async () => {
      await pt.toggleTap('8');
      assert.equal(instance.state.zones.battlefield[0].tapped, true);
      await pt.toggleTap('8');
      assert.equal(instance.state.zones.battlefield[0].tapped, false);
    });

    it('flipCard toggles flipped', async () => {
      await pt.flipCard('8');
      assert.equal(instance.state.zones.battlefield[0].flipped, true);
      await pt.flipCard('8');
      assert.equal(instance.state.zones.battlefield[0].flipped, false);
    });

    it('setFaceDown/setFaceUp set flipped directly', async () => {
      await pt.setFaceDown('8');
      assert.equal(instance.state.zones.battlefield[0].flipped, true);
      await pt.setFaceUp('8');
      assert.equal(instance.state.zones.battlefield[0].flipped, false);
    });

    it('rotateCard toggles rotated', async () => {
      await pt.rotateCard('8');
      assert.equal(instance.state.zones.battlefield[0].rotated, true);
    });

    it('moveCardPosition updates top/left', async () => {
      await pt.moveCardPosition('8', 300, 400);
      const card = instance.state.zones.battlefield[0];
      assert.equal(card.top, 300);
      assert.equal(card.left, 400);
    });

    it('updateBattlefieldCard accepts only whitelisted props', async () => {
      await pt.updateBattlefieldCard('8', {
        tapped: true,
        top: 50,
        name: 'hacked', // should be ignored
      });
      const card = instance.state.zones.battlefield[0];
      assert.equal(card.tapped, true);
      assert.equal(card.top, 50);
      assert.equal(card.name, 'H'); // unchanged
    });

    it('updateBattlefieldCard throws if no valid props', () => {
      assert.throws(
        () => pt.updateBattlefieldCard('8', { name: 'hacked' }),
        /No valid battlefield properties/,
      );
    });

    it('throws for card not on battlefield', async () => {
      await assert.rejects(
        () => pt.tapCard('6'), // card '6' is in hand
        /not found on battlefield/,
      );
    });

    it('setDoesntUntap marks a card', async () => {
      await pt.setDoesntUntap('8');
      assert.equal(instance.state.zones.battlefield[0].doesntUntap, true);
      await pt.setDoesntUntap('8', false);
      assert.equal(instance.state.zones.battlefield[0].doesntUntap, false);
    });
  });

  // ── Game Actions ──────────────────────────────────────────────────

  describe('draw', () => {
    it('draws one card from library to hand', async () => {
      await pt.draw();
      assert.equal(instance.state.zones.library.length, 4);
      assert.equal(instance.state.zones.hand.length, 3);
      assert.equal(instance.state.zones.hand[2].name, 'E'); // was top
      assert.equal(instance.state.zones.hand[2].zone, 'hand');
    });

    it('draws multiple cards atomically', async () => {
      await pt.draw(3);
      assert.equal(instance.state.zones.library.length, 2);
      assert.equal(instance.state.zones.hand.length, 5);
      // Drawn in order: E, D, C (top to bottom)
      assert.equal(instance.state.zones.hand[2].name, 'E');
      assert.equal(instance.state.zones.hand[3].name, 'D');
      assert.equal(instance.state.zones.hand[4].name, 'C');
    });

    it('draws at most what the library has', async () => {
      await pt.draw(100);
      assert.equal(instance.state.zones.library.length, 0);
      assert.equal(instance.state.zones.hand.length, 7);
    });
  });

  describe('game state', () => {
    it('getLife returns current life', () => {
      assert.equal(pt.getLife(), 20);
    });

    it('getTurn returns current turn', () => {
      assert.equal(pt.getTurn(), 1);
    });

    it('nextTurn advances the turn', () => {
      pt.nextTurn();
      assert.equal(pt.getTurn(), 2);
    });
  });

  // ── Search ────────────────────────────────────────────────────────

  describe('search', () => {
    it('findCardsByName finds across zones', () => {
      const results = pt.findCardsByName('F');
      assert.equal(results.length, 1);
      assert.equal(results[0].zone, 'hand');
    });

    it('findCardsByName returns empty for missing name', () => {
      assert.deepEqual(pt.findCardsByName('Nonexistent'), []);
    });

    it('findCardByZoneId finds the card and its zone', () => {
      const card = pt.findCardByZoneId('8');
      assert.equal(card.name, 'H');
      assert.equal(card.zone, 'battlefield');
    });

    it('findCardByZoneId returns null for missing id', () => {
      assert.equal(pt.findCardByZoneId('nonexistent'), null);
    });
  });

  // ── Mutation Queue ────────────────────────────────────────────────

  describe('mutation queue', () => {
    it('serializes rapid mutations correctly', async () => {
      // Fire three mutations without awaiting individually.
      const p1 = pt.draw(1);
      const p2 = pt.moveCard('6', 'graveyard');
      const p3 = pt.tapCard('8');

      await Promise.all([p1, p2, p3]);

      assert.equal(instance.state.zones.library.length, 4);
      assert.equal(instance.state.zones.hand.length, 2); // drew 1, moved 1 away
      assert.equal(instance.state.zones.graveyard.length, 2);
      assert.equal(instance.state.zones.battlefield[0].tapped, true);
    });
  });

  // ── Events ────────────────────────────────────────────────────────

  describe('events', () => {
    it('emits card:zone-changed when a card moves', async () => {
      const events = [];
      pt.on('card:zone-changed', e => events.push(e));

      await pt.moveCard('6', 'graveyard');

      assert.equal(events.length, 1);
      assert.equal(events[0].card.name, 'F');
      assert.equal(events[0].fromZone, 'hand');
      assert.equal(events[0].toZone, 'graveyard');
    });

    it('emits card:removed when a card is deleted', async () => {
      const events = [];
      pt.on('card:removed', e => events.push(e));

      await pt.removeCard('9');

      assert.equal(events.length, 1);
      assert.equal(events[0].card.name, 'I');
      assert.equal(events[0].fromZone, 'graveyard');
    });

    it('emits card:state-changed for battlefield mutations', async () => {
      const events = [];
      pt.on('card:state-changed', e => events.push(e));

      await pt.tapCard('8');

      assert.equal(events.length, 1);
      assert.deepEqual(events[0].changes.tapped, { from: false, to: true });
    });

    it('emits zone:reordered on reorder', async () => {
      const events = [];
      pt.on('zone:reordered', e => events.push(e));

      await pt.reorderZone('library', 0, 4);

      assert.equal(events.length, 1);
      assert.equal(events[0].zone, 'library');
    });

    it('off removes listener', async () => {
      const events = [];
      const handler = e => events.push(e);
      pt.on('card:zone-changed', handler);
      pt.off('card:zone-changed', handler);

      await pt.moveCard('6', 'graveyard');

      assert.equal(events.length, 0);
    });

    it('on returns this for chaining', () => {
      const result = pt.on('card:zone-changed', () => {});
      assert.equal(result, pt);
    });

    it('handles listener errors without crashing', async () => {
      pt.on('card:zone-changed', () => {
        throw new Error('boom');
      });

      // Should not throw.
      await pt.moveCard('6', 'graveyard');
      assert.equal(instance.state.zones.graveyard.length, 2);
    });
  });
});
