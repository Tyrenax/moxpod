# MoxMox

A Chrome and Firefox browser extension that enables multiplayer Magic: The
Gathering games on [Moxfield's playtest page](https://moxfield.com).

## How It Works

1. Each player opens a Moxfield deck's playtest page
2. The host clicks **Create...** in the MoxMox toolbar menu
3. The host chooses **Shared Deck** or **Traditional**
4. Guests either open the Shared Deck invite link or enter the Traditional room
   code from **Join...**

**Shared Deck** keeps library, graveyard, exile, battlefield cards, life totals,
selection highlights, and on-demand hand reveal in sync for two players.

**Traditional** supports 2-4 players with separate decks. It does not sync
cards, shared zones, battlefield state, or the battlefield divider; it still
syncs life totals and hand counts, and lets a player reveal their hand to a
chosen opponent.

## Features

- **Shared Deck mode**: Library, graveyard, exile, and battlefield state are synchronized
- **Traditional mode**: Short room codes, 2-4 players, separate decks, life and hand-count sync
- **Private hands**: Each player's hand is invisible to the opponent
- **Battlefield sync**: Card positions, tap/untap, face-up/down, counters,
  and power/toughness are synced continuously
- **Life total sync**: Players see each other's life totals in real time
- **Hand count sync**: Players see each other's current number of cards in hand
- **Traditional card gifting**: Give a card to an opponent, then have it return
  to your matching zone if it leaves their battlefield
- **Show Hand**: Reveal your hand to a chosen opponent on demand
- **Selection highlighting**: When you select cards, your opponent sees a
  blue outline on the corresponding cards
- **Battlefield divider**: A dashed line marks the boundary between your
  side and your opponent's
- **Room security**: Rooms reserve player seats via secret per-tab keys
- **Reconnect on refresh**: Room ID persists in sessionStorage

## Development

```bash
npm install                # install dependencies
node build.js              # build for both browsers → dist/chrome/ and dist/firefox/
node build.js chrome       # build for Chrome only
node build.js firefox      # build for Firefox only
node build.js --watch      # watch mode
node --test tests/*.test.js # run all tests
```

## Server

The relay server is a Cloudflare Worker + Durable Object. See
[server/README.md](server/README.md) for details.

```bash
cd server
npm install
npm run dev      # local development
npm run deploy   # deploy to Cloudflare
```

## Loading the Extension

### Chrome
1. Run `node build.js chrome`
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select `dist/chrome/`

### Firefox
1. Run `node build.js firefox`
2. Open `about:debugging#/runtime/this-firefox`
3. Click **Load Temporary Add-on…**
4. Select `dist/firefox/manifest.json`

## Architecture

See [src/README.md](src/README.md) for detailed technical documentation
covering the two-world content script architecture, sync protocol, coordinate
system, and event detection.

## Release

```bash
./release.sh           # bump minor version and create draft release
./release.sh --patch   # bump patch version
./release.sh --dryrun  # preview without changes
```

## License

MIT — see [LICENSE](LICENSE).
