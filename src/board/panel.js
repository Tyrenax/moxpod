// The spectator panel.
//
// Renders one opponent's board at a time in a split above your own playtest
// area. Everything here is our own DOM -- we never write a remote card into
// the local Moxfield state, so a sync bug can corrupt the view but never your
// game.
//
// UX contract:
//   * One opponent in focus, full width. Tabs (or arrow keys / 1-4) switch.
//   * The split is draggable, with 50/50 and 60/40 presets.
//   * Card modifiers are the point: counters, +N/+N and -N/-N, tapped,
//     doesn't-untap. Read-only -- each player applies their own effects.
//   * Hidden stays hidden: library and hand are counts only.

import { BROWSABLE_ZONES } from './protocol.js';

const ZONE_LABELS = {
  graveyard: { icon: '\u{1FAA6}', label: 'Cimetière' },
  exile: { icon: '⊘', label: 'Exil' },
  command: { icon: '\u{1F451}', label: 'Command' },
};

const COUNTER_LABELS = {
  poison: 'Poison', energy: 'Énergie', experience: 'Exp', rad: 'Rad',
  tickets: 'Tickets', commanderDamage1: 'Cmd 1', commanderDamage2: 'Cmd 2',
  commanderDamage3: 'Cmd 3',
};

export const SPLIT_PRESETS = [
  { label: '40 / 60', value: 40 },
  { label: '50 / 50', value: 50 },
  { label: '60 / 40', value: 60 },
];

export class SpectatorPanel {
  /**
   * @param {object} options
   * @param {import('./store.js').RemoteBoardStore} options.store
   * @param {object} options.tracer
   * @param {() => Array} options.getPlayers      roster: [{id, username, connected}]
   * @param {(playerId, zone, card) => void} [options.onClaim]
   * @param {(playerId) => void} [options.onResyncRequest]
   * @param {(prefs) => void} [options.onPrefsChange]
   */
  constructor(options) {
    this._store = options.store;
    this._tracer = options.tracer || { trace() {}, count() {} };
    this._getPlayers = options.getPlayers || (() => []);
    this._onClaim = options.onClaim || null;
    this._onResync = options.onResyncRequest || (() => {});
    this._onPrefsChange = options.onPrefsChange || (() => {});

    this.prefs = {
      splitPercent: 50,
      flipped: false,      // render the board as seen from across the table
      visible: false,
      showDetails: true,
    };

    this._root = null;
    this._els = {};
    this._activeId = null;
    this._openZone = null;
    this._detailCard = null;
    this._renderQueued = false;
    this._keyHandler = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  mount() {
    if (this._root) return;

    const root = document.createElement('div');
    root.className = 'moxpod-panel';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Boards adverses');

    root.innerHTML = `
      <div class="moxpod-tabs">
        <button class="moxpod-nav" data-act="prev" title="Adversaire précédent (←)">‹</button>
        <div class="moxpod-tablist" role="tablist"></div>
        <button class="moxpod-nav" data-act="next" title="Adversaire suivant (→)">›</button>
        <div class="moxpod-tools">
          <button class="moxpod-tool" data-act="flip" title="Vue d'en face (miroir)">⇅</button>
          <button class="moxpod-tool" data-act="split" title="Répartition de l'écran">50/50</button>
          <button class="moxpod-tool" data-act="resync" title="Redemander le board complet">⟳</button>
          <button class="moxpod-tool" data-act="hide" title="Masquer le panneau (Échap)">✕</button>
        </div>
      </div>
      <div class="moxpod-stage">
        <div class="moxpod-board" aria-live="polite"></div>
        <div class="moxpod-empty">En attente du board…</div>
      </div>
      <div class="moxpod-footer">
        <div class="moxpod-vitals"></div>
        <div class="moxpod-zones"></div>
      </div>
      <div class="moxpod-resizer" title="Glisser pour redimensionner"></div>
    `;

    document.body.appendChild(root);
    this._root = root;
    this._els = {
      tablist: root.querySelector('.moxpod-tablist'),
      board: root.querySelector('.moxpod-board'),
      empty: root.querySelector('.moxpod-empty'),
      vitals: root.querySelector('.moxpod-vitals'),
      zones: root.querySelector('.moxpod-zones'),
      splitBtn: root.querySelector('[data-act="split"]'),
      resizer: root.querySelector('.moxpod-resizer'),
    };

    root.addEventListener('click', e => this._onClick(e));
    this._installResizer();
    this._installKeys();
    this._applySplit();
    this._tracer.trace('ui', 'panel:mounted');
  }

  unmount() {
    if (!this._root) return;
    this._root.remove();
    this._root = null;
    document.documentElement.classList.remove('moxpod-active');
    if (this._keyHandler) {
      window.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    }
    this._tracer.trace('ui', 'panel:unmounted');
  }

  setVisible(visible) {
    this.prefs.visible = !!visible;
    if (visible) this.mount();
    document.documentElement.classList.toggle('moxpod-active', !!visible);
    if (this._root) this._root.classList.toggle('moxpod-hidden', !visible);
    this._applySplit();
    if (visible) this.render();
    this._onPrefsChange(this.prefs);
  }

  toggle() {
    this.setVisible(!this.prefs.visible);
  }

  // ── Selection ─────────────────────────────────────────────────────

  get activePlayerId() {
    return this._activeId;
  }

  select(playerId) {
    if (!playerId || playerId === this._activeId) return;
    this._activeId = playerId;
    this._openZone = null;
    this._tracer.trace('ui', 'panel:select', { playerId });
    this.render();
  }

  cycle(direction) {
    const players = this._getPlayers();
    if (!players.length) return;
    const index = players.findIndex(p => p.id === this._activeId);
    const next = players[(index + direction + players.length) % players.length];
    this.select(next.id);
  }

  /** Called when the roster changes; keeps a sane active tab. */
  syncRoster() {
    const players = this._getPlayers();
    if (!players.length) {
      this._activeId = null;
    } else if (!players.some(p => p.id === this._activeId)) {
      this._activeId = players[0].id;
    }
    this.render();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /** Coalesced render: many store updates in one frame produce one paint. */
  render() {
    if (!this._root || !this.prefs.visible) return;
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      try {
        this._renderNow();
      } catch (err) {
        this._tracer.capture?.('ui', 'panel:render-failed', err);
      }
    });
  }

  _renderNow() {
    this._renderTabs();
    const view = this._activeId ? this._store.view(this._activeId) : null;
    this._els.empty.style.display = view ? 'none' : 'flex';
    this._els.empty.textContent = this._activeId
      ? 'En attente du board de ce joueur…'
      : 'Aucun adversaire connecté.';
    this._renderVitals(view);
    this._renderZones(view);
    this._renderBoard(view);
  }

  _renderTabs() {
    const players = this._getPlayers();
    const list = this._els.tablist;
    list.replaceChildren();

    for (const [index, player] of players.entries()) {
      const view = this._store.view(player.id);
      const tab = document.createElement('button');
      tab.className = 'moxpod-tab';
      tab.setAttribute('role', 'tab');
      tab.dataset.playerId = player.id;
      tab.setAttribute('aria-selected', String(player.id === this._activeId));
      tab.classList.toggle('active', player.id === this._activeId);
      tab.classList.toggle('offline', player.connected === false);
      if (player.simulated) tab.classList.add('simulated');

      const life = view?.life ?? player.life;
      const hand = view?.handCount ?? player.handCount;
      tab.innerHTML = `
        <span class="moxpod-tab-key">${index + 1}</span>
        <span class="moxpod-tab-name"></span>
        <span class="moxpod-tab-stat" title="Points de vie">❤ <b>${fmt(life)}</b></span>
        <span class="moxpod-tab-stat" title="Cartes en main">🂠 <b>${fmt(hand)}</b></span>
      `;
      tab.querySelector('.moxpod-tab-name').textContent = player.username || 'Anonyme';
      list.appendChild(tab);
    }
  }

  _renderVitals(view) {
    const box = this._els.vitals;
    box.replaceChildren();
    if (!view) return;

    box.appendChild(vital('❤', 'Vie', fmt(view.life), 'life'));
    box.appendChild(vital('🂠', 'Main', fmt(view.handCount), 'hand'));
    box.appendChild(vital('📚', 'Bibliothèque', fmt(view.libraryCount), 'library'));
    if (view.turn != null) box.appendChild(vital('⏱', 'Tour', fmt(view.turn), 'turn'));

    for (const [name, value] of Object.entries(view.counters || {})) {
      if (!value) continue;
      box.appendChild(vital('◈', COUNTER_LABELS[name] || name, String(value), 'counter'));
    }

    if (view.staleMs > 8000) {
      const stale = document.createElement('span');
      stale.className = 'moxpod-stale';
      stale.textContent = `⚠ figé depuis ${Math.round(view.staleMs / 1000)}s`;
      stale.title = 'Aucune mise à jour reçue récemment';
      box.appendChild(stale);
    }
  }

  _renderZones(view) {
    const box = this._els.zones;
    box.replaceChildren();
    if (!view) return;

    for (const zone of BROWSABLE_ZONES) {
      const cards = view.zones[zone] || [];
      const meta = ZONE_LABELS[zone];
      const chip = document.createElement('button');
      chip.className = 'moxpod-zone-chip';
      chip.dataset.zone = zone;
      chip.classList.toggle('open', this._openZone === zone);
      chip.disabled = cards.length === 0;
      chip.innerHTML = `<span>${meta.icon}</span> ${meta.label} <b>${cards.length}</b>`;
      chip.title = cards.length ? `Parcourir ${meta.label.toLowerCase()}` : 'Zone vide';
      box.appendChild(chip);
    }

    if (this._openZone) {
      box.appendChild(this._buildZoneBrowser(view, this._openZone));
    }
  }

  _buildZoneBrowser(view, zone) {
    const cards = view.zones[zone] || [];
    const wrap = document.createElement('div');
    wrap.className = 'moxpod-zone-browser';

    const header = document.createElement('div');
    header.className = 'moxpod-zone-browser-head';
    header.innerHTML = `<strong>${ZONE_LABELS[zone].label}</strong> <span>${cards.length} carte(s)</span>`;
    const close = document.createElement('button');
    close.className = 'moxpod-tool';
    close.dataset.act = 'close-zone';
    close.textContent = '✕';
    header.appendChild(close);
    wrap.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'moxpod-zone-grid';
    // Most recent first -- that is what you are usually looking for.
    for (const card of [...cards].reverse()) {
      grid.appendChild(this._buildZoneCard(card, zone));
    }
    wrap.appendChild(grid);
    return wrap;
  }

  _buildZoneCard(card, zone) {
    const item = document.createElement('div');
    item.className = 'moxpod-zone-card';
    item.dataset.zoneId = card.zoneId;

    const face = this._buildCardFace(card, { compact: true });
    face.dataset.act = 'detail';
    item.appendChild(face);

    const label = document.createElement('div');
    label.className = 'moxpod-zone-card-name';
    label.textContent = card.name;
    item.appendChild(label);

    if (this._onClaim) {
      const claim = document.createElement('button');
      claim.className = 'moxpod-claim';
      claim.dataset.act = 'claim';
      claim.dataset.zone = zone;
      claim.dataset.zoneId = card.zoneId;
      claim.textContent = 'Demander';
      claim.title = `Demander ${card.name} à son propriétaire`;
      item.appendChild(claim);
    }
    return item;
  }

  _renderBoard(view) {
    const board = this._els.board;
    board.replaceChildren();
    board.classList.toggle('flipped', this.prefs.flipped);
    if (!view) return;

    for (const card of view.battlefield) {
      board.appendChild(this._buildBattlefieldCard(card));
    }
  }

  _buildBattlefieldCard(card) {
    const slot = document.createElement('div');
    slot.className = 'moxpod-card-slot';
    slot.dataset.zoneId = card.zoneId;
    slot.dataset.act = 'detail';
    // Percentages are centre-relative, so translate(-50%,-50%) puts the card
    // where its owner actually placed it regardless of our panel size.
    const x = this.prefs.flipped ? 1 - card.x : card.x;
    const y = this.prefs.flipped ? 1 - card.y : card.y;
    slot.style.left = `${x * 100}%`;
    slot.style.top = `${y * 100}%`;
    slot.style.zIndex = String(100 + (card.zIndex || 0));
    slot.appendChild(this._buildCardFace(card, { compact: false }));
    return slot;
  }

  /** The card itself: image (or text fallback) plus the modifier badges. */
  _buildCardFace(card, { compact }) {
    const face = document.createElement('div');
    face.className = 'moxpod-card';
    face.classList.toggle('compact', compact);
    face.classList.toggle('tapped', card.tapped);
    face.classList.toggle('rotated', card.rotated);
    face.classList.toggle('face-down', card.flipped);
    face.title = card.name;

    if (card.flipped) {
      face.classList.add('back');
      face.innerHTML = '<div class="moxpod-card-back">MTG</div>';
      return face;
    }

    const url = cardImageUrl(card);
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = card.name;
      img.loading = 'lazy';
      img.draggable = false;
      // A missing image must degrade to the text frame, not an empty box.
      img.addEventListener('error', () => {
        img.remove();
        face.prepend(buildTextFrame(card));
      }, { once: true });
      face.appendChild(img);
    } else {
      face.appendChild(buildTextFrame(card));
    }

    const badges = document.createElement('div');
    badges.className = 'moxpod-badges';

    if (card.counters) {
      badges.appendChild(badge('counter', `◈ ${card.counters}`, `${card.counters} marqueur(s)`));
    }
    const pt = effectivePT(card);
    if (pt) {
      badges.appendChild(badge(
        pt.modified ? 'pt modified' : 'pt',
        pt.text,
        pt.modified ? `Base ${pt.base}, modifié de ${pt.delta}` : 'Force / endurance',
      ));
    }
    if (card.adjustedLoyalty) {
      badges.appendChild(badge('loyalty', `◆ ${card.adjustedLoyalty}`, 'Loyauté modifiée'));
    }
    if (card.doesntUntap) {
      badges.appendChild(badge('warn', '⊘', 'Ne se dégage pas'));
    }
    if (!card.known) {
      badges.appendChild(badge('warn', '?', 'Carte inconnue — données pas encore reçues'));
    }
    if (badges.childElementCount) face.appendChild(badges);

    return face;
  }

  // ── Card detail ───────────────────────────────────────────────────

  showDetail(card) {
    this.closeDetail();
    const overlay = document.createElement('div');
    overlay.className = 'moxpod-detail-backdrop';
    overlay.dataset.act = 'close-detail';

    const box = document.createElement('div');
    box.className = 'moxpod-detail';

    const art = this._buildCardFace({ ...card, tapped: false, rotated: false, flipped: false }, { compact: false });
    art.classList.add('moxpod-detail-art');
    box.appendChild(art);

    const info = document.createElement('div');
    info.className = 'moxpod-detail-info';

    const faces = card.faces.length ? card.faces : [{
      name: card.name, typeLine: card.typeLine, manaCost: card.manaCost,
      oracleText: card.oracleText, power: card.power, toughness: card.toughness,
    }];

    for (const f of faces) {
      const block = document.createElement('div');
      block.className = 'moxpod-detail-face';
      const head = document.createElement('div');
      head.className = 'moxpod-detail-head';
      head.innerHTML = `<h3></h3><span class="moxpod-mana"></span>`;
      head.querySelector('h3').textContent = f.name || card.name;
      head.querySelector('.moxpod-mana').textContent = f.manaCost || '';
      block.appendChild(head);

      const type = document.createElement('div');
      type.className = 'moxpod-detail-type';
      type.textContent = f.typeLine || '';
      block.appendChild(type);

      if (f.oracleText) {
        const oracle = document.createElement('div');
        oracle.className = 'moxpod-detail-oracle';
        for (const line of String(f.oracleText).split('\n')) {
          const p = document.createElement('p');
          p.textContent = line;
          oracle.appendChild(p);
        }
        block.appendChild(oracle);
      }
      if (f.power != null || f.toughness != null) {
        const pt = document.createElement('div');
        pt.className = 'moxpod-detail-pt';
        pt.textContent = `${f.power ?? ''}/${f.toughness ?? ''}`;
        block.appendChild(pt);
      }
      info.appendChild(block);
    }

    // The whole reason this feature exists: what the owner has applied to it.
    const mods = describeModifiers(card);
    const modBox = document.createElement('div');
    modBox.className = 'moxpod-detail-mods';
    modBox.innerHTML = '<h4>État en jeu</h4>';
    const list = document.createElement('ul');
    if (mods.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'Aucun modificateur.';
      list.appendChild(li);
    } else {
      for (const mod of mods) {
        const li = document.createElement('li');
        li.textContent = mod;
        list.appendChild(li);
      }
    }
    modBox.appendChild(list);
    info.appendChild(modBox);

    box.appendChild(info);
    overlay.appendChild(box);
    (this._root || document.body).appendChild(overlay);
    this._detailCard = overlay;
  }

  closeDetail() {
    if (this._detailCard) {
      this._detailCard.remove();
      this._detailCard = null;
    }
  }

  // ── Interaction ───────────────────────────────────────────────────

  _onClick(event) {
    const target = event.target.closest('[data-act], .moxpod-tab, .moxpod-zone-chip');
    if (!target) return;

    if (target.classList.contains('moxpod-tab')) {
      this.select(target.dataset.playerId);
      return;
    }
    if (target.classList.contains('moxpod-zone-chip')) {
      this._openZone = this._openZone === target.dataset.zone ? null : target.dataset.zone;
      this.render();
      return;
    }

    switch (target.dataset.act) {
      case 'prev': this.cycle(-1); break;
      case 'next': this.cycle(1); break;
      case 'flip':
        this.prefs.flipped = !this.prefs.flipped;
        this._onPrefsChange(this.prefs);
        this.render();
        break;
      case 'split': this._nextSplit(); break;
      case 'resync':
        if (this._activeId) this._onResync(this._activeId);
        break;
      case 'hide': this.setVisible(false); break;
      case 'close-zone': this._openZone = null; this.render(); break;
      case 'close-detail': this.closeDetail(); break;
      case 'detail': {
        const card = this._findCard(target.closest('[data-zone-id]')?.dataset.zoneId);
        if (card) this.showDetail(card);
        break;
      }
      case 'claim': {
        event.stopPropagation();
        const card = this._findCard(target.dataset.zoneId, target.dataset.zone);
        if (card && this._onClaim) {
          this._onClaim(this._activeId, target.dataset.zone, card);
          target.textContent = 'Demandé…';
          target.disabled = true;
        }
        break;
      }
      default: break;
    }
  }

  _findCard(zoneId, zone = null) {
    if (!zoneId || !this._activeId) return null;
    const view = this._store.view(this._activeId);
    if (!view) return null;
    if (zone) return (view.zones[zone] || []).find(c => c.zoneId === zoneId) || null;
    const pools = [view.battlefield, ...BROWSABLE_ZONES.map(z => view.zones[z] || [])];
    for (const pool of pools) {
      const found = pool.find(c => c.zoneId === zoneId);
      if (found) return found;
    }
    return null;
  }

  _nextSplit() {
    const index = SPLIT_PRESETS.findIndex(p => p.value === this.prefs.splitPercent);
    const next = SPLIT_PRESETS[(index + 1) % SPLIT_PRESETS.length];
    this.prefs.splitPercent = next.value;
    this._applySplit();
    this._onPrefsChange(this.prefs);
  }

  _applySplit() {
    const percent = this.prefs.visible ? this.prefs.splitPercent : 0;
    document.documentElement.style.setProperty('--moxpod-split', `${percent}vh`);
    if (this._els.splitBtn) {
      this._els.splitBtn.textContent = `${this.prefs.splitPercent}/${100 - this.prefs.splitPercent}`;
    }
  }

  _installResizer() {
    const handle = this._els.resizer;
    let dragging = false;

    const move = (event) => {
      if (!dragging) return;
      const percent = Math.round((event.clientY / window.innerHeight) * 100);
      this.prefs.splitPercent = Math.min(75, Math.max(20, percent));
      this._applySplit();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove('moxpod-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this._onPrefsChange(this.prefs);
      this.render();
    };

    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dragging = true;
      document.body.classList.add('moxpod-resizing');
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  _installKeys() {
    this._keyHandler = (event) => {
      if (!this.prefs.visible) return;
      // Never steal keys from Moxfield's own hotkeys while typing.
      const tag = event.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target?.isContentEditable) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.key === 'Escape') {
        if (this._detailCard) { this.closeDetail(); event.stopPropagation(); }
        else if (this._openZone) { this._openZone = null; this.render(); event.stopPropagation(); }
        return;
      }
      // Arrows only when the pointer is over the panel, so they keep working
      // for Moxfield everywhere else.
      if (!this._root?.matches(':hover')) return;
      if (event.key === 'ArrowLeft') { this.cycle(-1); event.stopPropagation(); }
      else if (event.key === 'ArrowRight') { this.cycle(1); event.stopPropagation(); }
      else if (/^[1-4]$/.test(event.key)) {
        const players = this._getPlayers();
        const player = players[Number(event.key) - 1];
        if (player) { this.select(player.id); event.stopPropagation(); }
      }
    };
    window.addEventListener('keydown', this._keyHandler, true);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Scryfall's image CDN, addressed directly by printing id. The obvious
 * alternative (api.scryfall.com/cards/{set}/{cn}?format=image) costs a 302
 * per card, which is 120 redirects for a four-player pod mid-game.
 */
export function cardImageUrl(card) {
  const id = card.key || '';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) {
    const face = card.layout === 'transform' || card.layout === 'modal_dfc' ? 'front' : 'front';
    return `https://cards.scryfall.io/normal/${face}/${id[0]}/${id[1]}/${id}.jpg`;
  }
  if (card.set && card.cn) {
    return `https://api.scryfall.com/cards/${encodeURIComponent(card.set)}/${encodeURIComponent(card.cn)}?format=image`;
  }
  return null;
}

/** Effective power/toughness, flagged when the owner has modified it. */
export function effectivePT(card) {
  const hasBase = card.power != null && card.power !== '' &&
    card.toughness != null && card.toughness !== '';
  const delta = (card.adjustedPower || 0) || (card.adjustedToughness || 0);
  if (!hasBase && !delta) return null;

  // Strict: parseInt('1+*') is 1, which would silently misreport a Tarmogoyf.
  // A characteristic-defining P/T stays as printed and we show the modifier
  // separately rather than inventing a number.
  const basePower = wholeInteger(card.power);
  const baseToughness = wholeInteger(card.toughness);
  const power = basePower !== null ? basePower + (card.adjustedPower || 0) : card.power;
  const toughness = baseToughness !== null
    ? baseToughness + (card.adjustedToughness || 0) : card.toughness;

  return {
    text: `${power ?? '?'}/${toughness ?? '?'}`,
    base: `${card.power ?? '?'}/${card.toughness ?? '?'}`,
    delta: `${signed(card.adjustedPower)}/${signed(card.adjustedToughness)}`,
    modified: !!(card.adjustedPower || card.adjustedToughness),
  };
}

/** Plain-language list of everything the owner has applied to a card. */
export function describeModifiers(card) {
  const out = [];
  if (card.tapped) out.push('Engagée');
  if (card.doesntUntap) out.push('Ne se dégage pas au prochain tour');
  if (card.rotated) out.push('Pivotée à 180°');
  if (card.flipped) out.push('Face cachée');
  if (card.counters) out.push(`${card.counters} marqueur(s)`);
  if (card.adjustedPower || card.adjustedToughness) {
    out.push(`Force/endurance modifiée de ${signed(card.adjustedPower)}/${signed(card.adjustedToughness)}`);
  }
  if (card.adjustedLoyalty) out.push(`Loyauté modifiée de ${signed(card.adjustedLoyalty)}`);
  return out;
}

/** A power/toughness that is entirely a number, or null (`*`, `1+*`, `?`). */
function wholeInteger(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  return Number.parseInt(value, 10);
}

function signed(n) {
  const value = n || 0;
  return value >= 0 ? `+${value}` : String(value);
}

function fmt(value) {
  return value == null ? '–' : String(value);
}

function badge(kind, text, title) {
  const el = document.createElement('span');
  el.className = `moxpod-badge ${kind}`;
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

function vital(icon, label, value, kind) {
  const el = document.createElement('span');
  el.className = `moxpod-vital ${kind}`;
  el.title = label;
  el.innerHTML = `<i>${icon}</i><b></b>`;
  el.querySelector('b').textContent = value;
  return el;
}

/** Fallback frame for tokens and cards with no usable image. */
function buildTextFrame(card) {
  const frame = document.createElement('div');
  frame.className = 'moxpod-text-frame';
  const name = document.createElement('div');
  name.className = 'moxpod-text-name';
  name.textContent = card.name;
  const type = document.createElement('div');
  type.className = 'moxpod-text-type';
  type.textContent = card.typeLine || '';
  frame.append(name, type);
  if (card.oracleText) {
    const oracle = document.createElement('div');
    oracle.className = 'moxpod-text-oracle';
    oracle.textContent = card.oracleText;
    frame.appendChild(oracle);
  }
  return frame;
}
