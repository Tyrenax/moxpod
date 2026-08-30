// MoxPod tracer — the dev-time nervous system.
//
// Everything interesting that happens (local game events, every WebSocket
// frame in and out, board diffs, render passes, errors) lands here as a
// structured record in a ring buffer. The debug panel reads it, and a bug
// report is one "Export" click away.
//
// Design rules:
//   * Zero dependencies and no DOM, so it is unit-testable and can be dropped
//     into either content-script world.
//   * Cheap when disabled: `trace()` returns after one boolean check, and
//     payload builders are passed as functions so they are never evaluated
//     unless tracing is actually on.
//   * Never throws. A broken tracer must not break a game in progress.

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Categories, used for filtering in the panel. */
export const CATEGORIES = [
  'net',       // WebSocket frames, connection lifecycle
  'board',     // snapshot capture, diff, apply
  'game',      // local Moxfield events
  'ui',        // panel rendering, tab switches
  'sim',       // simulator / mock opponents
  'perf',      // timings
  'sys',       // lifecycle, config, errors
];

const DEFAULT_CAPACITY = 2000;

export class Tracer {
  constructor(options = {}) {
    this.capacity = options.capacity || DEFAULT_CAPACITY;
    this.enabled = options.enabled ?? false;
    this.minLevel = LEVELS[options.minLevel] || LEVELS.debug;
    this.mirrorToConsole = options.mirrorToConsole ?? false;
    this._now = options.now || (() => Date.now());
    this._buffer = new Array(this.capacity);
    this._head = 0;
    this._size = 0;
    this._seq = 0;
    this._listeners = new Set();
    this._counters = new Map();
    this._rates = new Map();
    this._marks = new Map();
    this._mutedCategories = new Set();
    this.startedAt = this._now();
  }

  // ── Configuration ─────────────────────────────────────────────────

  setEnabled(on) {
    this.enabled = !!on;
    this._emitMeta();
  }

  setMinLevel(name) {
    this.minLevel = LEVELS[name] || LEVELS.debug;
    this._emitMeta();
  }

  muteCategory(category, muted = true) {
    if (muted) this._mutedCategories.add(category);
    else this._mutedCategories.delete(category);
    this._emitMeta();
  }

  isMuted(category) {
    return this._mutedCategories.has(category);
  }

  // ── Recording ─────────────────────────────────────────────────────

  /**
   * Record one event.
   *
   * @param {string} category  one of CATEGORIES
   * @param {string} event     short stable identifier, e.g. 'ws:send'
   * @param {object|function} [payload]  data, or a thunk returning data
   * @param {string} [level]   debug | info | warn | error
   */
  trace(category, event, payload, level = 'debug') {
    const levelValue = LEVELS[level] || LEVELS.debug;
    // Errors and warnings are always recorded, even with tracing off, so a
    // release build still has something useful to show when a friend reports
    // "it broke".
    if (!this.enabled && levelValue < LEVELS.warn) return;
    if (levelValue < this.minLevel) return;
    if (this._mutedCategories.has(category) && levelValue < LEVELS.warn) return;

    let data = payload;
    try {
      if (typeof payload === 'function') data = payload();
    } catch (err) {
      data = { traceError: String(err && err.message) };
    }

    const record = {
      seq: ++this._seq,
      t: this._now(),
      category,
      event,
      level,
      data: safeClone(data),
    };

    this._buffer[this._head] = record;
    this._head = (this._head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;

    if (this.mirrorToConsole) {
      const fn = level === 'error' ? console.error
        : level === 'warn' ? console.warn : console.log;
      fn(`[MoxPod:${category}] ${event}`, record.data ?? '');
    }

    for (const listener of this._listeners) {
      try { listener(record); } catch { /* a bad listener must not break tracing */ }
    }
  }

  debug(category, event, payload) { this.trace(category, event, payload, 'debug'); }
  info(category, event, payload) { this.trace(category, event, payload, 'info'); }
  warn(category, event, payload) { this.trace(category, event, payload, 'warn'); }

  error(category, event, payload) {
    this.count(`error:${category}`);
    this.trace(category, event, payload, 'error');
  }

  /** Record a thrown error with its stack. */
  capture(category, event, err, extra = {}) {
    this.error(category, event, {
      message: err?.message || String(err),
      stack: typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 6) : null,
      ...extra,
    });
  }

  // ── Counters and rates ────────────────────────────────────────────

  count(name, delta = 1) {
    this._counters.set(name, (this._counters.get(name) || 0) + delta);
  }

  /** Sliding one-second rate, for the msg/s and bytes/s readouts. */
  rate(name, value = 1) {
    const now = this._now();
    let entry = this._rates.get(name);
    if (!entry) {
      entry = { samples: [] };
      this._rates.set(name, entry);
    }
    entry.samples.push({ t: now, value });
    const cutoff = now - 5000;
    while (entry.samples.length && entry.samples[0].t < cutoff) entry.samples.shift();
  }

  getRate(name, windowMs = 1000) {
    const entry = this._rates.get(name);
    if (!entry || !entry.samples.length) return 0;
    const cutoff = this._now() - windowMs;
    let total = 0;
    for (const sample of entry.samples) {
      if (sample.t >= cutoff) total += sample.value;
    }
    return total / (windowMs / 1000);
  }

  // ── Timing ────────────────────────────────────────────────────────

  markStart(name) {
    this._marks.set(name, this._now());
  }

  markEnd(name, category = 'perf', extra = {}) {
    const started = this._marks.get(name);
    if (started === undefined) return null;
    this._marks.delete(name);
    const ms = this._now() - started;
    this.trace(category, `timing:${name}`, { ms, ...extra });
    this.rate(`ms:${name}`, ms);
    return ms;
  }

  /** Wrap a function so every call is timed and thrown errors are captured. */
  instrument(name, fn, category = 'perf') {
    const self = this;
    return function instrumented(...args) {
      self.markStart(name);
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then(
            (value) => { self.markEnd(name, category); return value; },
            (err) => { self.markEnd(name, category); self.capture(category, `${name}:threw`, err); throw err; },
          );
        }
        self.markEnd(name, category);
        return result;
      } catch (err) {
        self.markEnd(name, category);
        self.capture(category, `${name}:threw`, err);
        throw err;
      }
    };
  }

  // ── Reading ───────────────────────────────────────────────────────

  onRecord(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  /** Records oldest-first, optionally filtered. */
  records({ category = null, level = null, search = null, limit = Infinity } = {}) {
    const out = [];
    const start = this._size < this.capacity ? 0 : this._head;
    const minLevel = level ? LEVELS[level] || 0 : 0;
    for (let i = 0; i < this._size; i++) {
      const record = this._buffer[(start + i) % this.capacity];
      if (!record) continue;
      if (category && record.category !== category) continue;
      if (minLevel && (LEVELS[record.level] || 0) < minLevel) continue;
      if (search) {
        const haystack = `${record.event} ${JSON.stringify(record.data ?? '')}`.toLowerCase();
        if (!haystack.includes(search.toLowerCase())) continue;
      }
      out.push(record);
    }
    return out.length > limit ? out.slice(-limit) : out;
  }

  counters() {
    return Object.fromEntries(this._counters);
  }

  clear() {
    this._buffer = new Array(this.capacity);
    this._head = 0;
    this._size = 0;
    this._counters.clear();
    this._rates.clear();
    this.startedAt = this._now();
  }

  /**
   * A self-contained bug report: environment, counters, and the full ring
   * buffer. This is what you ask a friend to send you when something breaks.
   */
  exportReport(extra = {}) {
    return {
      tool: 'MoxPod',
      exportedAt: new Date(this._now()).toISOString(),
      uptimeMs: this._now() - this.startedAt,
      environment: describeEnvironment(),
      counters: this.counters(),
      config: {
        enabled: this.enabled,
        minLevel: Object.keys(LEVELS).find(k => LEVELS[k] === this.minLevel),
        muted: [...this._mutedCategories],
        capacity: this.capacity,
      },
      ...extra,
      records: this.records(),
    };
  }

  _emitMeta() {
    this.trace('sys', 'tracer:config', {
      enabled: this.enabled,
      minLevel: this.minLevel,
      muted: [...this._mutedCategories],
    }, 'info');
  }
}

/**
 * Structured-clone-safe deep copy with a depth cap. Game state contains React
 * fibers and circular references; serialising one of those into the log would
 * hang the tab.
 */
function safeClone(value, depth = 0) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'function') return '[function]';
  if (type === 'symbol' || type === 'bigint') return String(value);
  if (depth > 6) return '[depth limit]';
  if (Array.isArray(value)) {
    const capped = value.length > 200 ? value.slice(0, 200) : value;
    const out = capped.map(item => safeClone(item, depth + 1));
    if (value.length > 200) out.push(`…${value.length - 200} more`);
    return out;
  }
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack?.split('\n').slice(0, 6) };
  }
  if (type === 'object') {
    // Anything React-ish or DOM-ish is summarised, never walked.
    if (typeof Node !== 'undefined' && value instanceof Node) {
      return `[${value.nodeName}]`;
    }
    const out = {};
    let keys = 0;
    for (const key of Object.keys(value)) {
      if (key.startsWith('__react') || key === 'stateNode' || key === '_owner') continue;
      if (++keys > 60) { out['…'] = 'truncated'; break; }
      try { out[key] = safeClone(value[key], depth + 1); }
      catch { out[key] = '[unreadable]'; }
    }
    return out;
  }
  return String(value);
}

function describeEnvironment() {
  const env = {};
  try {
    env.userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : null;
    env.url = typeof location !== 'undefined' ? location.href : null;
    env.viewport = typeof window !== 'undefined'
      ? { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }
      : null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) {
      const manifest = chrome.runtime.getManifest();
      env.extension = { name: manifest.name, version: manifest.version };
    }
  } catch { /* best effort only */ }
  return env;
}

/** The process-wide tracer. */
export const tracer = new Tracer();
