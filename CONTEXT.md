# MoxPod

MoxPod is a browser extension that enables multiplayer Magic: The Gathering
games on third-party playtest websites by synchronizing game state between
players over a WebSocket relay.

## Language

**Playtest Site**:
A third-party website that provides a single-player MTG playtest engine
(e.g., Moxfield's goldfish mode, Archidekt's playtester-v2).
_Avoid_: platform, host site

**Site Adapter**:
A per-site module that bridges MoxPod to a playtest site's internal state
management. Each adapter discovers the site's game state (React class instance
or Redux store), emits a common set of events, and accepts a common set of
mutation commands.
_Avoid_: driver, plugin, connector

**Controller**:
A site-specific implementation created by a site adapter. Provides the
read/write/event interface that `content-main.js` consumes. MoxfieldController
wraps a React class component; ArchidektController wraps a Redux store.
_Avoid_: manager, handler

**syncId**:
A MoxPod-assigned identifier that tracks a specific card instance across
players. Generated locally, transmitted over the wire, and used to correlate
the same physical card on both sides. Not a site-internal ID.
_Avoid_: cardId, zoneId, instanceId

**scryfallId**:
The Scryfall printing UUID used as the neutral cross-site card identifier.
Moxfield stores it as `card.scryfall_id`; Archidekt stores it as `card.uid`.
Sufficient to construct card image URLs without an API call.
_Avoid_: cardId, oracleId, uid

**Wire Format**:
The JSON message structure exchanged between players over the WebSocket relay.
Uses Moxfield field names and zone names as canonical identifiers. Each site
adapter translates to/from its own internal names.
_Avoid_: protocol, schema

**Shared Deck**:
A game mode where both players share a single deck. The host shuffles and
sends the library order; both players draw from the same pool. Requires both
players to be on the same playtest site and the same deck URL.
_Avoid_: cooperative mode, shared library

**Traditional**:
A game mode where each player brings their own deck (e.g., Commander). Only
life totals, hand counts, and card gifts are synchronized. Supports cross-site
play (one player on Moxfield, another on Archidekt).
_Avoid_: independent mode, versus mode

**Goldfish**:
Moxfield's name for their single-player playtest page. Used historically in
code (`isGoldfishPage`, `isGoldfishPath`) but being replaced by the
site-neutral term **playtest page**.
_Avoid_: Using "goldfish" in new code

## Relationships

- A **Playtest Site** has exactly one **Site Adapter**
- A **Site Adapter** creates one **Controller** per browser tab
- A **Controller** emits events and accepts commands using **syncId** to identify cards
- The **Wire Format** uses **scryfallId** for cross-site card identity
- **Shared Deck** games require both players on the same **Playtest Site**
- **Traditional** games allow players on different **Playtest Sites**

## Example dialogue

> **Dev:** "When an Archidekt player gifts a card to a Moxfield player, how
> does the Moxfield side know what card it is?"
>
> **Answer:** "The gift message carries the **scryfallId** plus `name`, `set`,
> and `cn`. The Moxfield **Controller** materializes the card by looking up the
> **scryfallId** in its deck data, or fetching from Scryfall if needed."

## Flagged ambiguities

- "cardId" means different things on each site — Moxfield's internal ID vs
  Archidekt's `allCards` key. Use **scryfallId** for cross-site identity and
  qualify site-specific IDs explicitly (e.g., "Moxfield cardId").
- "counters" has different models — Moxfield uses a single integer, Archidekt
  uses named counter maps. The **Wire Format** uses named counters
  (`{ "+1/+1": 5 }`); Moxfield maps all counters to/from `+1/+1`.
