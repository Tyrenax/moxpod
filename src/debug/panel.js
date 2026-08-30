// The MoxPod dev console.
//
// Toggle with Ctrl+Shift+D on any playtest page. It is the thing you use
// while building: watch every frame go by, run fake opponents so you can
// exercise the whole spectator UI alone, provoke the failure modes on demand,
// and export a self-contained report when a friend hits a bug.
//
// Nothing here runs unless the panel is opened, so it costs a mounted-but-
// hidden div in a release build.

import { LEVELS, CATEGORIES } from './tracer.js';

const RELAY_PRESETS = [
  { label: 'Production', url: '' },
  { label: 'Local (8787)', url: 'ws://localhost:8787' },
  { label: 'Local (9000)', url: 'ws://localhost:9000' },
];

let instance = null;

export function mountDebugPanel(deps) {
  if (instance) return instance;
  instance = new DebugPanel(deps);
  instance.install();
  return instance;
}

export function getDebugPanel() {
  return instance;
}

class DebugPanel {
  constructor({ feature, tracer, relayUrl }) {
    this._feature = feature;
    this._tracer = tracer;
    this._relayUrl = relayUrl;
    this._root = null;
    this._open = false;
    this._tab = 'log';
    this._filters = { category: '', level: '', search: '' };
    this._paused = false;
    this._refreshTimer = null;
    this._unsubscribe = null;
  }

  install() {
    window.addEventListener('keydown', (event) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        this.toggle();
      }
    }, true);
    // Console handle: moxpod.sim.start(), moxpod.tracer.records(), ...
    window.moxpod = {
      feature: this._feature,
      tracer: this._tracer,
      sim: this._feature.simulator,
      store: this._feature.store,
      batcher: this._feature.batcher,
      panel: this._feature.panel,
      debug: this,
      help: () => console.log(HELP_TEXT),
    };
    console.log('[MoxPod] dev console ready — Ctrl+Shift+D, or window.moxpod.help()');
  }

  toggle() {
    this._open ? this.close() : this.open();
  }

  open() {
    if (!this._root) this._build();
    this._open = true;
    this._tracer.setEnabled(true);
    this._root.classList.remove('hidden');
    this._refreshTimer = setInterval(() => this._refresh(), 500);
    this._unsubscribe = this._tracer.onRecord(() => {
      if (this._tab === 'log' && !this._paused) this._queueLogRender();
    });
    this._refresh();
  }

  close() {
    this._open = false;
    if (this._root) this._root.classList.add('hidden');
    clearInterval(this._refreshTimer);
    this._refreshTimer = null;
    if (this._unsubscribe) { this._unsubscribe(); this._unsubscribe = null; }
  }

  _build() {
    const root = document.createElement('div');
    root.className = 'moxpod-debug hidden';
    root.innerHTML = `
      <header class="moxpod-debug-head">
        <strong>MoxPod dev</strong>
        <nav class="moxpod-debug-tabs">
          <button data-tab="log">Log</button>
          <button data-tab="stats">Stats</button>
          <button data-tab="sim">Simulateur</button>
          <button data-tab="boards">Boards</button>
          <button data-tab="setup">Setup</button>
        </nav>
        <span class="moxpod-debug-spacer"></span>
        <button data-act="export" title="Exporter un rapport JSON">Export</button>
        <button data-act="clear" title="Vider le log">Vider</button>
        <button data-act="close">✕</button>
      </header>
      <div class="moxpod-debug-body"></div>
      <footer class="moxpod-debug-foot"></footer>
    `;
    document.body.appendChild(root);
    this._root = root;
    this._body = root.querySelector('.moxpod-debug-body');
    this._foot = root.querySelector('.moxpod-debug-foot');

    root.addEventListener('click', e => this._onClick(e));
    root.addEventListener('change', e => this._onChange(e));
    root.addEventListener('input', e => this._onInput(e));
    this._selectTab('log');
  }

  _onClick(event) {
    const target = event.target.closest('[data-tab], [data-act]');
    if (!target) return;
    if (target.dataset.tab) { this._selectTab(target.dataset.tab); return; }

    const sim = this._feature.simulator;
    switch (target.dataset.act) {
      case 'close': this.close(); break;
      case 'clear': this._tracer.clear(); this._refresh(); break;
      case 'export': this._export(); break;
      case 'pause': this._paused = !this._paused; this._refresh(); break;
      case 'sim-start': this._startSim(); break;
      case 'sim-stop': sim.stop(); this._refresh(); break;
      case 'sim-step': sim.step(); this._refresh(); break;
      case 'sim-gap': sim.injectGap(); break;
      case 'sim-unknown': sim.injectUnknownCard(); break;
      case 'panel-toggle': this._feature.togglePanel(); break;
      case 'resync': this._feature.batcher.requestFull(); break;
      case 'probe': this._probeDom(); break;
      case 'relay': this._setRelay(target.dataset.url); break;
      default: break;
    }
  }

  _onChange(event) {
    const target = event.target;
    if (target.dataset.filter) {
      this._filters[target.dataset.filter] = target.value;
      this._refresh();
    }
    if (target.dataset.simcfg) {
      this._feature.simulator.configure({ [target.dataset.simcfg]: Number(target.value) });
    }
  }

  _onInput(event) {
    if (event.target.dataset.filter === 'search') {
      this._filters.search = event.target.value;
      this._queueLogRender();
    }
  }

  _selectTab(tab) {
    this._tab = tab;
    for (const button of this._root.querySelectorAll('[data-tab]')) {
      button.classList.toggle('active', button.dataset.tab === tab);
    }
    this._refresh();
  }

  _queueLogRender() {
    if (this._logQueued) return;
    this._logQueued = true;
    requestAnimationFrame(() => { this._logQueued = false; if (this._open) this._refresh(); });
  }

  _refresh() {
    if (!this._open || !this._root) return;
    switch (this._tab) {
      case 'log': this._renderLog(); break;
      case 'stats': this._renderStats(); break;
      case 'sim': this._renderSim(); break;
      case 'boards': this._renderBoards(); break;
      case 'setup': this._renderSetup(); break;
      default: break;
    }
    this._renderFooter();
  }

  _renderFooter() {
    const inRate = this._tracer.getRate('board:in').toFixed(1);
    const outRate = this._tracer.getRate('board:out').toFixed(1);
    const batcher = this._feature.batcher.describe();
    const errors = Object.entries(this._tracer.counters())
      .filter(([k]) => k.startsWith('error:'))
      .reduce((sum, [, v]) => sum + v, 0);
    this._foot.innerHTML = `
      <span>board in <b>${inRate}/s</b></span>
      <span>out <b>${outRate}/s</b></span>
      <span title="Jetons restants dans le seau (le relais en donne 5/s)">jetons <b>${batcher.tokens}</b></span>
      <span>rev <b>${batcher.rev}</b></span>
      <span class="${errors ? 'bad' : ''}">erreurs <b>${errors}</b></span>
    `;
  }

  _renderLog() {
    const records = this._tracer.records({
      category: this._filters.category || null,
      level: this._filters.level || null,
      search: this._filters.search || null,
      limit: 400,
    });

    this._body.innerHTML = `
      <div class="moxpod-debug-toolbar">
        <select data-filter="category">
          <option value="">toutes catégories</option>
          ${CATEGORIES.map(c => `<option ${this._filters.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
        <select data-filter="level">
          <option value="">tous niveaux</option>
          ${Object.keys(LEVELS).map(l => `<option ${this._filters.level === l ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <input data-filter="search" placeholder="filtrer…" value="${escapeAttr(this._filters.search)}">
        <button data-act="pause">${this._paused ? '▶ reprendre' : '⏸ figer'}</button>
        <span class="moxpod-debug-count">${records.length}</span>
      </div>
      <div class="moxpod-debug-log"></div>
    `;

    const log = this._body.querySelector('.moxpod-debug-log');
    const start = this._tracer.startedAt;
    for (const record of records.slice(-300)) {
      const row = document.createElement('div');
      row.className = `moxpod-log-row ${record.level}`;
      const time = ((record.t - start) / 1000).toFixed(2).padStart(7);
      row.innerHTML = `<i>${time}</i><em>${record.category}</em><b></b><span></span>`;
      row.querySelector('b').textContent = record.event;
      row.querySelector('span').textContent = record.data === undefined
        ? '' : compact(record.data);
      log.appendChild(row);
    }
    if (!this._paused) log.scrollTop = log.scrollHeight;
  }

  _renderStats() {
    const batcher = this._feature.batcher.describe();
    const counters = this._tracer.counters();
    this._body.innerHTML = `
      <div class="moxpod-debug-grid">
        <section>
          <h4>Émission (batcher)</h4>
          ${kv('flushes', batcher.stats.flushes)}
          ${kv('snapshots complets', batcher.stats.fullsSent)}
          ${kv('deltas', batcher.stats.deltasSent)}
          ${kv('flushes à vide évités', batcher.stats.skipped)}
          ${kv('attentes de jeton', batcher.stats.throttleWaits, batcher.stats.throttleWaits > 0)}
          ${kv('octets envoyés', formatBytes(batcher.stats.bytesSent))}
          ${kv('plus grosse frame', formatBytes(batcher.stats.largestFrame),
              batcher.stats.largestFrame > 60000)}
          ${kv('fenêtre de flush', `${batcher.config.flushMs} ms`)}
          ${kv('keyframe', `${batcher.config.keyframeMs / 1000} s`)}
        </section>
        <section>
          <h4>Compteurs</h4>
          ${Object.entries(counters).length
            ? Object.entries(counters).map(([k, v]) => kv(k, v, k.startsWith('error:'))).join('')
            : '<p class="muted">Aucun.</p>'}
        </section>
      </div>
    `;
  }

  _renderSim() {
    const sim = this._feature.simulator;
    const state = sim.describe();
    this._body.innerHTML = `
      <div class="moxpod-debug-pad">
        <p class="muted">
          Génère des adversaires factices qui jouent tout seuls, en passant par
          le vrai chemin encode → diff → apply. C'est ce qui permet de tester
          les onglets, le rendu et les zones sans personne en face.
        </p>
        <div class="moxpod-debug-row">
          <label>Joueurs <select data-simcfg="players">
            ${[1, 2, 3].map(n => `<option ${state.config.players === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select></label>
          <label>Permanents <select data-simcfg="permanents">
            ${[4, 8, 12, 20, 35].map(n => `<option ${state.config.permanents === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select></label>
          <label>Tick (ms) <select data-simcfg="tickMs">
            ${[300, 800, 1500, 3000].map(n => `<option ${state.config.tickMs === n ? 'selected' : ''}>${n}</option>`).join('')}
          </select></label>
          <label>Graine <input type="number" data-simcfg="seed" value="${state.config.seed}" style="width:6em"></label>
        </div>
        <div class="moxpod-debug-row">
          ${state.running
            ? '<button data-act="sim-stop">⏹ Arrêter</button><button data-act="sim-step">⏭ Un tick</button>'
            : '<button data-act="sim-start">▶ Démarrer</button>'}
          <button data-act="sim-gap" ${state.running ? '' : 'disabled'}>Injecter une désync</button>
          <button data-act="sim-unknown" ${state.running ? '' : 'disabled'}>Injecter une carte inconnue</button>
          <button data-act="panel-toggle">Afficher/masquer le panneau</button>
        </div>
        <div class="moxpod-debug-grid">
          <section>
            <h4>État</h4>
            ${kv('en cours', state.running ? 'oui' : 'non')}
            ${kv('ticks', state.ticks)}
            ${kv('impressions dispo', state.poolSize)}
            ${state.players.map(p => kv(p.id, `rev ${p.rev}, ${p.permanents} permanents`)).join('')}
          </section>
        </div>
      </div>
    `;
  }

  _renderBoards() {
    const described = this._feature.store.describe();
    const ids = Object.keys(described);
    this._body.innerHTML = `
      <div class="moxpod-debug-pad">
        <div class="moxpod-debug-row">
          <button data-act="resync">Renvoyer mon board complet</button>
        </div>
        ${ids.length === 0 ? '<p class="muted">Aucun board reçu.</p>' : ''}
        <div class="moxpod-debug-grid">
          ${ids.map(id => `
            <section>
              <h4>${escapeHtml(id)}</h4>
              ${kv('révision', described[id].rev)}
              ${kv('permanents', described[id].permanents)}
              ${kv('impressions connues', described[id].dictSize)}
              ${kv('frames reçues', described[id].frames)}
              ${kv('désyncs', described[id].gaps, described[id].gaps > 0)}
              ${kv('âge', described[id].ageMs == null ? '–' : `${Math.round(described[id].ageMs / 1000)} s`,
                  described[id].ageMs > 8000)}
            </section>
          `).join('')}
        </div>
      </div>
    `;
  }

  _renderSetup() {
    const current = readRelay();
    this._body.innerHTML = `
      <div class="moxpod-debug-pad">
        <h4>Relais</h4>
        <p class="muted">
          Actuellement : <code>${escapeHtml(this._relayUrl)}</code><br>
          Changer recharge la page. Pour tester à deux sessions en local,
          lance <code>npm run relay</code> puis choisis « Local (8787) »
          dans les deux onglets.
        </p>
        <div class="moxpod-debug-row">
          ${RELAY_PRESETS.map(preset => `
            <button data-act="relay" data-url="${preset.url}"
              class="${(current || '') === preset.url ? 'active' : ''}">${preset.label}</button>
          `).join('')}
        </div>
        <h4>Diagnostic</h4>
        <div class="moxpod-debug-row">
          <button data-act="probe">Sonder la mise en page</button>
        </div>
        <p class="muted">
          Écrit dans le log la chaîne d'éléments qui composent le battlefield de
          Moxfield. Utile si le partage d'écran 50/50 ne se cale pas bien après
          une mise à jour de leur site.
        </p>
        <h4>Console</h4>
        <pre class="moxpod-debug-pre">${escapeHtml(HELP_TEXT)}</pre>
      </div>
    `;
  }

  _startSim() {
    const sim = this._feature.simulator;
    // Borrow real printings from the board we last sent, so the fake
    // opponents show real cards from your own deck instead of placeholders.
    const mine = this._feature.batcher.lastSnapshot();
    sim.seed(mine || { dict: {} });
    sim.start();
    this._feature.panel.setVisible(true);
    this._feature.panel.syncRoster();
    this._refresh();
  }

  _setRelay(url) {
    try {
      if (url) localStorage.setItem('moxpod_relay', url);
      else localStorage.removeItem('moxpod_relay');
      location.reload();
    } catch (err) {
      this._tracer.capture('sys', 'relay:switch-failed', err);
    }
  }

  /**
   * Dump the layout chain around Moxfield's battlefield. When their markup
   * changes, this is what tells us which selector the split needs.
   */
  _probeDom() {
    const candidates = [...document.querySelectorAll('div')]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.height > window.innerHeight * 0.3 && rect.width > window.innerWidth * 0.5;
      })
      .slice(0, 12)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 80),
          rect: `${Math.round(rect.width)}x${Math.round(rect.height)} @${Math.round(rect.top)}`,
          position: style.position,
          display: style.display,
          height: style.height,
        };
      });
    this._tracer.info('sys', 'dom:probe', { viewport: `${window.innerWidth}x${window.innerHeight}`, candidates });
    this._selectTab('log');
  }

  _export() {
    const report = this._tracer.exportReport({
      relay: this._relayUrl,
      batcher: this._feature.batcher.describe(),
      boards: this._feature.store.describe(),
      simulator: this._feature.simulator.describe(),
      panelPrefs: this._feature.panel.prefs,
    });
    const text = JSON.stringify(report, null, 2);

    navigator.clipboard?.writeText(text).then(
      () => this._tracer.info('sys', 'report:copied', { bytes: text.length }),
      () => {},
    );
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `moxpod-report-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    } catch (err) {
      this._tracer.capture('sys', 'report:download-failed', err);
    }
  }
}

const HELP_TEXT = `window.moxpod
  .sim.start() / .sim.stop() / .sim.step()   adversaires factices
  .sim.injectGap()                           provoquer une désync
  .store.view('p2')                          board hydraté d'un joueur
  .store.raw('p2')                           snapshot brut reçu
  .batcher.describe()                        stats d'émission
  .batcher.requestFull()                     renvoyer un snapshot complet
  .panel.setVisible(true) / .panel.select('p2')
  .tracer.records({ category: 'board' })
  .tracer.exportReport()`;

function readRelay() {
  try { return localStorage.getItem('moxpod_relay'); } catch { return null; }
}

function kv(key, value, bad = false) {
  return `<div class="moxpod-kv${bad ? ' bad' : ''}"><span>${escapeHtml(String(key))}</span><b>${escapeHtml(String(value))}</b></div>`;
}

function compact(data) {
  if (typeof data === 'string') return data;
  try {
    const text = JSON.stringify(data);
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  } catch { return '[unserialisable]'; }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, '&#39;');
}
