# Moxfield Playtest Page — Technical Reference

> Last updated: 2026-05-10. Based on Moxfield version 2026.05.09.5.

This document describes the internals of Moxfield's "goldfish" playtest page
as discovered through live inspection of the running React application. It is
intended as a reference for building browser-extension integrations.

---

## 1. Page Structure

The playtest page lives at:

```
https://moxfield.com/decks/{deckPublicId}/goldfish
```

The page renders a game canvas with the following UI areas:

| Area | Description |
|------|-------------|
| **Top navbar** | Logo, life counter (±), Counters button, Turn indicator, Zoom controls |
| **Toolbar** | Player, Sleeves, Restart, Add Token, Shuffle, View Library, Draw, Next Turn |
| **Hand** | Cards drawn into the player's hand, displayed face-up as images |
| **Library** | Face-down stack; shows top card preview; click to open full list |
| **Battlefield** | Main play area; cards are freely positioned with drag-and-drop |
| **Graveyard** | Collapsed zone; click label for context menu or "View All" popup |
| **Exile** | Collapsed zone; same behavior as graveyard |

---

## 2. Framework & Architecture

- **React** class component (production-minified, no source maps).
- **Redux** store exists but holds global app state (decks, user prefs, etc.) —
  **not** the live playtest game state.
- **Webpack** bundles (`webpackChunkmoxfield` global).
- **No Next.js** (`__NEXT_DATA__` is absent).
- React Router handles page routing.

### Accessing React internals from the DOM

Every DOM element rendered by React has a `__reactFiber$<suffix>` property.
The suffix (e.g. `$422baita3w5`) is generated per page load and must be
discovered dynamically:

```js
const fiberKey = Object.keys(element).find(k => k.startsWith('__reactFiber'));
const fiber = element[fiberKey];
```

Walking `fiber.return` traverses the component tree upward. Class components
expose their instance via `fiber.stateNode`.

---

## 3. The Playtest Component

The core playtest logic lives in a **React class component** (minified name
varies). It can be identified by checking that `stateNode.state.zones` exists
and `stateNode.handleSaveData` is a function.

### 3.1 Component State (`this.state`)

```js
{
  // ── Game state ──────────────────────
  turn: 1,                   // Current turn number
  life: 20,                  // Life total
  energy: 0,
  poison: 0,
  experience: 0,
  rad: 0,
  tickets: 0,
  commanderDamage1: 0,
  commanderDamage2: 0,
  commanderDamage3: 0,
  mana: { ... },             // Floating mana pool

  // ── Zones ───────────────────────────
  zones: {
    hand:             [],    // Cards in hand
    library:          [],    // Draw pile (LAST element = top card)
    battlefield:      [],    // Cards in play
    graveyard:        [],    // Discard pile
    exile:            [],    // Exiled cards
    junkyard:         [],    // Unfinity junkyard
    scrapyard:        [],    // Unfinity scrapyard
    sideboard:        [],    // Sideboard cards
    command:          [],    // Command zone (commanders)
    signatureSpells:  [],    // Oathbreaker signature spells
    attractions:      [],    // Unfinity attractions
    contraptions:     [],    // Unstable contraptions
    schemes:          [],    // Archenemy schemes
    stickers:         [],    // Unfinity stickers
    planes:           [],    // Planechase planes
  },

  // ── UI state ────────────────────────
  game: '...',               // Game identifier
  isTutorOpen: false,
  isLookupOpen: false,
  isRestartModalShown: false,
  isTokenDropdownShown: false,
  isMobileDropdownShown: false,
  isManaVisible: false,
  isPreviewHidden: false,
  isGreenScreen: false,
  isSaveStateModalOpen: false,
  shouldDrawNextTurn: true,
  shouldDrawFromBottom: false,
  useSingleClickToTap: false,
  allowTokensInZones: false,
  showSaved: false,
  isDragging: false,
  selectedCards: [],
  selectedSleeves: '...',
  zoomLevel: 100,
  baseWidth: ...,
  baseHeight: ...,
  hoverCard: undefined,
  hoverViewCard: undefined,
  tokens: [],
  portalTarget: null,

  // ── Deck feature flags ──────────────
  hasCommander: false,
  hasSignatureSpells: false,
  hasSideboard: false,
  hasAttractions: false,
  hasContraptions: false,
  hasSchemes: false,
  hasStickers: false,
  hasPlanes: false,
  hasCompanion: false,
}
```

### 3.2 Library Ordering

The library array uses **reverse index order** for the draw pile:

- `library[library.length - 1]` → **top card** (drawn first)
- `library[0]` → **bottom card** (drawn last)

The `handleDraw` method confirms this:

```js
// Draws from the top (end of array)
const drawn = library.slice(library.length - 1);
```

When viewing the library in the UI panel ("View Library"), cards are displayed
top-to-bottom, which corresponds to iterating from the **last** element to the
**first**.

### 3.3 Card Objects

Every card in a zone is a rich object combining Scryfall metadata with
playtest-specific properties:

```js
{
  // ── Identity ────────────────────────
  id:           "Lmx63",    // Moxfield internal card ID
  uniqueCardId: "LDgD5",    // Moxfield unique card ID
  scryfall_id:  "bfc43...", // Scryfall UUID
  zoneId:       "72",       // Unique per-copy instance ID (string)

  // ── Card data ───────────────────────
  name:         "Dandân",
  set:          "chr",
  set_name:     "Chronicles",
  cn:           "18",       // Collector number
  layout:       "normal",
  cmc:          2,
  type:         "3",
  type_line:    "Creature — Fish",
  oracle_text:  "...",
  mana_cost:    "{U}{U}",
  power:        "4",
  toughness:    "1",
  colors:       ["U"],
  color_identity: ["U"],
  rarity:       "common",
  artist:       "...",
  legalities:   { standard: "not_legal", modern: "legal", ... },

  // ── Playtest state ──────────────────
  zone:         "hand",     // Current zone name (string)
  tapped:       false,      // 90° rotation (battlefield only)
  flipped:      false,      // Face-down (battlefield only)
  rotated:      false,      // 180° rotation (battlefield only)
  doesntUntap:  false,      // Stays tapped on untap step
  top:          820,        // Pixel Y position (battlefield only)
  left:         80,         // Pixel X position (battlefield only)
  zIndex:       3,          // Stacking order (battlefield only)
  counters:     0,          // Counter count
  // ABSOLUTE current values, NOT deltas: Moxfield auto-fills these with the
  // printed P/T for creatures on the battlefield, and editing the P/T box
  // overwrites them with the new totals. 0/0 means "untouched". Verified in a
  // live pod on 2026-08-30 -- treating them as deltas doubles every creature.
  adjustedPower:     0,
  adjustedToughness: 0,
  adjustedLoyalty:   0,
  abilities:    [],
  specialBoard: undefined,
  isToken:      false,
  isInfiniToken: false,
  defaultFinish: "nonfoil",

  // ── Pricing / metadata ──────────────
  prices:       { ... },
  card_faces:   [],
  promo_types:  [],
  multiverse_ids: [],
  // ... many more Scryfall fields
}
```

**Key identification fields:**

| Field | Purpose |
|-------|---------|
| `zoneId` | Uniquely identifies a specific copy of a card across all zones. This is the primary key for targeting cards in the extension. It is a string assigned at game initialization. |
| `id` | Moxfield's card ID. Multiple copies of the same card share the same `id`. |
| `uniqueCardId` | Another Moxfield identifier, also shared across copies. |
| `scryfall_id` | Scryfall UUID for the printing. |

---

## 4. Instance Methods

The class component exposes ~110 methods via arrow functions assigned in the
constructor. The most relevant for extension use:

### 4.1 State Mutation

| Method | Signature | Description |
|--------|-----------|-------------|
| `setState` | `(update, callback)` | Standard React setState. `update` is an object merged into state. `callback` fires after re-render. |
| `handleSaveData` | `()` | Serializes `state.zones` to localStorage. Called after every mutation. |
| `getInitialState` | `()` | Returns the fresh starting state (used by restart). |

### 4.2 Card Movement

| Method | Signature | Description |
|--------|-----------|-------------|
| `moveCards` | `(cards[], fromZone, toZone, topPos?, bottomPos?, flipped?, tapped?, rotated?)` | Moves cards between zones. Handles battlefield positioning. |
| `reorderHand` | `(fromIndex, toIndex)` | Drag-reorder within the hand zone. |
| `changeCardPositionAndZone` | `(card, monitor, toZone, offset?)` | Drag-and-drop handler (uses React DnD monitor). |
| `changeCardPosition` | `(card, monitor)` | Repositions a card on the battlefield. |

### 4.3 Game Actions

| Method | Signature | Description |
|--------|-----------|-------------|
| `handleDraw` | `()` | Draws the top card of the library into the hand. |
| `handleShuffle` | `(zone='library')` | Fisher-Yates shuffles the specified zone. |
| `handleNextTurn` | `()` | Advances the turn counter; may auto-draw and untap. |
| `handleRestart` | `()` | Shows the restart confirmation modal. |
| `handleConfirmRestart` | `()` | Resets to the initial game state. |
| `handleUntapAll` | `()` | Untaps every card on the battlefield. |

### 4.4 Card State

| Method | Signature | Description |
|--------|-----------|-------------|
| `handleTap` | `(card)` | Toggles tapped state. |
| `handleFlip` | `(card)` | Toggles face-down state. |
| `handleRotate` | `(card)` | Toggles 180° rotation. |
| `handleDoesntUntap` | `(card)` | Toggles "doesn't untap" flag. |
| `handleAdjustPowerToughness` | `(card, power, toughness)` | Sets modified P/T. |
| `handleAdjustCounters` | `(card, counters)` | Sets counter count. |
| `handleIncrementCounters` | `(card, delta)` | Increments counter count. |
| `handleAdjustLoyalty` | `(card, loyalty)` | Sets modified loyalty. |
| `handleIncrementLoyalty` | `(card, delta)` | Increments loyalty. |

### 4.5 Tokens

| Method | Signature | Description |
|--------|-----------|-------------|
| `handleAddToken` | `(tokenCard, top, left)` | Creates a token on the battlefield. |
| `handleRemoveToken` | `(card)` | Removes a token from the battlefield. |
| `handleMakeTokenFromCard` | `(card)` | Creates a token copy of an existing card. |
| `handleMakeInfiniToken` | `(...)` | Creates a custom InfiniToken. |

### 4.6 Life & Counters

| Method | Description |
|--------|-------------|
| `handleSetLife(n)` | Set life to exact value. |
| `handleGainLife(n)` | Increase life. |
| `handleLoseLife(n)` | Decrease life. |
| `handleSetPoison(n)` | Set poison counters. |
| `handleSetEnergy(n)` | Set energy counters. |
| `handleSetExperience(n)` | Set experience counters. |
| `handleSetRad(n)` | Set rad counters. |
| `handleSetTickets(n)` | Set ticket counters. |
| `handleFlipCoin()` | Flip a coin (logged). |
| `handleRollD4/D6/D8/D12/D20()` | Roll dice (logged). |

### 4.7 UI

| Method | Description |
|--------|-------------|
| `handleTutorOpen()` / `Close()` | Open/close the library search panel. |
| `handleZoomIn()` / `ZoomOut()` | Adjust battlefield zoom. |
| `handleToggleMana()` | Show/hide the mana pool. |
| `handleTogglePreview()` | Show/hide the card preview on hover. |
| `handleToggleGreenScreen()` | Toggle chroma-key background. |
| `handleToggleNextTurnDraw()` | Toggle auto-draw on next turn. |
| `handleToggleDrawFromBottom()` | Toggle drawing from the bottom. |
| `handleToggleTokensInZones()` | Allow/disallow tokens in non-battlefield zones. |

---

## 5. Context Menus

### 5.1 Individual Card Menu (Library / Graveyard / Exile viewer)

Right-clicking a card or clicking its "⋯" menu shows:

| Action | Hotkey | Description |
|--------|--------|-------------|
| Move to Battlefield | B | Place face-up, untapped |
| Move to Battlefield Flipped | — | Place face-down |
| Move to Battlefield Tapped | — | Place tapped (90°) |
| Move to Battlefield Rotated | — | Place rotated (180°) |
| Move to Hand | H | Move to hand |
| Move to Top of Library | L | Place on top of draw pile |
| Move to Bottom of Library | Shift+L | Place on bottom of draw pile |
| Move to Graveyard | G | Move to graveyard (not shown if already there) |
| Move to Exile | E | Move to exile (not shown if already there) |
| View Card | — | Opens card detail view |

### 5.2 Zone Label Menu (Graveyard / Exile)

Clicking the zone label (e.g. "Graveyard (2)") shows:

| Action | Description |
|--------|-------------|
| View All | Opens the zone viewer panel |
| Move All to Library | Move all cards to top of library |
| Move All to Bottom of Library | Move all cards to bottom of library |
| Move All to Exile / Library | Move all cards to the other zone |
| Move All to Hand | Move all cards to hand |
| Move All Creatures to Hand | Filter by type |
| Move All Lands to Hand | Filter by type |
| Move All Enchantments to Hand | Filter by type |
| Move All Artifacts to Hand | Filter by type |
| Move All Planeswalkers to Hand | Filter by type |

---

## 6. Persistence

### 6.1 Save Mechanism

`handleSaveData()` serializes the game state to **localStorage** using the
key `playtester_savestate`. The helper functions `(0,w.Lsw)(key, data)` and
`(0,w.G2W)(key)` are wrappers around `localStorage.setItem` / `getItem`
with JSON serialization, stored inside a top-level `state` localStorage key.

The serialized format is:

```js
{
  publicId: "CsFDriThmEGanyZ5YpOunQ",  // Deck ID
  zones: {
    hand: [
      {
        cardId: "Lmx63",         // card.id
        zoneId: "72",            // unique instance ID
        isInfiniToken: false,
        specialBoard: undefined,
        layout: "normal",
        adjustedPower: 0,
        adjustedToughness: 0,
        adjustedLoyalty: 0,
        counters: 0,
        top: undefined,
        left: undefined,
        tapped: false,
        rotated: false,
        flipped: false,
        doesntUntap: false,
      },
      // ...
    ],
    library: [ ... ],
    battlefield: [ ... ],
    // ... all zones
  }
}
```

### 6.2 Save State Restore

On page load, `handleCheckForSaveState()` checks if a saved state exists
for the current deck's `publicId`. If found, a modal prompts the user to
restore or discard. Restoring calls `handleRestoreSaveState()` which
reconstructs full card objects by looking up `cardId` values against the
deck's mainboard, sideboard, and special boards.

### 6.3 No Server-Side Validation

The playtest state is **entirely client-side**. There are no API calls to
validate or persist game state on Moxfield's servers. Cards can be freely
added, removed, reordered, or modified without any server-side checks.

---

## 7. Content Script World Isolation

Browser extensions using Manifest V3 run content scripts in an **isolated
world** by default. This means `document.querySelector('div').__reactFiber$xxx`
will be `undefined` because the React fiber properties are set by page-world
JavaScript.

### Solutions

**Chrome (MV3):** Add `"world": "MAIN"` to the content script entry in
`manifest.json`:

```json
{
  "content_scripts": [{
    "matches": ["https://moxfield.com/*"],
    "js": ["playtest-content.js"],
    "world": "MAIN",
    "run_at": "document_idle"
  }]
}
```

**Firefox (MV3):** Supports `"world": "MAIN"` since Firefox 128.

**Communication:** Code running in `MAIN` world cannot use `chrome.runtime`
APIs. To communicate with the background script, use `window.postMessage` or
`CustomEvent` between the MAIN-world script and a companion ISOLATED-world
content script.

---

## 8. Practical Notes

### Finding the Playtest Instance

```js
function findPlaytestInstance() {
  for (const el of document.querySelectorAll('main, div')) {
    const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (!fiberKey) continue;
    let current = el[fiberKey];
    for (let depth = 0; depth < 50 && current; depth++) {
      const s = current.stateNode;
      if (s && s !== window && s.state?.zones && typeof s.handleSaveData === 'function') {
        return s;
      }
      current = current.return;
    }
  }
  return null;
}
```

### Mutating State

All mutations must go through `setState` followed by `handleSaveData`:

```js
const instance = findPlaytestInstance();
const zones = instance.state.zones;

// Example: move top card of library to hand
const newLib = [...zones.library];
const card = newLib.pop();
card.zone = 'hand';
const newHand = [...zones.hand, card];

instance.setState(
  { zones: { ...zones, library: newLib, hand: newHand } },
  () => instance.handleSaveData()
);
```

**Important:** `setState` is asynchronous. Use the callback to read updated
state or chain further operations. Rapid sequential calls without awaiting
callbacks can cause state clobbering.

### Battlefield Positioning

Battlefield cards use pixel coordinates (`top`, `left`) relative to the
battlefield container. The coordinate system starts at (0, 0) in the top-left
corner. Values are scaled by the zoom level:

```js
const scaledWidth = baseWidth * zoomLevel / 100;
const scaledHeight = baseHeight * zoomLevel / 100;
```

Moxfield's `moveCards` method automatically prevents cards from overlapping
by nudging positions when placing cards on the battlefield.

### Keyboard Shortcuts

The playtest page listens for keyboard shortcuts via `handleHotkey`:

| Key | Action |
|-----|--------|
| B | Move selected card to battlefield |
| H | Move to hand |
| L | Move to top of library |
| Shift+L | Move to bottom of library |
| G | Move to graveyard |
| E | Move to exile |
| T | Tap/untap |
| F | Flip (face down/up) |
