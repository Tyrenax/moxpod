// End-to-end test over a real WebSocket, through the real dev relay.
//
// This is the test that would have caught every bug the unit tests cannot see:
// framing, the join handshake, targetId routing, and -- the important one --
// whether a board mirrored across the wire actually matches the board that was
// sent. It spawns the same `node server/dev-relay.js` you run by hand, so if
// this passes, two browser tabs will work.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BoardBatcher } from '../src/board/batcher.js';
import { RemoteBoardStore } from '../src/board/store.js';
import { encodeSnapshot } from '../src/board/serialize.js';
import {
  ACTION_FULL, ACTION_DELTA, ACTION_REQUEST,
  packEnvelope, unpackEnvelope, RELAY_ALLOWED_ZONE_SYNC_FIELDS,
} from '../src/board/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8800 + Math.floor(Math.random() * 150);
const BASE = `localhost:${PORT}`;

const GEOMETRY = { width: 1000, height: 800, usableWidth: 900, cardW: 100, cardH: 140 };

let relay;

function card(overrides = {}) {
  return {
    zoneId: '1', id: 'abc', scryfall_id: 'sf-1', name: 'Grizzly Bears',
    set: 'lea', cn: '10', layout: 'normal', type_line: 'Creature — Bear',
    mana_cost: '{1}{G}', power: '2', toughness: '2',
    top: 0, left: 0, counters: 0, tapped: false,
    ...overrides,
  };
}

function board(cards, extra = {}) {
  return encodeSnapshot({
    zones: { battlefield: cards, graveyard: extra.graveyard || [], exile: [], command: [] },
    geometry: GEOMETRY, life: extra.life ?? 40, turn: extra.turn ?? 1,
    counters: {}, counts: extra.counts || { hand: 7, library: 92 },
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A minimal MoxPod client: connect, join, send/receive zone-sync frames. */
async function connect(room, username, key) {
  const ws = new WebSocket(`ws://${BASE}/room/${room}`);
  const inbox = [];
  ws.addEventListener('message', e => inbox.push(JSON.parse(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true });
  });
  ws.send(JSON.stringify({
    type: 'join', playerKey: key, username, gameType: 'traditional',
  }));

  const client = {
    ws, inbox, username,
    playerId: null,
    send: msg => ws.send(JSON.stringify(msg)),
    take: type => inbox.filter(m => m.type === type),
    close: () => ws.close(),
    async waitFor(predicate, timeout = 2000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const found = inbox.find(predicate);
        if (found) return found;
        await sleep(20);
      }
      throw new Error(`timed out waiting; inbox: ${inbox.map(m => m.type).join(',')}`);
    },
  };
  const joined = await client.waitFor(m => m.type === 'system' && m.playerId);
  client.playerId = joined.playerId;
  return client;
}

before(async () => {
  relay = spawn(process.execPath, [join(ROOT, 'server', 'dev-relay.js'), '--port', String(PORT), '--quiet'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('relay did not start');
    try {
      const res = await fetch(`http://${BASE}/health`);
      if (res.ok) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
});

after(() => {
  if (relay) relay.kill();
});

describe('dev relay handshake', () => {
  it('assigns sequential player ids and announces the roster', async () => {
    const a = await connect('HAND01', 'Alice', 'key-alice-000001');
    const b = await connect('HAND01', 'Bob', 'key-bob-00000001');

    assert.equal(a.playerId, 'p1');
    assert.equal(b.playerId, 'p2');

    const joinEvent = await a.waitFor(m => m.type === 'join');
    assert.equal(joinEvent.senderId, 'p2');
    assert.equal(joinEvent.username, 'Bob');
    assert.equal(joinEvent.players.length, 2);

    a.close(); b.close();
    await sleep(100);
  });

  it('rejects a player key that is too short', async () => {
    const ws = new WebSocket(`ws://${BASE}/room/SHORT1`);
    const inbox = [];
    ws.addEventListener('message', e => inbox.push(JSON.parse(e.data)));
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ type: 'join', playerKey: 'abc', username: 'Nope' }));
    await sleep(300);
    assert.ok(inbox.some(m => m.rejected), 'expected a rejection');
  });

  it('enforces the room capacity', async () => {
    await fetch(`http://${BASE}/room/CAP002`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameType: 'traditional', maxPlayers: 2 }),
    });
    const a = await connect('CAP002', 'A', 'key-cap-a-000001');
    const b = await connect('CAP002', 'B', 'key-cap-b-000001');

    const ws = new WebSocket(`ws://${BASE}/room/CAP002`);
    const inbox = [];
    ws.addEventListener('message', e => inbox.push(JSON.parse(e.data)));
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ type: 'join', playerKey: 'key-cap-c-000001', username: 'C' }));
    await sleep(300);
    assert.ok(inbox.some(m => m.rejected), 'third player should be refused');

    a.close(); b.close();
    await sleep(100);
  });

  it('tells everyone when a player leaves', async () => {
    const a = await connect('LEAVE1', 'Alice', 'key-leave-a-0001');
    const b = await connect('LEAVE1', 'Bob', 'key-leave-b-0001');
    b.close();
    const left = await a.waitFor(m => m.left === true);
    assert.equal(left.leftPlayerId, 'p2');
    a.close();
    await sleep(100);
  });
});

describe('relay field whitelist', () => {
  // The bug this suite exists for: the production worker rebuilds every
  // relayed message keeping only the fields whitelisted for its type, so a
  // top-level `snapshot` is silently dropped and the spectator waits forever.
  // The dev relay reproduces that, so these assertions mean something.

  it('drops a payload sent at the top level', async () => {
    const a = await connect('WHITE1', 'A', 'key-white-a-0001');
    const b = await connect('WHITE1', 'B', 'key-white-b-0001');

    a.send({
      type: 'zone-sync', action: ACTION_FULL,
      snapshot: { marker: 'should not survive' },
      zoneId: 'z1', cardName: 'Sol Ring',
    });
    const relayed = await b.waitFor(m => m.type === 'zone-sync');

    assert.equal(relayed.action, ACTION_FULL, 'action survives');
    assert.equal(relayed.snapshot, undefined, 'snapshot must have been stripped');
    assert.equal(relayed.zoneId, undefined, 'zoneId must have been stripped');
    assert.equal(relayed.cardName, undefined, 'cardName must have been stripped');

    a.close(); b.close();
    await sleep(100);
  });

  it('carries the same payload intact once wrapped by packEnvelope', async () => {
    const a = await connect('WHITE2', 'A', 'key-white2-a-001');
    const b = await connect('WHITE2', 'B', 'key-white2-b-001');

    const snapshot = board([card({ tapped: true, counters: 3 })]);
    a.send({ type: 'zone-sync', ...packEnvelope(ACTION_FULL, { snapshot }) });

    const relayed = await b.waitFor(m => m.type === 'zone-sync');
    const msg = unpackEnvelope(relayed);
    assert.equal(msg.action, ACTION_FULL);
    assert.ok(msg.snapshot, 'payload did not survive the whitelist');
    assert.deepEqual(msg.snapshot.zones.battlefield, snapshot.zones.battlefield);

    a.close(); b.close();
    await sleep(100);
  });

  it('only ever emits fields the relay allows', () => {
    const packed = packEnvelope(
      ACTION_FULL, { snapshot: { a: 1 }, zoneId: 'x' }, { targetId: 'p2', zone: 'graveyard' },
    );
    for (const key of Object.keys(packed)) {
      assert.ok(
        RELAY_ALLOWED_ZONE_SYNC_FIELDS.has(key),
        `packEnvelope emitted "${key}", which the relay would strip`,
      );
    }
    assert.deepEqual(unpackEnvelope({ ...packed, senderId: 'p1' }).snapshot, { a: 1 });
  });

  it('unpacks a message that was not wrapped, for a forked relay', () => {
    const msg = unpackEnvelope({ action: ACTION_FULL, snapshot: { a: 1 } });
    assert.deepEqual(msg.snapshot, { a: 1 });
  });

  it('rejects a player key shorter than production requires', async () => {
    const ws = new WebSocket(`ws://${BASE}/room/KEYLEN`);
    const inbox = [];
    ws.addEventListener('message', e => inbox.push(JSON.parse(e.data)));
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    // 15 characters: accepted by the old dev relay, refused by production.
    ws.send(JSON.stringify({ type: 'join', playerKey: 'x'.repeat(15), username: 'Short' }));
    await sleep(300);
    assert.ok(inbox.some(m => m.rejected), 'dev relay must match production key length');
  });
});

describe('board sync over the wire', () => {
  it('mirrors a board from one client to another, byte for byte', async () => {
    const owner = await connect('SYNC01', 'Owner', 'key-sync-own-001');
    const spy = await connect('SYNC01', 'Spy', 'key-sync-spy-001');

    const store = new RemoteBoardStore();
    spy.ws.addEventListener('message', (event) => {
      const msg = unpackEnvelope(JSON.parse(event.data));
      if (msg.type !== 'zone-sync') return;
      if (msg.action === ACTION_FULL) store.ingestFull(msg.senderId, msg.snapshot);
      if (msg.action === ACTION_DELTA) store.ingestDelta(msg.senderId, msg.delta);
    });

    // The owner's real board, driven through the real batcher.
    let cards = [
      card({ zoneId: '1', left: 100, top: 100 }),
      card({ zoneId: '2', scryfall_id: 'sf-2', name: 'Llanowar Elves', left: 300, top: 100 }),
    ];
    const batcher = new BoardBatcher({
      capture: () => board(cards),
      send: ({ action, ...payload }) => owner.send({ type: 'zone-sync', ...packEnvelope(action, payload) }),
    });

    batcher.start();
    await sleep(600);

    let view = store.view(owner.playerId);
    assert.ok(view, 'spectator received no board');
    assert.equal(view.battlefield.length, 2);
    assert.equal(view.life, 40);

    // Tap one, put a -1/-1 on it, kill the other -- the exact things we care
    // about displaying.
    cards = [
      card({ zoneId: '1', left: 100, top: 100, tapped: true, counters: 2, adjustedPower: -1, adjustedToughness: -1 }),
    ];
    batcher.markDirty();
    await sleep(600);

    view = store.view(owner.playerId);
    assert.equal(view.battlefield.length, 1);
    const [bear] = view.battlefield;
    assert.equal(bear.name, 'Grizzly Bears');
    assert.equal(bear.tapped, true);
    assert.equal(bear.counters, 2);
    assert.equal(bear.adjustedPower, -1);
    assert.equal(bear.adjustedToughness, -1);
    assert.equal(view.gaps, 0);

    batcher.stop();
    owner.close(); spy.close();
    await sleep(100);
  });

  it('never puts hand or library contents on the wire', async () => {
    const owner = await connect('PRIV01', 'Owner', 'key-priv-own-001');
    const spy = await connect('PRIV01', 'Spy', 'key-priv-spy-001');

    const frames = [];
    spy.ws.addEventListener('message', e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'zone-sync') frames.push(e.data);
    });

    const batcher = new BoardBatcher({
      capture: () => board([card()], { counts: { hand: 7, library: 92 } }),
      send: ({ action, ...payload }) => owner.send({ type: 'zone-sync', ...packEnvelope(action, payload) }),
    });
    batcher.start();
    await sleep(600);

    assert.ok(frames.length > 0, 'no frames captured');
    for (const frame of frames) {
      const parsed = unpackEnvelope(JSON.parse(frame));
      const zones = parsed.snapshot?.zones || {};
      assert.equal(zones.hand, undefined, 'hand leaked onto the wire');
      assert.equal(zones.library, undefined, 'library leaked onto the wire');
    }

    batcher.stop();
    owner.close(); spy.close();
    await sleep(100);
  });

  it('routes a resync request only to the player it targets', async () => {
    const a = await connect('ROUTE1', 'A', 'key-route-a-0001');
    const b = await connect('ROUTE1', 'B', 'key-route-b-0001');
    const c = await connect('ROUTE1', 'C', 'key-route-c-0001');

    b.send({ type: 'zone-sync', ...packEnvelope(ACTION_REQUEST, {}, { targetId: a.playerId }) });
    await sleep(300);

    assert.ok(a.inbox.some(m => m.action === ACTION_REQUEST), 'target did not receive it');
    assert.ok(!c.inbox.some(m => m.action === ACTION_REQUEST), 'bystander received a targeted message');

    a.close(); b.close(); c.close();
    await sleep(100);
  });

  it('keeps a long game in sync without a single gap', async () => {
    const owner = await connect('LONG01', 'Owner', 'key-long-own-001');
    const spy = await connect('LONG01', 'Spy', 'key-long-spy-001');

    const store = new RemoteBoardStore();
    spy.ws.addEventListener('message', (event) => {
      const msg = unpackEnvelope(JSON.parse(event.data));
      if (msg.type !== 'zone-sync') return;
      if (msg.action === ACTION_FULL) store.ingestFull(msg.senderId, msg.snapshot);
      if (msg.action === ACTION_DELTA) store.ingestDelta(msg.senderId, msg.delta);
    });

    const cards = [];
    for (let i = 0; i < 12; i++) {
      cards.push(card({ zoneId: `c${i}`, scryfall_id: `sf-${i % 5}`, left: i * 40, top: 60 }));
    }
    const batcher = new BoardBatcher({
      capture: () => board(cards),
      send: ({ action, ...payload }) => owner.send({ type: 'zone-sync', ...packEnvelope(action, payload) }),
    });
    batcher.start();

    // Thirty seconds of play, compressed: mutate and mark dirty repeatedly.
    for (let tick = 0; tick < 40; tick++) {
      const target = cards[tick % cards.length];
      target.tapped = !target.tapped;
      target.left = (target.left + 37) % 800;
      if (tick % 7 === 0) target.counters = (target.counters + 1) % 4;
      batcher.markDirty();
      await sleep(60);
    }
    await sleep(800);

    const view = store.view(owner.playerId);
    assert.equal(view.gaps, 0, 'spectator desynced during play');
    assert.equal(view.unknownCards, 0, 'a printing never arrived');
    assert.equal(view.battlefield.length, 12);

    // The mirrored board must equal the owner's board exactly.
    const mine = board(cards);
    const expected = new Map(mine.zones.battlefield.map(e => [e.i, e.s]));
    for (const seen of view.battlefield) {
      const want = expected.get(seen.zoneId);
      assert.ok(want, `spectator has an extra card ${seen.zoneId}`);
      assert.equal(seen.tapped, !!want.t, `tapped mismatch on ${seen.zoneId}`);
      assert.equal(seen.counters, want.c || 0, `counters mismatch on ${seen.zoneId}`);
      assert.ok(Math.abs(seen.x - want.x) < 0.0001, `x mismatch on ${seen.zoneId}`);
    }

    batcher.stop();
    owner.close(); spy.close();
    await sleep(100);
  });

  it('survives a lossy link by resyncing instead of showing a wrong board', async () => {
    const owner = await connect('LOSS01', 'Owner', 'key-loss-own-001');
    const spy = await connect('LOSS01', 'Spy', 'key-loss-spy-001');

    const resyncs = [];
    const store = new RemoteBoardStore({ onResyncNeeded: id => resyncs.push(id) });

    let dropNext = 0;
    spy.ws.addEventListener('message', (event) => {
      const msg = unpackEnvelope(JSON.parse(event.data));
      if (msg.type !== 'zone-sync') return;
      // Deliberately drop the second delta to simulate packet loss.
      if (msg.action === ACTION_DELTA && ++dropNext === 2) return;
      if (msg.action === ACTION_FULL) store.ingestFull(msg.senderId, msg.snapshot);
      if (msg.action === ACTION_DELTA) store.ingestDelta(msg.senderId, msg.delta);
    });

    const cards = [card({ zoneId: '1' })];
    const batcher = new BoardBatcher({
      capture: () => board(cards),
      send: ({ action, ...payload }) => owner.send({ type: 'zone-sync', ...packEnvelope(action, payload) }),
      config: { keyframeMs: 2000 },
    });
    batcher.start();

    for (let i = 0; i < 10; i++) {
      cards[0].left = (cards[0].left + 50) % 700;
      batcher.markDirty();
      await sleep(400);
    }
    await sleep(500);

    assert.ok(resyncs.length > 0, 'a dropped frame should have been detected');
    // The periodic keyframe must have healed it by now.
    const view = store.view(owner.playerId);
    assert.equal(view.battlefield.length, 1);
    assert.ok(view.rev > 0);

    batcher.stop();
    owner.close(); spy.close();
    await sleep(100);
  });
});
