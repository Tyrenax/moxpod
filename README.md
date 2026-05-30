# MoxMox

A Chrome and Firefox browser extension that enhances multiplayer Magic: The
Gathering games on [Moxfield's playtest page](https://moxfield.com).

**[Install from GitHub Releases](https://github.com/natefinch/moxmox/releases)**

## Traditional Competitive Games Like Commander:

https://github.com/user-attachments/assets/c510632e-7dfd-4172-a3ee-634404ee0ef1

## Shared Deck Games Like Dan Dan:

https://github.com/user-attachments/assets/3e9a82cb-7dec-487e-96cc-f2c6b8189d48

## How It Works

1. Each player opens a Moxfield deck's playtest page
2. The host clicks **Create...** in the MoxMox toolbar menu
3. The host chooses **Shared Deck** or **Traditional**
4. Guests either open the Shared Deck invite link or enter the Traditional room
   code from **Join...**

**Shared Deck** (DanDan) keeps library, graveyard, exile, battlefield cards, life totals,
selection highlights, and on-demand hand reveal in sync for two players.

**Traditional** supports 2-4 players with separate decks. Shows other player's life totals 
and hand counts, lets each player view the other player's graveyards, and lets you privately
reveal your hand to a chosen opponent.


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

See [DEVELOPMENT.md](DEVELOPMENT.md) for build instructions, server setup,
extension loading, architecture, and release process.

## License

MIT — see [LICENSE](LICENSE).
