// Inbound board state, one snapshot per remote player.
//
// The store is deliberately dumb about the network: it takes decoded frames,
// keeps the authoritative snapshot per player, and hands the UI a hydrated
// view. It never touches the local Moxfield state -- spectating is read-only.

import { emptySnapshot, applyDelta, hydrateCard } from './serialize.js';
import { BROWSABLE_ZONES } from './protocol.js';

export class RemoteBoardStore {
  /**
   * @param {object} [options]
   * @param {(playerId: string) => void} [options.onChange]
   * @param {(playerId: string, reason: string) => void} [options.onResyncNeeded]
   * @param {(event: object) => void} [options.onTrace]
   * @param {() => number} [options.now]
   */
  constructor(options = {}) {
    this._boards = new Map();   // playerId -> { snapshot, updatedAt, gaps, frames }
    this._onChange = options.onChange || (() => {});
    this._onResyncNeeded = options.onResyncNeeded || (() => {});
    this._onTrace = options.onTrace || (() => {});
    this._now = options.now || (() => Date.now());
  }

  /** Replace a player's board wholesale. Always safe -- cannot desync. */
  ingestFull(playerId, snapshot) {
    if (!playerId || !snapshot) return;
    const entry = this._entry(playerId);
    entry.snapshot = snapshot;
    entry.updatedAt = this._now();
    entry.frames++;
    this._onTrace({
      kind: 'board:recv-full', playerId, rev: snapshot.rev,
      permanents: snapshot.zones?.battlefield?.length || 0,
    });
    this._onChange(playerId);
  }

  /**
   * Apply an incremental update. If the delta's base revision does not match
   * what we hold we dropped a frame, so we keep the stale board on screen
   * (better than blanking it) and ask the owner to re-send a full snapshot.
   */
  ingestDelta(playerId, delta) {
    if (!playerId || !delta) return;
    const entry = this._entry(playerId);
    const { snapshot, gap } = applyDelta(entry.snapshot, delta);
    entry.frames++;

    if (gap) {
      entry.gaps++;
      this._onTrace({
        kind: 'board:gap', playerId, expected: entry.snapshot?.rev, got: delta.base,
      });
      this._onResyncNeeded(playerId, 'revision-gap');
      return;
    }

    entry.snapshot = snapshot;
    entry.updatedAt = this._now();
    this._onTrace({
      kind: 'board:recv-delta', playerId, rev: delta.rev, ops: delta.ops?.length || 0,
    });
    this._onChange(playerId);
  }

  _entry(playerId) {
    let entry = this._boards.get(playerId);
    if (!entry) {
      entry = { snapshot: emptySnapshot(), updatedAt: 0, gaps: 0, frames: 0 };
      this._boards.set(playerId, entry);
    }
    return entry;
  }

  has(playerId) {
    return this._boards.has(playerId);
  }

  /** Raw wire snapshot, for the debug panel's JSON inspector. */
  raw(playerId) {
    return this._boards.get(playerId)?.snapshot || null;
  }

  playerIds() {
    return [...this._boards.keys()];
  }

  forget(playerId) {
    this._boards.delete(playerId);
  }

  clear() {
    this._boards.clear();
  }

  /**
   * Hydrated, render-ready view of one player's board. Returns null when we
   * have never heard from them, so the UI can show "waiting for board".
   */
  view(playerId) {
    const entry = this._boards.get(playerId);
    if (!entry || !entry.updatedAt) return null;
    const snap = entry.snapshot;
    const dict = snap.dict || {};

    const battlefield = (snap.zones?.battlefield || [])
      .map(item => hydrateCard(item, dict))
      .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    const zones = {};
    for (const zone of BROWSABLE_ZONES) {
      zones[zone] = (snap.zones?.[zone] || []).map(item => hydrateCard(item, dict));
    }

    return {
      playerId,
      rev: snap.rev,
      life: snap.life,
      turn: snap.turn,
      counters: snap.counters || {},
      handCount: snap.counts?.hand || 0,
      libraryCount: snap.counts?.library || 0,
      battlefield,
      zones,
      updatedAt: entry.updatedAt,
      staleMs: this._now() - entry.updatedAt,
      gaps: entry.gaps,
      frames: entry.frames,
      unknownCards: battlefield.filter(c => !c.known).length,
    };
  }

  /** Per-player counters for the debug panel. */
  describe() {
    const out = {};
    for (const [playerId, entry] of this._boards) {
      out[playerId] = {
        rev: entry.snapshot?.rev || 0,
        permanents: entry.snapshot?.zones?.battlefield?.length || 0,
        dictSize: Object.keys(entry.snapshot?.dict || {}).length,
        frames: entry.frames,
        gaps: entry.gaps,
        ageMs: entry.updatedAt ? this._now() - entry.updatedAt : null,
      };
    }
    return out;
  }
}
