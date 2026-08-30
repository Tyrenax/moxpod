// Outbound board-sync batcher.
//
// WHY THIS EXISTS
// ---------------
// Upstream MoxMox sends one WebSocket frame per changed card. One untap step
// on six permanents is six frames, and the relay's token bucket (5 tokens,
// refilled 5/sec -- see server/src/index.js) rejects the overflow and puts the
// client into a 250 ms throttle. In a four-player Commander pod that happens
// constantly.
//
// So we never send per-change. We mark the board dirty, coalesce every change
// inside a flush window into ONE frame, and spend at most one token per flush.
// A 350 ms window is ~2.9 frames/sec, which leaves headroom for life-sync and
// hand-count-sync to keep flowing on the same bucket.
//
// The clock and the send function are injected so this is fully testable
// without a browser or a socket (see tests/board-batcher.test.js).

import { diffSnapshots, wireSize } from './serialize.js';
import { ACTION_FULL, ACTION_DELTA } from './protocol.js';

export const DEFAULTS = {
  flushMs: 350,
  // Re-send a full snapshot periodically so a spectator who joined late, or
  // who dropped a frame, self-heals without anyone noticing.
  keyframeMs: 15000,
  // Deliberately below the relay's 5/sec so life and hand-count still fit.
  bucketCapacity: 3,
  bucketRefillPerSec: 2.5,
  // Above this, a delta is no cheaper than a full snapshot, so send the full
  // one and reset the baseline -- it is more robust for the same bytes.
  deltaFullRatio: 0.8,
  maxFrameBytes: 60000,
};

export class BoardBatcher {
  /**
   * @param {object} options
   * @param {() => object|null} options.capture  builds a fresh wire snapshot
   * @param {(msg: object) => void} options.send  delivers one frame
   * @param {() => number} [options.now]          injectable clock, ms
   * @param {(fn, ms) => any} [options.setTimer]
   * @param {(handle) => void} [options.clearTimer]
   * @param {(event: object) => void} [options.onTrace]
   */
  constructor(options) {
    const config = { ...DEFAULTS, ...(options.config || {}) };
    this._config = config;
    this._capture = options.capture;
    this._send = options.send;
    this._now = options.now || (() => Date.now());
    this._setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = options.clearTimer || (handle => clearTimeout(handle));
    this._onTrace = options.onTrace || (() => {});

    this._rev = 0;
    this._lastSent = null;       // last snapshot the peers are known to hold
    this._dirty = false;
    this._timer = null;
    this._running = false;
    this._lastKeyframeAt = 0;
    this._forceFull = false;

    this._tokens = config.bucketCapacity;
    this._lastRefill = this._now();

    this.stats = {
      flushes: 0, fullsSent: 0, deltasSent: 0, skipped: 0,
      throttleWaits: 0, bytesSent: 0, largestFrame: 0,
    };
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._forceFull = true;
    this.markDirty();
  }

  stop() {
    this._running = false;
    this._dirty = false;
    this._forceFull = false;
    this._lastSent = null;
    if (this._timer !== null) {
      this._clearTimer(this._timer);
      this._timer = null;
    }
  }

  /** Called on every local game event. Cheap: just arms the flush timer. */
  markDirty() {
    if (!this._running) return;
    this._dirty = true;
    this._arm();
  }

  /**
   * Force a full snapshot on the next flush. Used when a spectator joins, asks
   * for a resync, or reports a revision gap.
   */
  requestFull() {
    if (!this._running) return;
    this._forceFull = true;
    this._dirty = true;
    this._arm();
  }

  _arm() {
    if (this._timer !== null) return;
    const wait = Math.max(this._config.flushMs, this._msUntilToken());
    this._timer = this._setTimer(() => {
      this._timer = null;
      this.flush();
    }, wait);
  }

  /** Milliseconds until at least one token is available. */
  _msUntilToken() {
    this._refill();
    if (this._tokens >= 1) return 0;
    const missing = 1 - this._tokens;
    return Math.ceil((missing / this._config.bucketRefillPerSec) * 1000);
  }

  _refill() {
    const now = this._now();
    const elapsed = (now - this._lastRefill) / 1000;
    if (elapsed <= 0) return;
    this._lastRefill = now;
    this._tokens = Math.min(
      this._config.bucketCapacity,
      this._tokens + elapsed * this._config.bucketRefillPerSec,
    );
  }

  /** Give a token back when a flush turned out to have nothing to send. */
  _refund() {
    this._tokens = Math.min(this._config.bucketCapacity, this._tokens + 1);
  }

  _takeToken() {
    this._refill();
    if (this._tokens < 1) return false;
    this._tokens -= 1;
    return true;
  }

  /**
   * Build and send the pending frame, if any. Safe to call directly (tests,
   * or an explicit "resync now" from the debug panel).
   */
  flush() {
    if (!this._running || !this._dirty) return null;

    if (!this._takeToken()) {
      this.stats.throttleWaits++;
      this._onTrace({ kind: 'board:throttled', wait: this._msUntilToken() });
      this._arm();
      return null;
    }

    this.stats.flushes++;

    let next;
    try {
      next = this._capture();
    } catch (err) {
      this._onTrace({ kind: 'board:capture-failed', error: err.message });
      this._refund();
      this._dirty = false;
      return null;
    }
    if (!next) {
      // The board reader is still in flight (the first read crosses into the
      // MAIN world asynchronously). Refund, or a slow read would starve the
      // bucket that life-sync shares.
      this._refund();
      this._dirty = false;
      return null;
    }

    this._rev += 1;
    next.rev = this._rev;

    const now = this._now();
    const keyframeDue = now - this._lastKeyframeAt >= this._config.keyframeMs;
    const wantFull = this._forceFull || keyframeDue || !this._lastSent;

    let message = null;
    if (wantFull) {
      message = { action: ACTION_FULL, snapshot: next };
    } else {
      const result = diffSnapshots(this._lastSent, next);
      if (!result) {
        // Nothing actually moved. Refund the token: an idle board must not
        // starve the bucket that life-sync shares.
        this._refund();
        this._rev -= 1;
        this._dirty = false;
        this.stats.skipped++;
        return null;
      }
      if (result.full) {
        message = { action: ACTION_FULL, snapshot: next };
      } else {
        const deltaBytes = wireSize(result.delta);
        const fullBytes = wireSize(next);
        message = deltaBytes > fullBytes * this._config.deltaFullRatio
          ? { action: ACTION_FULL, snapshot: next }
          : { action: ACTION_DELTA, delta: result.delta };
      }
    }

    const bytes = wireSize(message);
    if (bytes > this._config.maxFrameBytes && message.action === ACTION_DELTA) {
      // Should not happen, but never let a delta exceed the relay frame cap.
      message = { action: ACTION_FULL, snapshot: next };
    }

    this._dirty = false;
    this._forceFull = false;
    this._lastSent = next;
    if (message.action === ACTION_FULL) {
      this._lastKeyframeAt = now;
      this.stats.fullsSent++;
    } else {
      this.stats.deltasSent++;
    }
    this.stats.bytesSent += bytes;
    this.stats.largestFrame = Math.max(this.stats.largestFrame, bytes);

    this._onTrace({
      kind: 'board:sent', action: message.action, rev: next.rev, bytes,
    });
    this._send(message);
    return message;
  }

  /**
   * The most recent snapshot peers are known to hold. The simulator borrows
   * its card printings from this so fake opponents show real cards.
   */
  lastSnapshot() {
    return this._lastSent;
  }

  /** Diagnostics for the debug panel. */
  describe() {
    this._refill();
    return {
      running: this._running,
      dirty: this._dirty,
      rev: this._rev,
      tokens: Math.round(this._tokens * 100) / 100,
      pendingFull: this._forceFull,
      config: this._config,
      stats: { ...this.stats },
    };
  }
}
