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

1. User opens **Invite...** from the toolbar menu
2. User chooses **Shared Deck** or **Traditional**
3. Shared Deck generates a 16-character base62 room ID and full Moxfield URL
4. Traditional generates a short uppercase room code after the host picks
   max players (2-4), then creates the room in the Durable Object
5. The extension opens a WebSocket to
   `wss://moxmox-relay.nate-finch.workers.dev/room/<roomId>`
6. It sends `{ type: 'join', playerKey: '...', gameType: '...' }` to
   authenticate and reserve/reuse the player's seat
7. Room ID, role, game type, and player key are stored in `sessionStorage`
   for reconnection on page refresh

### Joining (Guest)

1. Shared Deck guests open a URL with `?moxmoxroom=<roomId>` query parameter
2. Traditional guests open **Join...** and enter the short room code
3. The extension generates its own unique player key
4. It connects and sends `join` with the player key and game type

### Room Security

The relay server (Durable Object) stores reserved player keys per room in
persistent storage: 2 seats for Shared Deck and 2-4 seats for Traditional.
Connections without a known key are rejected when all seats are reserved.
Keys survive server hibernation and disconnects so players can reconnect.

## Game Start Flow

For Shared Deck, when both players are connected (detected via `peerCount >= 2`
in system messages), the game start sequence begins automatically:

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

These zone sync rules apply to Shared Deck games. Traditional games do not sync
card movement, battlefield state, shared zone contents, selection highlights, or
the battlefield divider.

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
positions, referring to the **top-left corner** of the card element,
relative to the battlefield container's top-left corner.

For cross-player sync, positions are transmitted as **center-point
percentages** of the battlefield dimensions. Using the card center (not
the corner) is essential because the card is a rectangle — mirroring a
corner point produces an offset equal to the card's dimensions.

Each axis is sent **independently**: if only the X position changes, only
`pctX` is included in the message. The receiver never invents a value for
the missing axis.

```
Sender (converts top-left corner → center → percentage):
  centerX = card.left + cardW / 2
  centerY = card.top  + cardH / 2
  pctX = centerX / usableWidth
  pctY = centerY / battlefieldHeight

Receiver (mirrors center percentage → local center → top-left corner):
  mirroredCenterX = (1 - pctX) * usableWidth
  mirroredCenterY = (1 - pctY) * battlefieldHeight
  card.left = clamp(mirroredCenterX - cardW / 2,  0,  usableWidth - cardW)
  card.top  = clamp(mirroredCenterY - cardH / 2,  0,  height - cardH)
```

**Why center-based mirroring?** A card at the very bottom of the
battlefield has `top = height - cardH`. Mirroring the corner directly
would give `mirroredTop = cardH` (one card height from the top), but the
correct result is `mirroredTop = 0` (flush with the top). Using the
center eliminates this off-by-one-card-height error.

The **usable width** excludes the toolbar buttons at the top-right of the
battlefield (`120px × zoom + cardWidth`), so mirrored cards don't land
behind the UI controls. Both sender and receiver use `usableWidth` for
the X axis, keeping the coordinate systems aligned.

### Card Dimensions

Card width and height are derived from Moxfield's state:
```
cardW = instance.state.baseWidth  × (zoomLevel / 100)
cardH = instance.state.baseHeight × (zoomLevel / 100)
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

`join`, `game-init`, `game-ready`, `game-start`, `zone-sync`, `life-sync`,
`drawCard`, `discard`

### Join Messages

The `join` message includes `playerKey` for authentication and `username`
for display. The server stores the username in the socket attachment and
relays it to existing players when a new player joins, ensuring both sides
learn each other's name.

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

### Life Change Detection

Life total changes are detected via a `componentDidUpdate` patch on the
React class component instance. This catches all life changes regardless of
which Moxfield handler caused them (buttons, keyboard, reset, etc.), unlike
the `handleSaveData` hook which only fires on zone mutations.

```js
instance.componentDidUpdate = function(prevProps, prevState, snapshot) {
  originalComponentDidUpdate.call(this, ...);
  if (prevState.life !== this.state.life) {
    // emit life:changed event
  }
};
```

## Life Total Sync

Life totals are displayed in the toolbar widget next to each player's name
with a ❤️ icon. Changes are sent via `life-sync` messages:

```json
{ "type": "life-sync", "life": 18 }
```

In Shared Deck, local life is initialized and broadcast when the player clicks
Start. In Traditional, life is initialized and broadcast immediately after
joining. Ongoing changes are detected via `componentDidUpdate` and forwarded
automatically.

## Opponent Zone Views

Players can voluntarily reveal their hand by clicking a remote player's name
(▾ dropdown) → **Show Hand**. In Traditional, the reveal is targeted to that
specific player. This sends a `reveal-hand` zone-sync message containing card
display data (name, set, collector number):

```json
{
  "type": "zone-sync",
  "action": "reveal-hand",
  "targetId": "p2",
  "cards": [{ "name": "Island", "set": "und", "cn": "90", "layout": "normal" }],
  "username": "NateFinch"
}
```

The receiver displays the cards as images (loaded from Scryfall) in a
bottom-anchored overlay panel that can be dismissed with ✕.

Traditional games also add **View Graveyard** and **View Exile** to each
opponent's menu. These are pull-based: the local client sends a targeted
`request-zone-view` message, the opponent client reads its local zone, and the
response is routed back only to the requester. Graveyard/exile results display
as a vertical scrollable stack with overlapped cards; hovering a card expands it
to full height.

## Username System

Players must set a username before starting a game. The username is stored
in `chrome.storage.local` (persists across sessions) and sent with the
`join` message.

- If no username is set when creating/joining a room or opening an invite
  link, a modal prompt appears asking for one
- Usernames display in the toolbar widget next to status dots
- Remote usernames appear as clickable dropdowns (▾) for actions
  like **Show Hand**

## Toolbar Widget

The extension injects a multi-line widget into Moxfield's playtest navbar:

```
☰  MoxMox — Play Together
🟢 NateFinch           ❤️ 20    🟢 Player 3 ▾          ❤️ 40
🟢 Opponent ▾          ❤️ 18    🟢 Player 4 ▾          ❤️ 40
```

- **Line 1**: Title with hamburger menu (☰) — contains "Invite...", "Join...",
  and "Leave Game" while connected. In an active Traditional game, "Invite..."
  shows the current room code instead of creating a new room.
- **Player grid**: Local player is always the upper-left slot. With more than
  two total players, slots 3 and 4 move into a second column next to slots 1
  and 2.

## Save State Handling

Moxfield may show a "Save State Found" dialog on page load if a previous
playtest session was saved. During game start (both host and guest), the
extension automatically dismisses this dialog by calling
`instance.handleDiscardSaveState()` before resetting the game state.

## Battlefield Divider

A dashed horizontal line is injected at the vertical center of the
battlefield container when a Shared Deck game starts. It uses
`position: absolute; top: 50%` with `pointer-events: none` so it stays
centered during zoom changes and doesn't interfere with card dragging.

## Persistence

- **Game state**: Moxfield saves to `localStorage` key `playtester_savestate`
  via `instance.handleSaveData()`
- **Room connection**: `sessionStorage` stores `moxmox_room`,
  `moxmox_role`, `moxmox_game_type`, and `moxmox_player_key` for reconnection
  on page refresh
- **Connection reliability**: the content script sends a lightweight WebSocket
  heartbeat and automatically reconnects after unexpected disconnects
- **Username**: `chrome.storage.local` stores `moxmox_username` (persists
  across browser sessions)
- **Server player keys**: Durable Object storage (survives hibernation)

## Extension Popup

The extension popup (`popup.html` / `popup.js`) shows:

- **Username field**: Set/update your display name (saved to
  `chrome.storage.local`)
- **Connection status**: You and remote player status dots with connection state
- **Role**: Host or Guest
- **Game type**: Shared Deck or Traditional
- **Room ID**: Current room identifier
- **Message log**: Real-time WebSocket message log (blue = incoming,
  green = outgoing)

The popup queries the content script for initial state via
`chrome.tabs.sendMessage`, then listens for live updates pushed from the
content script via `chrome.runtime.sendMessage`.
