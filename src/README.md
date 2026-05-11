# MoxMox — Source Architecture

## Overview

MoxMox is a browser extension that enables two-player Magic: The Gathering
games on [Moxfield's playtest page](https://moxfield.com). It hooks into
Moxfield's React internals to read and manipulate the game state, and uses a
Cloudflare Durable Object relay server to synchronize state between two
players over WebSocket.

## File Structure

```
src/
├── content.js          ISOLATED-world content script (UI, WebSocket, orchestration)
├── content-main.js     MAIN-world content script (React access, game operations)
├── popup.html / .js    Extension popup (connection status + message log)
├── styles.css          Injected styles (button, modals, remote highlight)
├── background.js       Service worker (currently minimal)
├── shared/
│   └── room.js         Room ID generation, URL utilities
└── playtest/
    ├── index.js         PlaytestController — high-level API for game manipulation
    ├── bridge.js        React fiber traversal to find the playtest component
    ├── diff.js          Zone snapshot diffing for event detection
    └── MOXFIELD_INTERNALS.md   Reference doc on Moxfield's React internals
```

## Two-World Architecture

Chrome MV3 content scripts run in an **isolated world** by default, which
cannot access page JavaScript (React state, etc.). MoxMox uses two content
scripts:

| Script | World | Can Access | Purpose |
|--------|-------|-----------|---------|
| `content.js` | ISOLATED | `chrome.runtime`, DOM | UI injection, WebSocket, sync orchestration |
| `content-main.js` | MAIN | React internals, page JS | PlaytestController, game state manipulation |

They communicate via `window.postMessage` with a `{ moxmox: 'moxmox' }` tag
and a `from` field (`'isolated'` or `'main'`).

### Command/Response Protocol

```
content.js (ISOLATED)                    content-main.js (MAIN)
     │                                          │
     │── postMessage {cmd, id, action, params} ─►│
     │                                          │── dispatch(action, params)
     │◄── postMessage {result, id, data} ───────│
     │                                          │
     │◄── postMessage {game-event, event} ──────│  (async, from PlaytestController hooks)
```

Commands return Promises (with 10-second timeout). Game events are
fire-and-forget from MAIN → ISOLATED.

## Connection Flow

### Room Creation (Host)

1. User clicks **Play Together** button in the playtest navbar
2. Extension generates a 16-character base62 room ID and a 32-character
   cryptographic player key
3. Opens WebSocket to `wss://moxmox-relay.nate-finch.workers.dev/room/<roomId>`
4. Sends `{ type: 'join', playerKey: '...' }` to authenticate
5. Shows popup with shareable URL (auto-copied to clipboard)
6. Room ID, role (`host`), and player key are stored in `sessionStorage`
   for reconnection on page refresh

### Joining (Guest)

1. Guest opens URL with `?moxmoxroom=<roomId>` query parameter
2. Extension extracts room ID, removes param from URL bar via `replaceState`
3. Generates its own unique player key
4. Connects and sends `join` with its player key

### Room Security

The relay server (Durable Object) stores up to **2 player keys** per room in
persistent storage. Any third connection without one of the two registered
keys is rejected with close code `4002`. Keys survive server hibernation.
This prevents accidental third-tab connections.

## Game Start Flow

When both players are connected (detected via `peerCount >= 2` in system
messages), the game start sequence begins automatically:

```
        HOST                          SERVER                          GUEST
         │                              │                              │
         │── Both connected ────────────┼── Both connected ────────────│
         │                              │                              │
    ┌────┴────┐                         │                         ┌────┴────┐
    │ Show    │                         │                         │ Show    │
    │ modal   │                         │                         │ modal   │
    └────┬────┘                         │                         └────┬────┘
         │                              │                              │
    1. Reset hand → library             │                              │
    2. Shuffle library                  │                              │
    3. Assign syncIds to all cards      │                              │
    4. Draw 7 cards                     │                              │
         │                              │                              │
    5. Get library (73 cards)           │                              │
         │── game-init {library} ──────►│──────────────────────────────►│
         │                              │                         6. Reset hand → library
         │                              │                         7. Reorder library to match
         │                              │                         8. Draw 7 cards
         │◄─────────────────────────────│◄── game-ready {count:7} ────│
         │                              │                              │
    9. Remove top 7 from library        │                              │
         │── game-start ───────────────►│──────────────────────────────►│
         │                              │                              │
    Enable Start button                 │                 Enable Start button
```

After both click **Start!**, ongoing sync begins. Both players end with
**66 cards** in a synchronized library and **7 cards** each in their
independent hands.

### Anti-Echo: `syncDepth` Counter

All game-start operations and remote sync commands run inside `withSync()`,
which increments a `syncDepth` counter. The PlaytestController event hooks
check `syncDepth > 0` and skip forwarding events during these operations.
This prevents infinite echo loops (local change → send to remote → remote
applies → remote sends back → ...).

## Card Identity

### `syncId` — Cross-Player Card Identity

Each card copy is assigned a unique `syncId` string during game initialization
(after shuffling). This ID is shared between both players and used for all
sync operations. It survives zone changes and is stable across the entire
game session.

| Field | Scope | Purpose |
|-------|-------|---------|
| `card.id` | Moxfield | Card template ID (shared by all copies of the same card) |
| `card.zoneId` | Per-player | Unique per-copy within one player's game (assigned by Moxfield) |
| `card.syncId` | Cross-player | Unique per-copy across both players (assigned by MoxMox at game start) |

### Card Materialization

When a card needs to appear on the remote player's side (e.g., opponent plays
a card from hand to graveyard), the remote player doesn't have that card in
any zone. The system uses `instance.getCardFromId(cardId, usedZoneIds)` to
create a fresh card object from the deck data, assigns a new `zoneId`, and
preserves the `syncId` from the sync message.

## Zone Sync Rules

### Zone Categories

| Zone | Category | Sync Behavior |
|------|----------|--------------|
| **library** | Shared | Identical content and order on both sides |
| **graveyard** | Shared | Identical content and order on both sides |
| **exile** | Shared | Identical content and order on both sides |
| **hand** | Private | Each player has their own hand; invisible to opponent |
| **battlefield** | Semi-shared | Cards visible to both; position/state synced continuously |

### Sync Operations (`zone-sync` Messages)

| Action | When | Effect on Remote |
|--------|------|-----------------|
| `add` | Card enters a shared zone from a private zone | Materialize card in the shared zone |
| `remove` | Card leaves a shared zone or battlefield | Remove card from that zone |
| `move` | Card moves between two shared zones | Move card between zones |
| `add-battlefield` | Card placed on battlefield | Materialize with mirrored position + 180° rotation |
| `update-state` | Battlefield card state changes | Update properties (tap, position, P/T, counters, etc.) |
| `reorder` | Shared zone cards reordered | Reorder to match new `syncId` sequence |
| `highlight` | Player selects/deselects cards | Apply/remove blue highlight on opponent's view |

### Zone Transition Matrix

What happens when a card moves between zones:

| From ↓ / To → | Shared Zone | Battlefield | Hand |
|----------------|-------------|-------------|------|
| **Shared Zone** | `move` | `add-battlefield` + `remove` from shared | `remove` from shared |
| **Battlefield** | `remove` from BF + `add` to shared | (local drag, synced via `update-state`) | `remove` from BF |
| **Hand** | `add` to shared | `add-battlefield` | (no sync needed) |

## Battlefield Sync

### Coordinate System

Moxfield uses pixel coordinates (`top`, `left`) for battlefield card
positions, relative to the battlefield container's top-left corner.

For cross-player sync, positions are transmitted as **percentages** of the
battlefield dimensions (using the card's center point):

```
Sender:
  centerX = card.left + cardWidth / 2
  centerY = card.top + cardHeight / 2
  pctX = centerX / battlefieldWidth
  pctY = centerY / battlefieldHeight

Receiver (mirrored for 180° table rotation):
  mirroredCenterX = (1 - pctX) * usableWidth
  mirroredCenterY = (1 - pctY) * battlefieldHeight
  card.left = mirroredCenterX - cardWidth / 2
  card.top  = mirroredCenterY - cardHeight / 2
```

The **usable width** excludes the toolbar buttons at the top-right of the
battlefield (`120px * zoom + cardWidth`), so mirrored cards don't land
behind the UI controls.

### Card Dimensions

Card width and height are derived from Moxfield's state:
```
cardWidth  = instance.state.baseWidth  * (zoomLevel / 100)
cardHeight = instance.state.baseHeight * (zoomLevel / 100)
```

### Properties Synced Continuously

| Property | Description |
|----------|-------------|
| `top`, `left` | Position (translated via center-point mirroring) |
| `tapped` | 90° rotation (tapped/untapped) |
| `flipped` | Face-down/face-up |
| `rotated` | 180° rotation |
| `doesntUntap` | Stays tapped on untap step |
| `counters` | Counter count |
| `adjustedPower` | Modified power |
| `adjustedToughness` | Modified toughness |
| `adjustedLoyalty` | Modified loyalty |

### Selection Highlighting

When a player selects cards (yellow border in Moxfield), the opponent sees
a **blue outline** (`moxmox-remote-highlight` CSS class) on the same cards.
This is implemented via:

1. MAIN-world polls `instance.state.selectedCards` every 200ms
2. Changes are sent as `selection-changed` events
3. Remote side applies CSS classes to matching DOM elements via fiber tree
   traversal

The blue highlight is purely visual (CSS outline) and doesn't affect the
remote player's own selection state.

## Relay Server

The server (`server/src/index.js`) is a Cloudflare Worker + Durable Object:

- **Worker**: Routes `/room/<roomId>` requests to per-room Durable Objects
- **Durable Object**: Manages WebSocket connections with the Hibernation API
  - Authenticates players via `playerKey` in `join` messages
  - Stores up to 2 keys in persistent storage
  - Rejects third connections with close code `4002`
  - Relays valid JSON messages between authenticated peers
  - Sends system messages on join/leave with `peerCount`

### Message Size Limit

Messages are limited to **16KB** (the `game-init` message with 73+ card IDs
is typically ~3KB).

### Valid Message Types

`join`, `game-init`, `game-ready`, `game-start`, `zone-sync`,
`drawCard`, `discard`

## Event Detection

The `PlaytestController` (in `playtest/index.js`) detects game state changes
by monkey-patching `instance.handleSaveData()`. Every time Moxfield saves
state (after any user action), the controller diffs the previous zone
snapshot against the current state and emits events:

| Event | Trigger |
|-------|---------|
| `card:zone-changed` | Card moved between zones |
| `card:added` | New card appeared (e.g., token) |
| `card:removed` | Card deleted from all zones |
| `card:state-changed` | Battlefield card property changed |
| `zone:reordered` | Zone has same cards in different order |

The diff logic is in `playtest/diff.js` and compares card `zoneId` values
across snapshots to detect additions, removals, and movements.

## Persistence

- **Game state**: Moxfield saves to `localStorage` key `playtester_savestate`
  via `instance.handleSaveData()`
- **Room connection**: `sessionStorage` stores `moxmox_room`,
  `moxmox_role`, and `moxmox_player_key` for reconnection on page refresh
- **Server player keys**: Durable Object storage (survives hibernation)
