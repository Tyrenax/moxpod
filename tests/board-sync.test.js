import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BoardBatcher } from '../src/board/batcher.js';
import { RemoteBoardStore } from '../src/board/store.js';
import { BoardSimulator, makeRng } from '../src/debug/simulator.js';
import { encodeSnapshot } from '../src/board/serialize.js';
import { ACTION_FULL, ACTION_DELTA } from '../src/board/protocol.js';
import { Tracer, LEVELS } from '../src/debug/tracer.js';

const GEOMETRY = { width: 1000, height: 800, usableWidth: 900, cardW: 100, cardH: 140 };

/** A controllable clock + timer queue, so no test ever sleeps. */
function makeHarness() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    /** Advance the clock, firing due timers in order. */
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        if (++guard > 1000) throw new Error('timer storm');
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.fn();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}

/**
 * Timer injection for tests that drive the simulator by hand. Without it the
 * simulator's real setInterval keeps the node:test event loop alive.
 */
const NO_TIMERS = { setTimer: () => 0, clearTimer: () => {} };

function card(overrides = {}) {
  return {
    zoneId: '1', id: 'abc', scryfall_id: 'sf-1', name: 'Grizzly Bears',
    set: 'lea', cn: '10', layout: 'normal', type_line: 'Creature — Bear',
    mana_cost: '{1}{G}', power: '2', toughness: '2',
    top: 0, left: 0, counters: 0, tapped: false,
    ...overrides,
  };
}

function makeBoard(cards, extra = {}) {
  return encodeSnapshot({
    zones: { battlefield: cards, graveyard: [], exile: [], command: [] },
    geometry: GEOMETRY, life: extra.life ?? 40, turn: 1,
    counters: {}, counts: { hand: 7, library: 92 },
  });
}

describe('BoardBatcher', () => {
  it('coalesces a burst of changes into a single frame', () => {
    const harness = makeHarness();
    const sent = [];
    // Six tapped permanents, as at the start of your untap step.
    let board = [];
    for (let i = 0; i < 6; i++) board.push(card({ zoneId: String(i), tapped: true }));

    const batcher = new BoardBatcher({
      capture: () => makeBoard(board),
      send: msg => sent.push(msg),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });

    batcher.start();
    harness.advance(400);
    assert.equal(sent.length, 1, 'initial full snapshot');
    assert.equal(sent[0].action, ACTION_FULL);

    // Untap all six. Upstream MoxMox would emit six frames here and trip the
    // relay's 5/sec bucket; we must emit exactly one.
    board = board.map(c => ({ ...c, tapped: false }));
    for (let i = 0; i < 6; i++) batcher.markDirty();

    harness.advance(400);
    assert.equal(sent.length, 2, 'six changes produced exactly one extra frame');
    assert.equal(sent[1].action, ACTION_DELTA);
    assert.equal(sent[1].delta.ops.length, 6, 'all six cards in the one frame');
  });

  it('stays under the relay token bucket during sustained churn', () => {
    const harness = makeHarness();
    const sent = [];
    let counter = 0;
    const batcher = new BoardBatcher({
      capture: () => makeBoard([card({ zoneId: '1', left: (counter += 13) % 800 })]),
      send: msg => sent.push({ msg, t: harness.now() }),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });

    batcher.start();
    // Ten seconds of a player dragging cards non-stop.
    for (let tick = 0; tick < 200; tick++) {
      batcher.markDirty();
      harness.advance(50);
    }

    const perSecond = sent.length / 10;
    assert.ok(perSecond <= 3.1, `sent ${perSecond}/s, relay allows 5/s`);
    assert.ok(perSecond >= 2, `sent only ${perSecond}/s, too laggy`);

    // No two frames within the same 300 ms window.
    for (let i = 1; i < sent.length; i++) {
      assert.ok(sent[i].t - sent[i - 1].t >= 300, 'frames too close together');
    }
  });

  it('skips the send entirely when nothing changed', () => {
    const harness = makeHarness();
    const sent = [];
    const batcher = new BoardBatcher({
      capture: () => makeBoard([card()]),
      send: msg => sent.push(msg),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    batcher.start();
    harness.advance(400);
    assert.equal(sent.length, 1);

    for (let i = 0; i < 5; i++) { batcher.markDirty(); harness.advance(400); }
    assert.equal(sent.length, 1, 'idle board must not spend tokens');
    assert.ok(batcher.describe().stats.skipped >= 1);
  });

  it('re-sends a keyframe so a late spectator self-heals', () => {
    const harness = makeHarness();
    const sent = [];
    let counter = 0;
    const batcher = new BoardBatcher({
      capture: () => makeBoard([card({ left: (counter += 11) % 700 })]),
      send: msg => sent.push(msg),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
      config: { keyframeMs: 5000 },
    });
    batcher.start();
    for (let i = 0; i < 60; i++) { batcher.markDirty(); harness.advance(400); }

    const fulls = sent.filter(m => m.action === ACTION_FULL);
    assert.ok(fulls.length >= 4, `expected periodic keyframes, got ${fulls.length}`);
  });

  it('honours an explicit resync request', () => {
    const harness = makeHarness();
    const sent = [];
    let counter = 0;
    const batcher = new BoardBatcher({
      capture: () => makeBoard([card({ left: (counter += 9) % 500 })]),
      send: msg => sent.push(msg),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    batcher.start();
    harness.advance(400);
    batcher.markDirty();
    harness.advance(400);
    assert.equal(sent.at(-1).action, ACTION_DELTA);

    batcher.requestFull();
    harness.advance(400);
    assert.equal(sent.at(-1).action, ACTION_FULL);
  });

  it('survives a capture that throws', () => {
    const harness = makeHarness();
    const traces = [];
    const batcher = new BoardBatcher({
      capture: () => { throw new Error('playtest component vanished'); },
      send: () => assert.fail('should not send'),
      onTrace: event => traces.push(event),
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    batcher.start();
    harness.advance(400);
    assert.ok(traces.some(t => t.kind === 'board:capture-failed'));
  });

  it('stops cleanly and clears its timer', () => {
    const harness = makeHarness();
    const batcher = new BoardBatcher({
      capture: () => makeBoard([card()]),
      send: () => {},
      now: harness.now, setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    batcher.start();
    batcher.stop();
    harness.advance(2000);
    assert.equal(harness.pending(), 0);
  });
});

describe('RemoteBoardStore', () => {
  it('reports nothing until the first frame arrives', () => {
    const store = new RemoteBoardStore();
    assert.equal(store.view('p1'), null);
  });

  it('exposes a hydrated, z-ordered view', () => {
    const store = new RemoteBoardStore();
    store.ingestFull('p1', makeBoard([
      card({ zoneId: '1', zIndex: 5 }),
      card({ zoneId: '2', zIndex: 1, tapped: true, counters: 3 }),
    ]));
    const view = store.view('p1');
    assert.equal(view.battlefield.length, 2);
    assert.deepEqual(view.battlefield.map(c => c.zoneId), ['2', '1']);
    assert.equal(view.battlefield[0].tapped, true);
    assert.equal(view.battlefield[0].counters, 3);
    assert.equal(view.life, 40);
    assert.equal(view.handCount, 7);
  });

  it('asks for a resync on a revision gap and keeps the stale board visible', () => {
    const resyncs = [];
    const store = new RemoteBoardStore({ onResyncNeeded: (id, why) => resyncs.push({ id, why }) });
    const first = makeBoard([card({ zoneId: '1' })]);
    first.rev = 1;
    store.ingestFull('p1', first);

    store.ingestDelta('p1', { rev: 9, base: 8, ops: [{ o: 'r', i: '1' }] });

    assert.deepEqual(resyncs, [{ id: 'p1', why: 'revision-gap' }]);
    assert.equal(store.view('p1').battlefield.length, 1, 'stale board kept, not blanked');
    assert.equal(store.describe().p1.gaps, 1);
  });

  it('forgets a player who leaves', () => {
    const store = new RemoteBoardStore();
    store.ingestFull('p1', makeBoard([card()]));
    store.forget('p1');
    assert.equal(store.view('p1'), null);
  });

  it('counts cards whose printing never arrived', () => {
    const store = new RemoteBoardStore();
    const snap = makeBoard([card()]);
    snap.zones.battlefield.push({ i: 'ghost', k: 'unknown-key', s: {} });
    store.ingestFull('p1', snap);
    assert.equal(store.view('p1').unknownCards, 1);
  });
});

describe('BoardSimulator', () => {
  it('is deterministic for a given seed', () => {
    const runs = [];
    for (let run = 0; run < 2; run++) {
      const store = new RemoteBoardStore();
      const harness = makeHarness();
      const sim = new BoardSimulator({
        store, now: harness.now,
        setTimer: harness.setTimer, clearTimer: harness.clearTimer,
      });
      sim.configure({ players: 2, permanents: 5, seed: 42 });
      sim.start();
      for (let i = 0; i < 25; i++) sim.step();
      runs.push(JSON.stringify(store.raw('sim-1')));
    }
    assert.equal(runs[0], runs[1]);
  });

  it('drives the real diff/apply path without desyncing', () => {
    const store = new RemoteBoardStore();
    const harness = makeHarness();
    const sim = new BoardSimulator({
      store, now: harness.now,
      setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    sim.configure({ players: 3, permanents: 8, seed: 7 });
    sim.start();
    for (let i = 0; i < 60; i++) sim.step();

    for (const id of ['sim-1', 'sim-2', 'sim-3']) {
      const view = store.view(id);
      assert.ok(view, `${id} has no board`);
      assert.equal(view.gaps, 0, `${id} desynced`);
      assert.equal(view.unknownCards, 0, `${id} has cards with no printing`);
      assert.ok(view.battlefield.length > 0);
    }
  });

  it('borrows real printings from your own board', () => {
    const store = new RemoteBoardStore();
    const sim = new BoardSimulator({ store, ...NO_TIMERS });
    const mine = makeBoard([card({ scryfall_id: 'real-1', name: 'Real Card' })]);
    assert.equal(sim.seed(mine), 1);
    sim.configure({ players: 1, permanents: 3 });
    sim.start();
    const view = store.view('sim-1');
    assert.ok(view.battlefield.every(c => c.name === 'Real Card'));
  });

  it('falls back to placeholders when your board is empty', () => {
    const store = new RemoteBoardStore();
    const sim = new BoardSimulator({ store, ...NO_TIMERS });
    assert.ok(sim.seed(makeBoard([])) > 1);
  });

  it('can inject a gap on demand to exercise resync', () => {
    const resyncs = [];
    const store = new RemoteBoardStore({ onResyncNeeded: id => resyncs.push(id) });
    const sim = new BoardSimulator({ store, ...NO_TIMERS });
    sim.configure({ players: 1, permanents: 4, seed: 3 });
    sim.start();
    sim.injectGap('sim-1');
    for (let i = 0; i < 5; i++) sim.step();
    assert.ok(resyncs.includes('sim-1'));
  });

  it('can inject a card with no printing to exercise the fallback frame', () => {
    const store = new RemoteBoardStore();
    const sim = new BoardSimulator({ store, ...NO_TIMERS });
    sim.configure({ players: 1, permanents: 2, seed: 5 });
    sim.start();
    sim.injectUnknownCard('sim-1');
    assert.equal(store.view('sim-1').unknownCards, 1);
  });

  it('cleans up its fake players on stop', () => {
    const store = new RemoteBoardStore();
    const harness = makeHarness();
    const sim = new BoardSimulator({
      store, now: harness.now,
      setTimer: harness.setTimer, clearTimer: harness.clearTimer,
    });
    sim.configure({ players: 2, permanents: 3 });
    sim.start();
    sim.stop();
    assert.deepEqual(store.playerIds(), []);
    assert.equal(harness.pending(), 0);
  });
});

describe('makeRng', () => {
  it('produces a stable sequence per seed', () => {
    const a = makeRng(99);
    const b = makeRng(99);
    for (let i = 0; i < 10; i++) assert.equal(a(), b());
  });
});

describe('Tracer', () => {
  it('records nothing below warn while disabled', () => {
    const tracer = new Tracer({ enabled: false });
    tracer.debug('net', 'ws:send', { a: 1 });
    assert.equal(tracer.records().length, 0);
  });

  it('always records warnings and errors, even when disabled', () => {
    const tracer = new Tracer({ enabled: false });
    tracer.error('net', 'ws:failed', { code: 1006 });
    assert.equal(tracer.records().length, 1);
    assert.equal(tracer.counters()['error:net'], 1);
  });

  it('keeps only the most recent records', () => {
    const tracer = new Tracer({ enabled: true, capacity: 10 });
    for (let i = 0; i < 25; i++) tracer.info('sys', 'tick', { i });
    const records = tracer.records();
    assert.equal(records.length, 10);
    assert.equal(records[0].data.i, 15);
    assert.equal(records.at(-1).data.i, 24);
  });

  it('filters by category, level and search text', () => {
    const tracer = new Tracer({ enabled: true });
    tracer.info('net', 'ws:send', { type: 'zone-sync' });
    tracer.info('board', 'capture', { permanents: 4 });
    tracer.error('board', 'apply:failed', { why: 'bad delta' });

    assert.equal(tracer.records({ category: 'net' }).length, 1);
    assert.equal(tracer.records({ level: 'error' }).length, 1);
    assert.equal(tracer.records({ search: 'zone-sync' }).length, 1);
  });

  it('never walks a circular or React-ish object', () => {
    const tracer = new Tracer({ enabled: true });
    const loop = { name: 'x' };
    loop.self = loop;
    loop.__reactFiber$abc = { huge: true };
    tracer.info('sys', 'circular', loop);
    const data = tracer.records()[0].data;
    assert.equal(data.name, 'x');
    assert.equal(data.__reactFiber$abc, undefined);
    assert.ok(JSON.stringify(data).length < 500);
  });

  it('evaluates a payload thunk only when enabled', () => {
    const tracer = new Tracer({ enabled: false });
    let calls = 0;
    tracer.debug('perf', 'expensive', () => { calls++; return { big: true }; });
    assert.equal(calls, 0);
    tracer.setEnabled(true);
    tracer.debug('perf', 'expensive', () => { calls++; return { big: true }; });
    assert.equal(calls, 1);
  });

  it('times an instrumented function and captures a throw', () => {
    let clock = 0;
    const tracer = new Tracer({ enabled: true, now: () => clock });
    const wrapped = tracer.instrument('render', () => { clock += 12; });
    wrapped();
    const timing = tracer.records({ search: 'timing:render' })[0];
    assert.equal(timing.data.ms, 12);

    const boom = tracer.instrument('boom', () => { throw new Error('nope'); });
    assert.throws(() => boom(), /nope/);
    assert.ok(tracer.records({ level: 'error' }).length >= 1);
  });

  it('exports a self-contained bug report', () => {
    const tracer = new Tracer({ enabled: true });
    tracer.info('net', 'ws:open', { url: 'wss://example' });
    const report = tracer.exportReport({ room: 'ABC123' });
    assert.equal(report.tool, 'MoxPod');
    assert.equal(report.room, 'ABC123');
    assert.equal(report.records.length, 1);
    assert.ok(JSON.parse(JSON.stringify(report)), 'report must be serialisable');
  });

  it('measures a sliding rate', () => {
    let clock = 0;
    const tracer = new Tracer({ enabled: true, now: () => clock });
    for (let i = 0; i < 4; i++) { tracer.rate('ws:in'); clock += 100; }
    assert.ok(tracer.getRate('ws:in') >= 3);
  });

  it('orders levels correctly', () => {
    assert.ok(LEVELS.debug < LEVELS.info);
    assert.ok(LEVELS.info < LEVELS.warn);
    assert.ok(LEVELS.warn < LEVELS.error);
  });
});
