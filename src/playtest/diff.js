// Pure diffing functions for comparing playtest zone snapshots.

const BATTLEFIELD_STATE_PROPS = [
  'tapped', 'flipped', 'rotated', 'doesntUntap',
  'top', 'left', 'counters',
  'adjustedPower', 'adjustedToughness', 'adjustedLoyalty',
];

/**
 * Compare two zone snapshots and return an array of change events.
 *
 * Event types:
 *   card:zone-changed  — card moved between zones
 *   card:added         — new card appeared (e.g. token created)
 *   card:removed       — card deleted from all zones
 *   card:state-changed — battlefield card property changed (tap, flip, etc.)
 *   zone:reordered     — zone has the same cards in a different order
 */
export function diffZones(oldZones, newZones) {
  const events = [];

  // Build lookup maps: zoneId → { zone, card }
  const oldByZoneId = new Map();
  const newByZoneId = new Map();

  for (const [zone, cards] of Object.entries(oldZones)) {
    for (const card of cards) {
      oldByZoneId.set(card.zoneId, { zone, card });
    }
  }
  for (const [zone, cards] of Object.entries(newZones)) {
    for (const card of cards) {
      newByZoneId.set(card.zoneId, { zone, card });
    }
  }

  // Detect moves, additions, and battlefield state changes.
  for (const [zoneId, { zone, card }] of newByZoneId) {
    const old = oldByZoneId.get(zoneId);
    if (!old) {
      events.push({ type: 'card:added', card: { ...card }, toZone: zone });
    } else if (old.zone !== zone) {
      events.push({
        type: 'card:zone-changed',
        card: { ...card },
        fromZone: old.zone,
        toZone: zone,
      });
    } else if (zone === 'battlefield') {
      const changes = diffCardState(old.card, card);
      if (changes) {
        events.push({ type: 'card:state-changed', card: { ...card }, changes });
      }
    }
  }

  // Detect removals.
  for (const [zoneId, { zone, card }] of oldByZoneId) {
    if (!newByZoneId.has(zoneId)) {
      events.push({ type: 'card:removed', card: { ...card }, fromZone: zone });
    }
  }

  // Detect reordering within zones (same set of cards, different order).
  for (const zone of Object.keys(newZones)) {
    if (!oldZones[zone]) continue;
    const oldIds = oldZones[zone].map(c => c.zoneId);
    const newIds = newZones[zone].map(c => c.zoneId);

    if (
      oldIds.length > 1 &&
      oldIds.length === newIds.length &&
      JSON.stringify([...oldIds].sort()) === JSON.stringify([...newIds].sort()) &&
      JSON.stringify(oldIds) !== JSON.stringify(newIds)
    ) {
      events.push({ type: 'zone:reordered', zone, cardIds: [...newIds] });
    }
  }

  return events;
}

/**
 * Compare two battlefield card objects and return changed properties,
 * or null if nothing changed.
 */
function diffCardState(oldCard, newCard) {
  const changes = {};
  let hasChanges = false;

  for (const prop of BATTLEFIELD_STATE_PROPS) {
    if (oldCard[prop] !== newCard[prop]) {
      changes[prop] = { from: oldCard[prop], to: newCard[prop] };
      hasChanges = true;
    }
  }

  return hasChanges ? changes : null;
}

/**
 * Create a snapshot of zones suitable for later diffing.
 * Each card is shallow-cloned so the snapshot is independent of React state.
 */
export function snapshotZones(zones) {
  const snapshot = {};
  for (const [zone, cards] of Object.entries(zones)) {
    snapshot[zone] = cards.map(c => ({ ...c }));
  }
  return snapshot;
}
