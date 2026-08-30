// MoxPod board-sync protocol.
//
// Wire format for mirroring a player's board to spectators.
//
// DESIGN NOTES
// ------------
// 1. We piggyback on MoxMox's `zone-sync` message type. New `action` values do
//    pass through the public relay -- but the relay ALSO whitelists fields per
//    type (RELAY_FIELDS in server/src/index.js), and rebuilds each message from
//    scratch keeping only the allowed keys. For `zone-sync` that is:
//
//      action, zone, cardId, scryfallId, syncId, pctX, pctY, fromZone,
//      toZone, updates, syncIds, cards, targetId, gift
//
//    A top-level `snapshot` or `delta` is silently dropped, so the frame
//    arrives with its action intact and no payload. `updates` is whitelisted
//    and carries arbitrary JSON, so every MoxPod payload travels inside it.
//    See packEnvelope/unpackEnvelope below -- that is the only place this
//    constraint is encoded.
//
// 2. The relay enforces a token bucket of 5 messages/sec (burst 5) and a
//    64 KB max frame. So we send ONE batched message per tick rather than
//    MoxMox's one-message-per-card-change, which blows the bucket the moment
//    you untap 6 permanents. See board/batcher.js.
//
// 3. Card *identity* (name, oracle text, type line, P/T) is immutable and
//    verbose, so it travels once in a `dict` keyed by printing, and the
//    receiver caches it for the session. The per-tick delta then carries only
//    volatile state (position, tapped, counters) in single-letter keys.
//
// 4. Everything is read-only for the spectator. We never write a remote card
//    into the local Moxfield state -- the panel renders its own DOM. The one
//    exception is the existing gift/claim flow, which is an explicit,
//    consented transfer initiated by the card's owner.

export const BOARD_PROTOCOL_VERSION = 1;

// zone-sync actions. Namespaced so they can never collide with upstream
// MoxMox actions if we ever want cross-compatibility.
export const ACTION_FULL = 'board-full';
export const ACTION_DELTA = 'board-delta';
export const ACTION_REQUEST = 'board-request';

// Zones mirrored to spectators. `battlefield` carries positions; the others
// are ordered lists. Hidden zones (hand, library) travel as counts only.
export const MIRRORED_ZONES = ['battlefield', 'graveyard', 'exile', 'command'];

// Zones a spectator may browse card-by-card.
export const BROWSABLE_ZONES = ['graveyard', 'exile', 'command'];

// Volatile per-card state. Key = wire key, value = Moxfield card property.
// Order matters only for readability.
export const STATE_KEYS = {
  x: 'pctX',              // horizontal centre, 0..1 of usable battlefield width
  y: 'pctY',              // vertical centre, 0..1 of battlefield height
  z: 'zIndex',
  t: 'tapped',
  f: 'flipped',
  r: 'rotated',
  u: 'doesntUntap',
  c: 'counters',
  p: 'adjustedPower',
  g: 'adjustedToughness',
  l: 'adjustedLoyalty',
};

// Immutable per-printing card data. Key = wire key, value = Moxfield property.
export const DICT_KEYS = {
  n: 'name',
  s: 'set',
  c: 'cn',
  y: 'layout',
  t: 'type_line',
  m: 'mana_cost',
  p: 'power',
  g: 'toughness',
  o: 'oracle_text',
  k: 'isToken',
};

// Extra player-level counters worth showing next to life.
export const PLAYER_COUNTERS = [
  'poison', 'energy', 'experience', 'rad', 'tickets',
  'commanderDamage1', 'commanderDamage2', 'commanderDamage3',
];

// Delta op codes.
export const OP_UPSERT = 'u';   // card added or state changed in a zone
export const OP_REMOVE = 'r';   // card left every mirrored zone
export const OP_ZONE = 'z';     // full replacement of a non-battlefield zone

/**
 * Fields the public relay lets through on a `zone-sync` message. Mirrored from
 * server/src/index.js RELAY_FIELDS so tests can assert against it.
 */
export const RELAY_ALLOWED_ZONE_SYNC_FIELDS = new Set([
  'action', 'zone', 'cardId', 'scryfallId', 'syncId', 'pctX', 'pctY',
  'fromZone', 'toZone', 'updates', 'syncIds', 'cards', 'targetId', 'gift',
]);

/**
 * Wrap a MoxPod payload so it survives the relay's field whitelist.
 *
 * Everything that is not a whitelisted key goes inside `updates`. Callers pass
 * `passthrough` for the handful of fields that are already allowed through at
 * the top level (`zone`, `targetId`), because the relay preserves those and
 * some upstream code paths read them directly.
 */
export function packEnvelope(action, payload = {}, passthrough = {}) {
  const message = { action, ...passthrough };
  if (payload && Object.keys(payload).length > 0) message.updates = payload;
  return message;
}

/**
 * Read a payload back out, accepting both shapes: wrapped in `updates` (what
 * the public relay delivers) and at the top level (what a forked worker
 * without the whitelist, or a direct peer connection, would deliver).
 */
export function unpackEnvelope(message) {
  const wrapped = message?.updates;
  if (wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)) {
    return { ...message, ...wrapped };
  }
  return message || {};
}

/**
 * Build the stable dictionary key for a card. Printings are shared across
 * copies, so this dedupes heavily (a deck of 4x Lightning Bolt is one entry).
 * InfiniTokens and custom tokens have no scryfall_id, so they fall back to a
 * synthetic key.
 */
export function dictKeyForCard(card) {
  if (card.scryfall_id) return card.scryfall_id;
  const name = card.name || 'unknown';
  return `t:${card.id || ''}:${name}`;
}
