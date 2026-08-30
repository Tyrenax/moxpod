// Wiring between MoxPod's board feature and the existing MoxMox content
// script.
//
// Everything board-related lives behind this one object so content.js only
// gains a handful of call sites. That keeps the diff against upstream MoxMox
// small and, more usefully, means the whole feature can be constructed with
// fake dependencies in a test.

import { BoardBatcher } from './batcher.js';
import { RemoteBoardStore } from './store.js';
import { SpectatorPanel } from './panel.js';
import { BoardSimulator } from '../debug/simulator.js';
import { ACTION_FULL, ACTION_DELTA, ACTION_REQUEST } from './protocol.js';

const CLAIM_REQUEST = 'board-claim-request';
const CLAIM_DENY = 'board-claim-deny';

export function createBoardFeature(deps) {
  const {
    sendWs, sendCmd, tracer,
    getPlayers, getLocalPlayerId, isTraditional,
    getUsername, confirmClaim, notify,
  } = deps;

  let started = false;

  const store = new RemoteBoardStore({
    onChange: () => panel.render(),
    onResyncNeeded: (playerId, reason) => {
      tracer.warn('board', 'resync:requested', { playerId, reason });
      requestResync(playerId);
    },
    onTrace: event => tracer.trace('board', event.kind, event),
  });

  const batcher = new BoardBatcher({
    capture: () => captureLocalBoard(),
    send: message => {
      sendWs({ type: 'zone-sync', ...message });
      tracer.rate('board:out');
    },
    onTrace: event => tracer.trace('board', event.kind, event),
  });

  const panel = new SpectatorPanel({
    store,
    tracer,
    getPlayers,
    onResyncRequest: playerId => requestResync(playerId),
    onClaim: (playerId, zone, card) => requestClaim(playerId, zone, card),
    onPrefsChange: prefs => savePrefs(prefs),
  });

  const simulator = new BoardSimulator({
    store,
    tracer,
    onRoster: () => panel.syncRoster(),
  });

  // The capture path is synchronous from the batcher's point of view, but
  // reading the board crosses into the MAIN world, which is async. We keep the
  // most recent read and kick off the next one, so the batcher always has
  // something fresh-enough to diff without ever blocking.
  let latestSnapshot = null;
  let capturePending = false;

  function captureLocalBoard() {
    if (!capturePending) {
      capturePending = true;
      sendCmd('get-board-state')
        .then((snapshot) => {
          capturePending = false;
          if (snapshot && !snapshot.error) {
            latestSnapshot = snapshot;
            // A read that landed after the flush still deserves to be sent.
            if (started) batcher.markDirty();
          } else if (snapshot?.error) {
            tracer.warn('board', 'capture:error', snapshot);
          }
        })
        .catch((err) => {
          capturePending = false;
          tracer.capture('board', 'capture:failed', err);
        });
    }
    if (!latestSnapshot) return null;
    // Hand the batcher a copy so its baseline cannot be mutated underneath it.
    const copy = JSON.parse(JSON.stringify(latestSnapshot));
    latestSnapshot = null;
    return copy;
  }

  function requestResync(playerId) {
    if (!playerId || !isTraditional()) return;
    sendWs({ type: 'zone-sync', action: ACTION_REQUEST, targetId: playerId });
    tracer.info('board', 'resync:sent', { playerId });
  }

  async function requestClaim(playerId, zone, card) {
    if (!playerId || !card) return;
    sendWs({
      type: 'zone-sync',
      action: CLAIM_REQUEST,
      targetId: playerId,
      zone,
      zoneId: card.zoneId,
      cardName: card.name,
      username: await getUsername(),
    });
    tracer.info('board', 'claim:requested', { playerId, zone, card: card.name });
    notify?.(`Demande envoyée pour ${card.name}.`);
  }

  /**
   * Someone wants a card out of one of our zones. We ask before handing it
   * over -- it mutates our board, so it is our call, not theirs.
   */
  async function handleClaimRequest(msg) {
    const who = msg.username || 'Un adversaire';
    const accepted = await confirmClaim({
      title: 'Demande de carte',
      text: `${who} demande « ${msg.cardName || 'une carte'} » depuis votre ${
        msg.zone === 'graveyard' ? 'cimetière' : msg.zone}.`,
    });
    if (!accepted) {
      sendWs({
        type: 'zone-sync', action: CLAIM_DENY, targetId: msg.senderId,
        cardName: msg.cardName,
      });
      tracer.info('board', 'claim:denied', { to: msg.senderId, card: msg.cardName });
      return;
    }

    try {
      const result = await sendCmd('gift-to-player', {
        targetId: msg.senderId, zoneId: msg.zoneId,
      });
      if (!result || result.error) throw new Error(result?.error || 'Carte introuvable');
      sendWs({
        type: 'zone-sync',
        action: result.type === 'gift-return-battlefield' ? 'gift-return-battlefield' : 'gift-card',
        targetId: msg.senderId,
        gift: result.gift,
      });
      batcher.markDirty();
      tracer.info('board', 'claim:granted', { to: msg.senderId, card: msg.cardName });
    } catch (err) {
      tracer.capture('board', 'claim:failed', err, { card: msg.cardName });
      notify?.(`Impossible de céder ${msg.cardName} : ${err.message}`);
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem('moxpod_panel_prefs', JSON.stringify(prefs));
    } catch { /* private mode, never fatal */ }
  }

  function loadPrefs() {
    try {
      const raw = localStorage.getItem('moxpod_panel_prefs');
      if (raw) Object.assign(panel.prefs, JSON.parse(raw));
    } catch { /* ignore */ }
  }

  return {
    store, batcher, panel, simulator,

    /** Called once the traditional game is live. */
    start() {
      if (started || !isTraditional()) return;
      started = true;
      loadPrefs();
      panel.mount();
      panel.setVisible(panel.prefs.visible !== false);
      panel.syncRoster();
      batcher.start();
      tracer.info('board', 'feature:started');
    },

    stop() {
      started = false;
      batcher.stop();
      simulator.stop();
      store.clear();
      panel.unmount();
      latestSnapshot = null;
      tracer.info('board', 'feature:stopped');
    },

    /** Any local Moxfield mutation. Cheap -- just arms the flush timer. */
    onLocalGameEvent(event) {
      if (!started) return;
      tracer.debug('game', event.type, () => ({
        from: event.fromZone, to: event.toZone, card: event.card?.name,
      }));
      batcher.markDirty();
    },

    /** Roster changed (join/leave). */
    onRosterChange() {
      if (!started) return;
      panel.syncRoster();
      // A player who just joined has no board yet, and we have theirs to send.
      batcher.requestFull();
    },

    onPlayerLeft(playerId) {
      store.forget(playerId);
      panel.syncRoster();
    },

    /**
     * Board-related zone-sync frames. Returns true when handled, so the
     * caller's existing switch can ignore them.
     */
    handleRemoteSync(msg) {
      switch (msg.action) {
        case ACTION_FULL:
          if (msg.senderId && msg.snapshot) store.ingestFull(msg.senderId, msg.snapshot);
          tracer.rate('board:in');
          return true;
        case ACTION_DELTA:
          if (msg.senderId && msg.delta) store.ingestDelta(msg.senderId, msg.delta);
          tracer.rate('board:in');
          return true;
        case ACTION_REQUEST:
          tracer.info('board', 'resync:serving', { to: msg.senderId });
          batcher.requestFull();
          return true;
        case CLAIM_REQUEST:
          handleClaimRequest(msg);
          return true;
        case CLAIM_DENY:
          notify?.(`Demande refusée pour ${msg.cardName || 'la carte'}.`);
          tracer.info('board', 'claim:refused', { by: msg.senderId });
          return true;
        default:
          return false;
      }
    },

    togglePanel() {
      panel.toggle();
    },

    isStarted() {
      return started;
    },
  };
}
