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
import {
  ACTION_FULL, ACTION_DELTA, ACTION_REQUEST, BROWSABLE_ZONES,
  packEnvelope, unpackEnvelope,
} from './protocol.js';

const CLAIM_REQUEST = 'board-claim-request';
const CLAIM_DENY = 'board-claim-deny';

const CLAIMABLE_ZONES = new Set(BROWSABLE_ZONES);

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
    send: ({ action, ...payload }) => {
      sendWs({ type: 'zone-sync', ...packEnvelope(action, payload) });
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
  //
  // DELIBERATE: a successful read calls markDirty(), which arms the next flush,
  // which starts the next read. That self-sustaining ~3 Hz loop is what keeps
  // the 15 s keyframe alive, because flush() only runs while the board is
  // marked dirty -- break the loop and a late spectator never self-heals.
  // The cost is bounded: a flush with no real change refunds its token and
  // sends nothing, so an idle board costs a fiber read and a diff, not traffic.
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
    if (!playerId) return;
    // Simulated opponents have no socket; serve their resync locally, or the
    // debug panel's "inject a desync" button would freeze the board forever.
    if (simulator.running && simulator.ownsPlayer(playerId)) {
      simulator.resend(playerId);
      return;
    }
    if (!isTraditional()) return;
    sendWs({ type: 'zone-sync', ...packEnvelope(ACTION_REQUEST, {}, { targetId: playerId }) });
    tracer.info('board', 'resync:sent', { playerId });
  }

  async function requestClaim(playerId, zone, card) {
    if (!playerId || !card) return;
    sendWs({
      type: 'zone-sync',
      ...packEnvelope(
        CLAIM_REQUEST,
        { zoneId: card.zoneId, cardName: card.name },
        { targetId: playerId, zone },
      ),
    });
    tracer.info('board', 'claim:requested', { playerId, zone, card: card.name });
    notify?.(`Demande envoyée pour ${card.name}.`);
  }

  /**
   * Someone wants a card out of one of our zones. We ask before handing it
   * over -- it mutates our board, so it is our call, not theirs.
   *
   * The request names a zoneId, and the underlying lookup searches EVERY zone.
   * So we resolve the card ourselves first and build the dialogue from what we
   * actually found, never from the requester's text: otherwise a peer could
   * show "wants Sol Ring from your graveyard" while pointing at your
   * commander in play.
   */
  async function handleClaimRequest(msg) {
    const zone = msg.zone;
    if (!CLAIMABLE_ZONES.has(zone)) {
      tracer.warn('board', 'claim:rejected-zone', { from: msg.senderId, zone });
      return;
    }

    const found = await sendCmd('find-card', { zoneId: msg.zoneId, zone });
    if (!found || found.error || !found.card) {
      tracer.warn('board', 'claim:rejected-card', {
        from: msg.senderId, zone, reason: found?.error || 'not found',
      });
      sendWs({
        type: 'zone-sync',
        ...packEnvelope(CLAIM_DENY, { cardName: msg.cardName }, { targetId: msg.senderId }),
      });
      return;
    }

    const who = remoteUsernameFor(msg.senderId);
    const zoneLabel = zone === 'graveyard' ? 'cimetière' : zone === 'exile' ? 'exil' : zone;
    const accepted = await confirmClaim({
      title: 'Demande de carte',
      // found.card.name, not msg.cardName: the requester does not get to
      // write the text of your own dialogue.
      text: `${who} demande « ${found.card.name} » depuis votre ${zoneLabel}.`,
    });
    if (!accepted) {
      sendWs({
        type: 'zone-sync',
        ...packEnvelope(CLAIM_DENY, { cardName: found.card.name }, { targetId: msg.senderId }),
      });
      tracer.info('board', 'claim:denied', { to: msg.senderId, card: found.card.name });
      return;
    }

    try {
      const result = await sendCmd('gift-to-player', {
        targetId: msg.senderId, zoneId: msg.zoneId, expectedZone: zone,
      });
      if (!result || result.error) throw new Error(result?.error || 'Carte introuvable');
      sendWs({
        type: 'zone-sync',
        action: result.type === 'gift-return-battlefield' ? 'gift-return-battlefield' : 'gift-card',
        targetId: msg.senderId,
        gift: result.gift,
      });
      batcher.markDirty();
      tracer.info('board', 'claim:granted', { to: msg.senderId, card: found.card.name });
    } catch (err) {
      tracer.capture('board', 'claim:failed', err, { card: found.card.name });
      notify?.(`Impossible de céder ${found.card.name} : ${err.message}`);
    }
  }

  function remoteUsernameFor(playerId) {
    const player = getPlayers().find(p => p.id === playerId);
    return player?.username || 'Un adversaire';
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
    handleRemoteSync(raw) {
      // The public relay strips unknown top-level fields, so payloads arrive
      // inside `updates`. unpackEnvelope accepts both shapes.
      const msg = unpackEnvelope(raw);
      switch (msg.action) {
        case ACTION_FULL:
          if (!started) return true;
          if (msg.senderId && msg.snapshot) store.ingestFull(msg.senderId, msg.snapshot);
          else tracer.warn('board', 'recv:full-without-payload', { from: msg.senderId });
          tracer.rate('board:in');
          return true;
        case ACTION_DELTA:
          if (!started) return true;
          if (msg.senderId && msg.delta) store.ingestDelta(msg.senderId, msg.delta);
          else tracer.warn('board', 'recv:delta-without-payload', { from: msg.senderId });
          tracer.rate('board:in');
          return true;
        case ACTION_REQUEST:
          if (!started) return true;
          tracer.info('board', 'resync:serving', { to: msg.senderId });
          batcher.requestFull();
          return true;
        case CLAIM_REQUEST:
          // Never act on a claim outside a live traditional game.
          if (!started) return true;
          handleClaimRequest(msg);
          return true;
        case CLAIM_DENY:
          if (!started) return true;
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
