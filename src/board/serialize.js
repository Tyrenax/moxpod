// Board snapshot encoding, diffing and delta application.
//
// Pure functions only -- no DOM, no chrome APIs, no network. Everything here
// is unit-testable in isolation (see tests/board-serialize.test.js), which is
// what lets us verify the sync layer without three friends and four browsers.

import {
  BOARD_PROTOCOL_VERSION, MIRRORED_ZONES, STATE_KEYS, DICT_KEYS,
  PLAYER_COUNTERS, OP_UPSERT, OP_REMOVE, OP_ZONE, dictKeyForCard,
} from './protocol.js';

const STATE_WIRE_KEYS = Object.keys(STATE_KEYS);

// ── Encoding (sender side) ──────────────────────────────────────────

/**
 * Convert a battlefield card's pixel position into a resolution-independent
 * fraction of the battlefield. The spectator panel is a different size than
 * the owner's window, so absolute pixels are meaningless across clients.
 *
 * We use the card's *centre* rather than its top-left so cards stay visually
 * anchored when the two clients render at different card sizes.
 */
function encodePosition(card, geometry) {
  const g = geometry || {};
  const cardW = g.cardW || 0;
  const cardH = g.cardH || 0;
  const centreX = (card.left ?? 0) + cardW / 2;
  const centreY = (card.top ?? 0) + cardH / 2;
  return {
    x: g.usableWidth > 0 ? clamp01(centreX / g.usableWidth) : 0.5,
    y: g.height > 0 ? clamp01(centreY / g.height) : 0.5,
  };
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * Moxfield's `counters` is a plain number on a fresh permanent, but the gift
 * path upstream also handles it as a map of counter kind -> count, and we have
 * seen both. Normalise to a canonical form so:
 *   * the badge never renders "[object Object]", and
 *   * diffing compares by value, not by object identity, which would otherwise
 *     emit a delta for every countered card on every single flush.
 * Returns a number when there is one kind, or a key-sorted map otherwise.
 */
export function normaliseCounters(value) {
  if (!value) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'object') return 0;

  const entries = Object.entries(value)
    .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) !== 0)
    .map(([kind, count]) => [kind, Number(count)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  if (entries.length === 0) return 0;
  return Object.fromEntries(entries);
}

/** Total number of counters, whatever shape they arrived in. */
export function countersTotal(value) {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/** Compact volatile state for one battlefield card. Default values are omitted. */
export function encodeCardState(card, geometry) {
  const out = {};
  const pos = encodePosition(card, geometry);
  out.x = round(pos.x, 4);
  out.y = round(pos.y, 4);
  for (const key of STATE_WIRE_KEYS) {
    if (key === 'x' || key === 'y') continue;
    let value = card[STATE_KEYS[key]];
    if (key === 'c') value = normaliseCounters(value);
    if (value === undefined || value === null || value === false || value === 0) continue;
    out[key] = value === true ? 1 : value;
  }
  return out;
}

/** Compact immutable data for one printing. */
export function encodeDictEntry(card) {
  const out = {};
  for (const [wire, prop] of Object.entries(DICT_KEYS)) {
    const value = card[prop];
    if (value === undefined || value === null || value === '' || value === false) continue;
    out[wire] = value === true ? 1 : value;
  }
  // Double-faced cards need both faces for the detail view and the image URL.
  if (Array.isArray(card.card_faces) && card.card_faces.length > 1) {
    out.d = card.card_faces.slice(0, 2).map(face => ({
      n: face.name, t: face.type_line, m: face.mana_cost,
      o: face.oracle_text, p: face.power, g: face.toughness,
    }));
  }
  return out;
}

/**
 * Build a complete wire snapshot from raw Moxfield zone arrays.
 *
 * @param {object} input
 * @param {object} input.zones     raw Moxfield card arrays, keyed by zone name
 * @param {object} input.geometry  battlefield size, from _getBattlefieldSize()
 * @param {number} input.life
 * @param {number} input.turn
 * @param {object} input.counters  poison/energy/... player counters
 * @param {object} input.counts    { library, hand }
 * @param {number} input.rev       monotonic revision, set by the caller
 */
export function encodeSnapshot(input) {
  const { zones = {}, geometry = {}, counters = {}, counts = {} } = input;
  const dict = {};
  const out = {
    v: BOARD_PROTOCOL_VERSION,
    rev: input.rev || 0,
    life: input.life ?? null,
    turn: input.turn ?? null,
    counts: { library: counts.library || 0, hand: counts.hand || 0 },
    counters: {},
    zones: {},
    dict,
  };

  for (const name of PLAYER_COUNTERS) {
    const value = counters[name];
    if (value) out.counters[name] = value;
  }

  for (const zone of MIRRORED_ZONES) {
    const cards = Array.isArray(zones[zone]) ? zones[zone] : [];
    if (zone === 'battlefield') {
      out.zones.battlefield = cards.map((card) => {
        const key = dictKeyForCard(card);
        if (!dict[key]) dict[key] = encodeDictEntry(card);
        return { i: String(card.zoneId), k: key, s: encodeCardState(card, geometry) };
      });
    } else {
      out.zones[zone] = cards.map((card) => {
        const key = dictKeyForCard(card);
        if (!dict[key]) dict[key] = encodeDictEntry(card);
        return { i: String(card.zoneId), k: key };
      });
    }
  }

  return out;
}

// ── Diffing (sender side) ───────────────────────────────────────────

/**
 * Produce the smallest delta that turns `prev` into `next`.
 *
 * Battlefield changes are per-card ops carrying only the keys that moved.
 * The small ordered zones (graveyard/exile/command) are cheap enough to send
 * whole whenever they change at all, which sidesteps a whole class of
 * insert/reorder bugs for a handful of bytes.
 *
 * Returns null when nothing changed, so the batcher can skip the send.
 */
export function diffSnapshots(prev, next) {
  if (!prev) return { full: next };

  const ops = [];
  const dict = {};

  const prevBf = indexById(prev.zones?.battlefield);
  const nextBf = indexById(next.zones?.battlefield);

  for (const [zoneId, entry] of nextBf) {
    const before = prevBf.get(zoneId);
    if (!before) {
      ops.push({ o: OP_UPSERT, i: zoneId, k: entry.k, z: 'battlefield', s: entry.s });
      if (next.dict[entry.k] && !prev.dict?.[entry.k]) dict[entry.k] = next.dict[entry.k];
      continue;
    }
    const changed = diffState(before.s, entry.s);
    const printingChanged = before.k !== entry.k;
    if (changed || printingChanged) {
      ops.push({
        o: OP_UPSERT, i: zoneId, k: entry.k, z: 'battlefield', s: changed || {},
      });
    }
    // A card can change printing in place (a transform, a copy effect). The
    // receiver would render "Unknown card" until the next keyframe unless we
    // ship the new dictionary entry along with it.
    if (printingChanged && next.dict[entry.k] && !prev.dict?.[entry.k]) {
      dict[entry.k] = next.dict[entry.k];
    }
  }

  for (const zoneId of prevBf.keys()) {
    if (!nextBf.has(zoneId)) ops.push({ o: OP_REMOVE, i: zoneId });
  }

  for (const zone of MIRRORED_ZONES) {
    if (zone === 'battlefield') continue;
    const before = prev.zones?.[zone] || [];
    const after = next.zones?.[zone] || [];
    if (sameSequence(before, after)) continue;
    ops.push({ o: OP_ZONE, z: zone, c: after.map(e => [e.i, e.k]) });
    for (const entry of after) {
      if (next.dict[entry.k] && !prev.dict?.[entry.k]) dict[entry.k] = next.dict[entry.k];
    }
  }

  const delta = { v: BOARD_PROTOCOL_VERSION, rev: next.rev, base: prev.rev };
  if (ops.length) delta.ops = ops;
  if (Object.keys(dict).length) delta.dict = dict;
  if (prev.life !== next.life) delta.life = next.life;
  if (prev.turn !== next.turn) delta.turn = next.turn;
  if (prev.counts?.library !== next.counts.library ||
      prev.counts?.hand !== next.counts.hand) {
    delta.counts = next.counts;
  }
  if (JSON.stringify(prev.counters || {}) !== JSON.stringify(next.counters)) {
    delta.counters = next.counters;
  }

  const hasPayload = delta.ops || delta.dict || 'life' in delta || 'turn' in delta ||
    'counts' in delta || 'counters' in delta;
  return hasPayload ? { delta } : null;
}

function indexById(list) {
  const map = new Map();
  for (const entry of list || []) map.set(entry.i, entry);
  return map;
}

/** Returns the subset of `next` that differs from `prev`, or null. */
function diffState(prev = {}, next = {}) {
  const changed = {};
  let dirty = false;
  for (const key of STATE_WIRE_KEYS) {
    const a = prev[key];
    const b = next[key];
    if (a === b) continue;
    // Counters can be a map. Compare by value, or two equal maps would look
    // different every flush and spam a delta per countered card.
    if (typeof a === 'object' || typeof b === 'object') {
      if (JSON.stringify(a ?? 0) === JSON.stringify(b ?? 0)) continue;
      changed[key] = b ?? 0;
      dirty = true;
      continue;
    }
    // An omitted key means "default" (0/false); normalise before comparing so
    // a card returning to its default still emits an explicit reset.
    if ((a ?? 0) === (b ?? 0)) continue;
    changed[key] = b ?? 0;
    dirty = true;
  }
  return dirty ? changed : null;
}

function sameSequence(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].i !== b[i].i || a[i].k !== b[i].k) return false;
  }
  return true;
}

// ── Applying (receiver side) ────────────────────────────────────────

/** An empty snapshot, used as the base for a player we have not heard from. */
export function emptySnapshot() {
  return {
    v: BOARD_PROTOCOL_VERSION, rev: 0, life: null, turn: null,
    counts: { library: 0, hand: 0 }, counters: {},
    zones: { battlefield: [], graveyard: [], exile: [], command: [] },
    dict: {},
  };
}

/**
 * Apply a delta to a snapshot, returning a NEW snapshot (the input is never
 * mutated, so the UI can diff old against new).
 *
 * Returns { snapshot, gap } where `gap` is true when the delta's `base` does
 * not match the revision we hold -- meaning we dropped a message and should
 * ask the owner for a fresh full snapshot.
 */
export function applyDelta(snapshot, delta) {
  const base = snapshot || emptySnapshot();
  const gap = delta.base !== undefined && delta.base !== base.rev;

  const next = {
    ...base,
    rev: delta.rev ?? base.rev,
    dict: delta.dict ? { ...base.dict, ...delta.dict } : base.dict,
    counts: delta.counts ? { ...delta.counts } : base.counts,
    counters: delta.counters ? { ...delta.counters } : base.counters,
    zones: { ...base.zones },
  };
  if ('life' in delta) next.life = delta.life;
  if ('turn' in delta) next.turn = delta.turn;

  if (delta.ops?.length) {
    const battlefield = [...(base.zones.battlefield || [])];
    const index = new Map(battlefield.map((entry, i) => [entry.i, i]));
    const removed = new Set();

    for (const op of delta.ops) {
      if (op.o === OP_UPSERT && op.z === 'battlefield') {
        const at = index.get(op.i);
        if (at === undefined) {
          index.set(op.i, battlefield.length);
          battlefield.push({ i: op.i, k: op.k, s: { ...op.s } });
        } else {
          battlefield[at] = {
            ...battlefield[at],
            k: op.k || battlefield[at].k,
            s: { ...battlefield[at].s, ...op.s },
          };
          removed.delete(op.i);
        }
      } else if (op.o === OP_REMOVE) {
        if (index.has(op.i)) removed.add(op.i);
      } else if (op.o === OP_ZONE) {
        next.zones[op.z] = (op.c || []).map(([i, k]) => ({ i, k }));
      }
    }

    next.zones.battlefield = removed.size
      ? battlefield.filter(entry => !removed.has(entry.i))
      : battlefield;
  }

  return { snapshot: next, gap };
}

// ── Reading (UI side) ───────────────────────────────────────────────

/**
 * Turn a wire entry plus the dictionary into a friendly object for rendering.
 * A missing dictionary entry degrades to a placeholder rather than throwing,
 * because one dropped `dict` should never blank the whole board.
 */
export function hydrateCard(entry, dict) {
  const meta = dict?.[entry.k] || {};
  const state = entry.s || {};
  const faces = (meta.d || []).map(face => ({
    name: face.n, typeLine: face.t, manaCost: face.m,
    oracleText: face.o, power: face.p, toughness: face.g,
  }));
  return {
    zoneId: entry.i,
    key: entry.k,
    name: meta.n || 'Unknown card',
    set: meta.s || null,
    cn: meta.c || null,
    layout: meta.y || 'normal',
    typeLine: meta.t || '',
    manaCost: meta.m || '',
    oracleText: meta.o || '',
    power: meta.p ?? null,
    toughness: meta.g ?? null,
    isToken: !!meta.k,
    faces,
    known: !!dict?.[entry.k],
    // Volatile state, normalised back to real booleans/numbers.
    x: state.x ?? 0.5,
    y: state.y ?? 0.5,
    zIndex: state.z || 0,
    tapped: !!state.t,
    flipped: !!state.f,
    rotated: !!state.r,
    doesntUntap: !!state.u,
    counters: countersTotal(state.c),
    // Present only when the owner has several kinds of counter, for the tooltip.
    counterDetail: state.c && typeof state.c === 'object' ? state.c : null,
    adjustedPower: state.p || 0,
    adjustedToughness: state.g || 0,
    adjustedLoyalty: state.l || 0,
  };
}

/** Rough byte cost of a message, used to pick delta vs full snapshot. */
export function wireSize(value) {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
}
