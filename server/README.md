# MoxMox Relay Server

A Cloudflare Worker + Durable Object that relays WebSocket messages between
browser extension clients connected to the same room.

## Architecture

```
┌─────────────┐         ┌─────────────────────────────────────────────┐
│  Extension  │         │            Cloudflare Edge                  │
│  (popup.js) │◄──WSS──►│  Worker  ──►  Durable Object (per room)    │
└─────────────┘         │              ┌────────────────────────┐     │
                        │              │ Room DO                │     │
┌─────────────┐         │              │  • accepts WebSockets  │     │
│  Extension  │◄──WSS──►│  Worker  ──► │  • relays messages     │     │
│  (popup.js) │         │              │  • tracks connections  │     │
└─────────────┘         │              └────────────────────────┘     │
                        └─────────────────────────────────────────────┘
```

Each room is an independent Durable Object instance. The Worker is a thin
router that maps room IDs to DO instances.

## How Cloudflare Durable Objects Work

### The Basics

A **Durable Object (DO)** is a single-instance, stateful JavaScript class that
runs on Cloudflare's edge. Key properties:

- **Single-threaded**: Only one instance of a DO with a given ID exists at a
  time, globally. All requests to that ID are routed to the same instance. This
  eliminates concurrency bugs — no locking needed.
- **Co-located**: The DO runs in the data center closest to the first client
  that creates it, then stays there.
- **Addressable by name**: You get a DO instance via
  `env.BINDING.idFromName("some-string")`, then `env.BINDING.get(id)`. The same
  name always produces the same ID, so two clients asking for room `"my-game"`
  get routed to the same DO.

### WebSocket Hibernation API

Durable Objects support the **WebSocket Hibernation API**, which is critical
for cost on the free plan. Instead of the DO staying awake while connections
are idle, it can hibernate:

- Call `this.state.acceptWebSocket(ws)` instead of manually tracking sockets.
- Implement event handlers: `webSocketMessage()`, `webSocketClose()`,
  `webSocketError()`.
- The runtime manages the socket lifecycle. When no messages are flowing, the
  DO hibernates — connections stay open at the edge but the DO isn't using
  compute time.
- Call `this.state.getWebSockets()` to get all currently connected sockets.

**Without hibernation**, a DO stays awake as long as any WebSocket is
connected, burning duration-based billing. **With hibernation**, you only pay
for the time spent processing messages.

### What Happens on the Free Plan

- **100,000 Worker requests/day** — WebSocket upgrade requests count, individual
  messages do not. At 200 pairs, that's ~400 upgrades/day, well within limits.
- **No per-message charges** — messages flow through the DO without counting as
  separate Worker invocations.
- **Durable Objects must use `new_sqlite_classes`** — the free plan requires
  SQLite-backed DOs. This is set in `wrangler.toml`:
  ```toml
  [[migrations]]
  tag = "v1"
  new_sqlite_classes = ["Room"]
  ```
  Using `new_classes` instead will fail with error code 10097.

### Important Caveats

- **No persistent in-memory state during hibernation**: Class instance fields
  (like `this.users = []`) are wiped when the DO hibernates. Use
  `this.state.getWebSockets()` for socket tracking and
  `ws.serializeAttachment()` / `ws.deserializeAttachment()` for per-socket
  metadata. Or use `this.state.storage` for persistent key-value data.
- **Single-region placement**: The DO runs in one data center. If two players
  are on opposite sides of the world, one of them gets higher latency. For a
  card game this is fine.
- **100-second idle timeout on free plan**: Cloudflare closes WebSocket
  connections idle for 100 seconds. The hibernation API keeps the connection
  alive through this as long as the runtime manages it, but extremely long idle
  periods may still cause disconnects. Implement reconnection logic on the
  client side.

## How It's Set Up in MoxMox

### Server Components

**`wrangler.toml`** — Tells Cloudflare about the Worker and its Durable Object:

```toml
name = "moxmox-relay"
main = "src/index.js"
compatibility_date = "2025-01-01"

[durable_objects]
bindings = [
  { name = "ROOM", class_name = "Room" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["Room"]
```

**`src/index.js`** — Contains two exports:

1. **`default` (the Worker)**: Routes incoming requests.
   - `GET /` — health check.
   - `GET /room/:roomId` — validates the room ID (`/^[a-zA-Z0-9_-]{1,64}$/`),
     creates a DO stub via `env.ROOM.idFromName(roomId)`, and forwards the
     request to the DO.

2. **`Room` class (the Durable Object)**: Manages WebSocket connections for one
   room.
   - `fetch()` — accepts WebSocket upgrades, calls
     `this.state.acceptWebSocket()`, sends system messages about join/user
     count.
   - `webSocketMessage()` — validates incoming messages (must be JSON, ≤1KB,
     known type), then relays to all other connections.
   - `webSocketClose()` — notifies remaining users that someone left.
   - `webSocketError()` — closes the socket cleanly.

### Extension Components

**`src/popup.js`** — Opens a WebSocket directly from the popup page to
`wss://moxmox-relay.nate-finch.workers.dev/room/<roomId>`. The connection
exists only while the popup is open (MV3 popups close when they lose focus).

**`manifests/base.json`** — Includes `host_permissions` for `*.workers.dev` so
the extension can connect to the relay server.

### Message Protocol

All messages are JSON strings sent over the WebSocket.

**Client → Server (relayed to other clients):**

| Type | Format | Description |
|------|--------|-------------|
| `drawCard` | `{"type":"drawCard"}` | Player draws a card |
| `discard` | `{"type":"discard","cardName":"..."}` | Player discards a named card |

**Server → Client (system messages, not relayed):**

| Type | Format | Description |
|------|--------|-------------|
| `system` | `{"type":"system","text":"..."}` | Join/leave notifications with user count |

The server validates that relayed messages have a known `type` and are under
1KB. Unknown types are silently dropped.

### Message Flow

```
Player A popup                    Cloudflare DO                    Player B popup
     │                                │                                │
     │──── WSS connect ──────────────►│                                │
     │◄─── system: "1 user(s)" ──────│                                │
     │                                │◄──── WSS connect ──────────────│
     │◄─── system: "user joined" ────│───── system: "2 user(s)" ─────►│
     │                                │                                │
     │──── drawCard ─────────────────►│───── drawCard ────────────────►│
     │                                │                                │
     │                                │◄──── discard("Lightning") ─────│
     │◄─── discard("Lightning") ─────│                                │
     │                                │                                │
```

The sender logs its own message locally in the popup; the server only relays
to other connections.

## Development

```bash
npm install          # install wrangler
npm run dev          # start local dev server on localhost:8787
npm run deploy       # deploy to Cloudflare
```

For local development, change `WS_URL` in `src/popup.js` to
`ws://localhost:8787`.

## Deploying

Prerequisites:
1. A free Cloudflare account (no credit card required)
2. `wrangler login` to authenticate

Then:
```bash
npm run deploy
```

The first deploy requires visiting the Cloudflare dashboard **Workers & Pages**
section at least once to create your `*.workers.dev` subdomain.

## Cost

At the expected scale (20–200 pairs, ~1 message every 5–10 seconds per
direction), this runs entirely within Cloudflare's free tier:

- ~400 WebSocket upgrades/day (free limit: 100,000/day)
- Messages flow through DOs without counting as requests
- Hibernation keeps idle rooms free of compute cost
- No storage costs (we don't persist messages)
