// Synthetic opponents for solo development.
//
// The whole point of this module is that you can build and debug the entire
// spectator experience -- four-player tabs, board rendering, zone browsing,
// resync handling -- alone, at 2am, without asking three friends to sit in a
// Moxfield tab while you reload the extension.
//
// It deliberately pushes frames through the REAL ingest path (encode -> diff
// -> applyDelta -> store), not a UI shortcut. If the diff logic is broken, the
// simulator shows it, which is exactly what you want from a test harness.
//
// Card printings are borrowed from your own deck rather than invented, so
// images resolve and the data is genuinely well-formed.

import { diffSnapshots, emptySnapshot } from '../board/serialize.js';
import { BOARD_PROTOCOL_VERSION } from '../board/protocol.js';

const FAKE_NAMES = ['Sim Alice', 'Sim Bob', 'Sim Carol'];

/** Deterministic PRNG (mulberry32) so a bad run can be replayed exactly. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SIMULATOR_DEFAULTS = {
  players: 3,
  permanents: 10,
  tickMs: 1500,
  seed: 1337,
  // Probability weights for each mutation kind, per tick.
  moveWeight: 4,
  tapWeight: 3,
  counterWeight: 2,
  ptWeight: 2,
  playWeight: 2,
  killWeight: 1,
  lifeWeight: 2,
};

export class BoardSimulator {
  /**
   * @param {object} options
   * @param {import('../board/store.js').RemoteBoardStore} options.store
   * @param {object} [options.tracer]
   * @param {(players: Array) => void} [options.onRoster] called when the fake
   *        player list changes, so the UI can show the tabs
   */
  constructor(options) {
    this._store = options.store;
    this._tracer = options.tracer || { trace() {}, warn() {}, count() {} };
    this._onRoster = options.onRoster || (() => {});
    this._now = options.now || (() => Date.now());
    this._setTimer = options.setTimer || ((fn, ms) => setInterval(fn, ms));
    this._clearTimer = options.clearTimer || (h => clearInterval(h));

    this._config = { ...SIMULATOR_DEFAULTS };
    this._pool = [];          // borrowed printings: { key, entry }
    this._players = [];       // { id, username, snapshot, rev, handKeys }
    this._timer = null;
    this._rng = makeRng(this._config.seed);
    this.running = false;
    this.tickCount = 0;
  }

  get players() {
    return this._players.map(p => ({
      id: p.id, username: p.username, simulated: true, connected: true,
      life: p.snapshot.life, handCount: p.snapshot.counts.hand,
    }));
  }

  configure(patch = {}) {
    this._config = { ...this._config, ...patch };
    if ('seed' in patch) this._rng = makeRng(this._config.seed);
    return this._config;
  }

  /**
   * Borrow real card printings from a snapshot of your own board so the fake
   * opponents show real cards with working images. Falls back to synthetic
   * placeholders when your board is empty (e.g. before you have drawn).
   */
  seed(snapshot) {
    this._pool = [];
    const dict = snapshot?.dict || {};
    for (const [key, entry] of Object.entries(dict)) {
      this._pool.push({ key, entry });
    }
    if (this._pool.length === 0) {
      this._pool = makePlaceholderPool();
      this._tracer.trace('sim', 'seed:placeholders', { count: this._pool.length }, 'warn');
    } else {
      this._tracer.trace('sim', 'seed:borrowed', { printings: this._pool.length }, 'info');
    }
    return this._pool.length;
  }

  start() {
    if (this.running) return;
    if (this._pool.length === 0) this._pool = makePlaceholderPool();

    this._players = [];
    for (let i = 0; i < this._config.players; i++) {
      this._players.push(this._createPlayer(i));
    }
    this.running = true;
    this.tickCount = 0;
    this._onRoster(this.players);

    // Prime each board with a full snapshot, exactly as a real client would
    // on join.
    for (const player of this._players) {
      this._store.ingestFull(player.id, deepCopy(player.snapshot));
    }

    this._timer = this._setTimer(() => this.step(), this._config.tickMs);
    this._tracer.trace('sim', 'start', {
      players: this._players.length, tickMs: this._config.tickMs, seed: this._config.seed,
    }, 'info');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
    for (const player of this._players) this._store.forget(player.id);
    this._players = [];
    this._onRoster([]);
    this._tracer.trace('sim', 'stop', { ticks: this.tickCount }, 'info');
  }

  /** One mutation round for every fake player. Callable manually from tests. */
  step() {
    if (!this.running) return;
    this.tickCount++;
    for (const player of this._players) {
      const before = player.snapshot;
      const after = this._mutate(player);
      after.rev = before.rev + 1;

      const result = diffSnapshots(before, after);
      // A tick that changed nothing must NOT advance the revision, or the next
      // delta would cite a base the receiver never saw and read as a gap.
      if (!result) continue;

      player.snapshot = after;
      player.rev = after.rev;
      if (result.full) {
        this._store.ingestFull(player.id, deepCopy(after));
      } else {
        this._store.ingestDelta(player.id, deepCopy(result.delta));
      }
    }
    this._onRoster(this.players);
  }

  /** Is this playerId one of ours? Used to route resyncs locally. */
  ownsPlayer(playerId) {
    return this._players.some(p => p.id === playerId);
  }

  /**
   * Serve a resync for a fake player. Without this, "inject a desync" would
   * freeze the simulated board forever: every later delta cites a base the
   * store never saw, and no real peer exists to answer the resync request.
   */
  resend(playerId) {
    const player = this._players.find(p => p.id === playerId);
    if (!player) return false;
    this._store.ingestFull(player.id, deepCopy(player.snapshot));
    this._tracer.trace('sim', 'resync:served', { playerId, rev: player.snapshot.rev }, 'info');
    return true;
  }

  /** Drop a frame on purpose, to exercise gap detection and resync. */
  injectGap(playerId = null) {
    const player = playerId
      ? this._players.find(p => p.id === playerId)
      : this._players[0];
    if (!player) return false;
    // Advance our own revision without telling the store, so the NEXT delta
    // cites a base the receiver never saw -- exactly what a dropped frame
    // looks like from the other side.
    player.snapshot = { ...deepCopy(player.snapshot), rev: player.snapshot.rev + 5 };
    player.rev = player.snapshot.rev;
    this._tracer.trace('sim', 'inject:gap', { playerId: player.id, rev: player.rev }, 'warn');
    return true;
  }

  /** Send a delta referencing an unknown printing, to test dict resilience. */
  injectUnknownCard(playerId = null) {
    const player = playerId
      ? this._players.find(p => p.id === playerId)
      : this._players[0];
    if (!player) return false;
    const snapshot = deepCopy(player.snapshot);
    snapshot.rev = player.snapshot.rev + 1;
    player.rev = snapshot.rev;
    snapshot.zones.battlefield.push({
      i: `ghost-${this.tickCount}`, k: 'missing-printing-key',
      s: { x: this._rand(), y: this._rand() },
    });
    player.snapshot = snapshot;
    this._store.ingestFull(player.id, snapshot);
    this._tracer.trace('sim', 'inject:unknown-card', { playerId: player.id }, 'warn');
    return true;
  }

  _createPlayer(index) {
    const id = `sim-${index + 1}`;
    const snapshot = emptySnapshot();
    snapshot.v = BOARD_PROTOCOL_VERSION;
    snapshot.rev = 1;
    snapshot.life = 40;
    snapshot.turn = 1;
    snapshot.counts = { hand: 7, library: 92 };

    const handKeys = [];
    for (let i = 0; i < this._config.permanents; i++) {
      const printing = this._pick();
      snapshot.dict[printing.key] = printing.entry;
      snapshot.zones.battlefield.push({
        i: `${id}-c${i}`,
        k: printing.key,
        s: { x: this._rand(), y: this._rand(), z: i },
      });
    }
    for (let i = 0; i < 7; i++) handKeys.push(this._pick());

    return { id, username: FAKE_NAMES[index] || `Sim ${index + 1}`, snapshot, rev: 1, handKeys, counter: 0 };
  }

  _mutate(player) {
    const snapshot = deepCopy(player.snapshot);
    const bf = snapshot.zones.battlefield;
    const kind = this._weightedKind();

    switch (kind) {
      case 'move': {
        const card = this._sample(bf);
        if (card) { card.s.x = this._rand(); card.s.y = this._rand(); }
        break;
      }
      case 'tap': {
        const card = this._sample(bf);
        if (card) {
          if (card.s.t) delete card.s.t;
          else card.s.t = 1;
        }
        break;
      }
      case 'counter': {
        const card = this._sample(bf);
        if (card) {
          const next = (card.s.c || 0) + (this._rng() < 0.7 ? 1 : -1);
          if (next > 0) card.s.c = next; else delete card.s.c;
        }
        break;
      }
      case 'pt': {
        // The case the whole feature exists for: a -1/-1 that the opponent
        // applied themselves and we simply need to display.
        const card = this._sample(bf);
        if (card) {
          const delta = this._rng() < 0.5 ? -1 : 1;
          const p = (card.s.p || 0) + delta;
          const t = (card.s.g || 0) + delta;
          if (p) card.s.p = p; else delete card.s.p;
          if (t) card.s.g = t; else delete card.s.g;
        }
        break;
      }
      case 'play': {
        const printing = player.handKeys.shift() || this._pick();
        snapshot.dict[printing.key] = printing.entry;
        bf.push({
          i: `${player.id}-p${++player.counter}`,
          k: printing.key,
          s: { x: this._rand(), y: this._rand(), z: bf.length },
        });
        snapshot.counts = {
          hand: Math.max(0, snapshot.counts.hand - 1),
          library: snapshot.counts.library,
        };
        player.handKeys.push(this._pick());
        break;
      }
      case 'kill': {
        const index = Math.floor(this._rng() * bf.length);
        const [dead] = bf.splice(index, 1);
        if (dead) snapshot.zones.graveyard = [...snapshot.zones.graveyard, { i: dead.i, k: dead.k }];
        break;
      }
      case 'life': {
        snapshot.life = Math.max(0, (snapshot.life ?? 40) + (this._rng() < 0.6 ? -this._int(1, 6) : this._int(1, 3)));
        break;
      }
      default:
        break;
    }

    if (this._rng() < 0.08) snapshot.turn = (snapshot.turn || 1) + 1;
    if (this._rng() < 0.15) {
      snapshot.counts = {
        hand: Math.max(0, snapshot.counts.hand + (this._rng() < 0.5 ? -1 : 1)),
        library: Math.max(0, snapshot.counts.library - 1),
      };
    }
    return snapshot;
  }

  _weightedKind() {
    const c = this._config;
    const table = [
      ['move', c.moveWeight], ['tap', c.tapWeight], ['counter', c.counterWeight],
      ['pt', c.ptWeight], ['play', c.playWeight], ['kill', c.killWeight],
      ['life', c.lifeWeight],
    ];
    const total = table.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = this._rng() * total;
    for (const [kind, weight] of table) {
      roll -= weight;
      if (roll <= 0) return kind;
    }
    return 'move';
  }

  _pick() {
    return this._pool[Math.floor(this._rng() * this._pool.length)];
  }

  _sample(list) {
    if (!list.length) return null;
    return list[Math.floor(this._rng() * list.length)];
  }

  _rand() {
    return Math.round(this._rng() * 10000) / 10000;
  }

  _int(min, max) {
    return min + Math.floor(this._rng() * (max - min + 1));
  }

  describe() {
    return {
      running: this.running,
      ticks: this.tickCount,
      poolSize: this._pool.length,
      config: { ...this._config },
      players: this._players.map(p => ({
        id: p.id, rev: p.rev, permanents: p.snapshot.zones.battlefield.length,
      })),
    };
  }
}

function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Text-only fallback cards, used when your own board is empty so there are no
 * printings to borrow. These have no set/cn, so the renderer falls back to its
 * text frame instead of trying to load a bogus image.
 */
function makePlaceholderPool() {
  const specs = [
    ['Grizzly Bears', 'Creature — Bear', '{1}{G}', '2', '2', ''],
    ['Serra Angel', 'Creature — Angel', '{3}{W}{W}', '4', '4', 'Flying, vigilance'],
    ['Llanowar Elves', 'Creature — Elf Druid', '{G}', '1', '1', '{T}: Add {G}.'],
    ['Sol Ring', 'Artifact', '{1}', null, null, '{T}: Add {C}{C}.'],
    ['Wrath of God', 'Sorcery', '{2}{W}{W}', null, null, 'Destroy all creatures.'],
    ['Island', 'Basic Land — Island', '', null, null, '{T}: Add {U}.'],
    ['Forest', 'Basic Land — Forest', '', null, null, '{T}: Add {G}.'],
    ['Shivan Dragon', 'Creature — Dragon', '{4}{R}{R}', '5', '5', 'Flying. {R}: +1/+0.'],
  ];
  return specs.map(([n, t, m, p, g, o], i) => ({
    key: `sim-placeholder-${i}`,
    entry: { n, t, m, o, ...(p ? { p } : {}), ...(g ? { g } : {}) },
  }));
}
