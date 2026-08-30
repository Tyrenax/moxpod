import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeSnapshot, encodeCardState, encodeDictEntry, diffSnapshots,
  applyDelta, emptySnapshot, hydrateCard, wireSize,
} from '../src/board/serialize.js';
import { OP_UPSERT, OP_REMOVE, OP_ZONE } from '../src/board/protocol.js';

const GEOMETRY = { width: 1000, height: 800, usableWidth: 900, cardW: 100, cardH: 140 };

function card(overrides = {}) {
  return {
    zoneId: '1', id: 'abc', scryfall_id: 'sf-1', name: 'Grizzly Bears',
    set: 'lea', cn: '10', layout: 'normal', type_line: 'Creature — Bear',
    mana_cost: '{1}{G}', power: '2', toughness: '2', oracle_text: '',
    top: 0, left: 0, tapped: false, flipped: false, rotated: false,
    doesntUntap: false, counters: 0, adjustedPower: 0, adjustedToughness: 0,
    adjustedLoyalty: 0, zIndex: 0,
    ...overrides,
  };
}

function snapshotOf(battlefield, extra = {}) {
  return encodeSnapshot({
    zones: { battlefield, graveyard: [], exile: [], command: [], ...extra.zones },
    geometry: GEOMETRY,
    life: extra.life ?? 40,
    turn: extra.turn ?? 1,
    counters: extra.counters || {},
    counts: extra.counts || { hand: 7, library: 92 },
    rev: extra.rev || 1,
  });
}

describe('encodeCardState', () => {
  it('converts pixel position to a centre-relative fraction', () => {
    const state = encodeCardState(card({ left: 400, top: 330 }), GEOMETRY);
    // centre = (400+50)/900 = 0.5 ; (330+70)/800 = 0.5
    assert.equal(state.x, 0.5);
    assert.equal(state.y, 0.5);
  });

  it('omits default values to keep frames small', () => {
    const state = encodeCardState(card(), GEOMETRY);
    assert.deepEqual(Object.keys(state).sort(), ['x', 'y']);
  });

  it('encodes the modifiers we actually care about displaying', () => {
    const state = encodeCardState(
      card({ tapped: true, counters: 3, adjustedPower: -1, adjustedToughness: -1 }),
      GEOMETRY,
    );
    assert.equal(state.t, 1);
    assert.equal(state.c, 3);
    assert.equal(state.p, -1);
    assert.equal(state.g, -1);
  });

  it('clamps out-of-bounds positions instead of emitting NaN', () => {
    const state = encodeCardState(card({ left: -9999, top: 99999 }), GEOMETRY);
    assert.equal(state.x, 0);
    assert.equal(state.y, 1);
    const degenerate = encodeCardState(card(), { usableWidth: 0, height: 0 });
    assert.equal(degenerate.x, 0.5);
    assert.equal(degenerate.y, 0.5);
  });
});

describe('encodeDictEntry', () => {
  it('carries the fields the detail popup needs', () => {
    const entry = encodeDictEntry(card({ oracle_text: 'Bears are bears.' }));
    assert.equal(entry.n, 'Grizzly Bears');
    assert.equal(entry.t, 'Creature — Bear');
    assert.equal(entry.m, '{1}{G}');
    assert.equal(entry.o, 'Bears are bears.');
    assert.equal(entry.p, '2');
  });

  it('keeps both faces of a double-faced card', () => {
    const entry = encodeDictEntry(card({
      layout: 'transform',
      card_faces: [
        { name: 'Front', type_line: 'Creature', oracle_text: 'a', power: '1', toughness: '1' },
        { name: 'Back', type_line: 'Creature', oracle_text: 'b', power: '3', toughness: '3' },
      ],
    }));
    assert.equal(entry.d.length, 2);
    assert.equal(entry.d[1].n, 'Back');
  });
});

describe('encodeSnapshot', () => {
  it('dedupes printings into the dictionary', () => {
    const snap = snapshotOf([
      card({ zoneId: '1' }), card({ zoneId: '2' }), card({ zoneId: '3' }),
    ]);
    assert.equal(snap.zones.battlefield.length, 3);
    assert.equal(Object.keys(snap.dict).length, 1, 'three copies share one printing');
  });

  it('never leaks hand or library contents', () => {
    const snap = snapshotOf([card()], { counts: { hand: 7, library: 92 } });
    assert.equal(snap.zones.hand, undefined);
    assert.equal(snap.zones.library, undefined);
    assert.equal(snap.counts.hand, 7);
    assert.equal(snap.counts.library, 92);
  });

  it('gives tokens without a scryfall id a stable synthetic key', () => {
    const snap = snapshotOf([
      card({ zoneId: '9', scryfall_id: undefined, id: 'tok1', name: 'Soldier', isToken: true }),
    ]);
    const key = snap.zones.battlefield[0].k;
    assert.match(key, /^t:tok1:Soldier$/);
    assert.equal(snap.dict[key].k, 1);
  });
});

describe('diffSnapshots', () => {
  it('returns null when nothing moved', () => {
    const a = snapshotOf([card()]);
    const b = snapshotOf([card()], { rev: 2 });
    assert.equal(diffSnapshots(a, b), null);
  });

  it('emits only the changed keys for a tapped card', () => {
    const a = snapshotOf([card()]);
    const b = snapshotOf([card({ tapped: true })], { rev: 2 });
    const { delta } = diffSnapshots(a, b);
    assert.equal(delta.ops.length, 1);
    assert.equal(delta.ops[0].o, OP_UPSERT);
    assert.deepEqual(delta.ops[0].s, { t: 1 });
  });

  it('emits an explicit reset when a modifier returns to its default', () => {
    const a = snapshotOf([card({ counters: 2 })]);
    const b = snapshotOf([card({ counters: 0 })], { rev: 2 });
    const { delta } = diffSnapshots(a, b);
    assert.deepEqual(delta.ops[0].s, { c: 0 });
  });

  it('emits a remove op for a card that left the battlefield', () => {
    const a = snapshotOf([card({ zoneId: '1' }), card({ zoneId: '2' })]);
    const b = snapshotOf([card({ zoneId: '1' })], { rev: 2 });
    const { delta } = diffSnapshots(a, b);
    const removes = delta.ops.filter(op => op.o === OP_REMOVE);
    assert.equal(removes.length, 1);
    assert.equal(removes[0].i, '2');
  });

  it('ships new printings in the delta dictionary', () => {
    const a = snapshotOf([card({ zoneId: '1' })]);
    const b = snapshotOf(
      [card({ zoneId: '1' }), card({ zoneId: '2', scryfall_id: 'sf-2', name: 'Bolt' })],
      { rev: 2 },
    );
    const { delta } = diffSnapshots(a, b);
    assert.deepEqual(Object.keys(delta.dict), ['sf-2']);
  });

  it('replaces a small ordered zone wholesale when it changes', () => {
    const a = snapshotOf([card()], { zones: { graveyard: [] } });
    const b = snapshotOf([card()], {
      rev: 2,
      zones: { graveyard: [card({ zoneId: '77', scryfall_id: 'sf-gy', name: 'Dead Thing' })] },
    });
    const { delta } = diffSnapshots(a, b);
    const zoneOps = delta.ops.filter(op => op.o === OP_ZONE);
    assert.equal(zoneOps.length, 1);
    assert.equal(zoneOps[0].z, 'graveyard');
    assert.equal(zoneOps[0].c.length, 1);
  });

  it('tracks life, turn and counts', () => {
    const a = snapshotOf([card()], { life: 40 });
    const b = snapshotOf([card()], { rev: 2, life: 33, turn: 4, counts: { hand: 5, library: 90 } });
    const { delta } = diffSnapshots(a, b);
    assert.equal(delta.life, 33);
    assert.equal(delta.turn, 4);
    assert.deepEqual(delta.counts, { hand: 5, library: 90 });
  });

  it('asks for a full snapshot when there is no baseline', () => {
    const b = snapshotOf([card()]);
    assert.equal(diffSnapshots(null, b).full, b);
  });
});

describe('applyDelta', () => {
  it('round-trips a diff back to the sender snapshot', () => {
    const a = snapshotOf([card({ zoneId: '1' }), card({ zoneId: '2' })]);
    const b = snapshotOf(
      [card({ zoneId: '1', tapped: true, counters: 4, left: 500 }),
       card({ zoneId: '3', scryfall_id: 'sf-3', name: 'New Thing' })],
      { rev: 2, life: 31 },
    );
    const { delta } = diffSnapshots(a, b);
    const { snapshot, gap } = applyDelta(a, delta);

    assert.equal(gap, false);
    assert.equal(snapshot.rev, b.rev);
    assert.equal(snapshot.life, 31);
    const ids = snapshot.zones.battlefield.map(e => e.i).sort();
    assert.deepEqual(ids, ['1', '3']);
    const one = snapshot.zones.battlefield.find(e => e.i === '1');
    assert.deepEqual(one.s, b.zones.battlefield[0].s);
  });

  it('does not mutate the snapshot it was given', () => {
    const a = snapshotOf([card({ zoneId: '1' })]);
    const frozen = JSON.stringify(a);
    const b = snapshotOf([card({ zoneId: '1', tapped: true })], { rev: 2 });
    applyDelta(a, diffSnapshots(a, b).delta);
    assert.equal(JSON.stringify(a), frozen);
  });

  it('flags a revision gap instead of applying a stale delta', () => {
    const a = snapshotOf([card()]);
    const b = snapshotOf([card({ tapped: true })], { rev: 2 });
    const { delta } = diffSnapshots(a, b);
    delta.base = 99;
    const { gap } = applyDelta(a, delta);
    assert.equal(gap, true);
  });

  it('handles a remove and a re-add of the same id in one batch', () => {
    const a = snapshotOf([card({ zoneId: '1' })]);
    const { snapshot } = applyDelta(a, {
      rev: 2, base: a.rev,
      ops: [
        { o: OP_REMOVE, i: '1' },
        { o: OP_UPSERT, i: '1', k: 'sf-1', z: 'battlefield', s: { x: 0.9, y: 0.9 } },
      ],
    });
    assert.equal(snapshot.zones.battlefield.length, 1);
    assert.equal(snapshot.zones.battlefield[0].s.x, 0.9);
  });

  it('starts from an empty snapshot when the player is unknown', () => {
    const { snapshot } = applyDelta(null, { rev: 1, ops: [] });
    assert.deepEqual(snapshot.zones.battlefield, []);
  });
});

describe('hydrateCard', () => {
  it('exposes the modifiers the spectator needs to read', () => {
    const snap = snapshotOf([
      card({ tapped: true, counters: 2, adjustedPower: -1, adjustedToughness: -1 }),
    ]);
    const view = hydrateCard(snap.zones.battlefield[0], snap.dict);
    assert.equal(view.name, 'Grizzly Bears');
    assert.equal(view.tapped, true);
    assert.equal(view.counters, 2);
    assert.equal(view.adjustedPower, -1);
    assert.equal(view.adjustedToughness, -1);
    assert.equal(view.power, '2');
  });

  it('degrades to a placeholder when the printing is unknown', () => {
    const view = hydrateCard({ i: 'x', k: 'never-seen', s: {} }, {});
    assert.equal(view.known, false);
    assert.equal(view.name, 'Unknown card');
  });
});

describe('wire size', () => {
  it('keeps a realistic 40-permanent board well under the relay frame cap', () => {
    const battlefield = [];
    for (let i = 0; i < 40; i++) {
      battlefield.push(card({
        zoneId: String(i),
        scryfall_id: `sf-${i % 25}`,
        name: `Card Number ${i % 25}`,
        oracle_text: 'A reasonably wordy rules paragraph that takes some space on the wire.',
        left: i * 7, top: i * 3, tapped: i % 3 === 0, counters: i % 5,
      }));
    }
    const snap = snapshotOf(battlefield);
    assert.ok(wireSize(snap) < 60000, `full snapshot was ${wireSize(snap)} bytes`);

    const moved = battlefield.map((c, i) => (i === 0 ? { ...c, tapped: !c.tapped } : c));
    const { delta } = diffSnapshots(snap, snapshotOf(moved, { rev: 2 }));
    assert.ok(wireSize(delta) < 200, `delta was ${wireSize(delta)} bytes`);
  });
});

describe('emptySnapshot', () => {
  it('has every mirrored zone present', () => {
    const snap = emptySnapshot();
    for (const zone of ['battlefield', 'graveyard', 'exile', 'command']) {
      assert.ok(Array.isArray(snap.zones[zone]), `${zone} missing`);
    }
  });
});
