// MoxMox relay server — Cloudflare Worker + Durable Object.
//
// Routes WebSocket connections to per-room Durable Objects that relay
// messages between connected clients. Each room accepts at most 2
// players, identified by unique secret keys.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check.
    if (url.pathname === '/') {
      return new Response('MoxMox Relay Server OK', {
        headers: { 'Content-Type': 'text/plain' },
      });
    }

    // Route: /room/:roomId (alphanumeric, hyphens, underscores, 1-64 chars).
    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})$/);
    if (!match) {
      return new Response('Not found. Use /room/<roomId>', { status: 404 });
    }

    const roomId = match[1];
    const id = env.ROOM.idFromName(roomId);
    const room = env.ROOM.get(id);
    return room.fetch(request);
  },
};

// Valid message types that will be relayed.
const VALID_TYPES = new Set([
  'drawCard', 'discard', 'join',
  'game-init', 'game-ready', 'game-start',
  'zone-sync',
]);

export class Room {
  constructor(state, env) {
    this.state = state;
    // playerKeys stores the two allowed player keys for this room.
    // Populated on first two 'join' messages. Persists via storage
    // so it survives hibernation.
    this.playerKeys = null; // loaded lazily from storage
  }

  async loadPlayerKeys() {
    if (this.playerKeys === null) {
      this.playerKeys = (await this.state.storage.get('playerKeys')) || [];
    }
    return this.playerKeys;
  }

  async savePlayerKeys() {
    await this.state.storage.put('playerKeys', this.playerKeys);
  }

  /** Get the playerKey stored on a WebSocket's attachment. */
  getSocketKey(ws) {
    try {
      const att = ws.deserializeAttachment();
      return att?.playerKey || null;
    } catch {
      return null;
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept with the Hibernation API so idle rooms don't burn CPU.
    this.state.acceptWebSocket(server);

    // The socket is not yet authenticated — it must send a 'join' with
    // a playerKey. We store a temporary attachment to mark it as pending.
    server.serializeAttachment({ playerKey: null, authenticated: false });

    // Notify existing authenticated sockets about the new arrival.
    const authedCount = this.getAuthenticatedSockets().length;

    // Welcome message to the connecting user.
    try {
      server.send(JSON.stringify({
        type: 'system',
        text: `Connected to room. Send join with playerKey to authenticate.`,
        peerCount: authedCount,
      }));
    } catch (_) {}

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Get only authenticated sockets. */
  getAuthenticatedSockets() {
    return this.state.getWebSockets().filter(ws => {
      try {
        const att = ws.deserializeAttachment();
        return att?.authenticated === true;
      } catch {
        return false;
      }
    });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message.length > 16384) return;

    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch (_) {
      return;
    }

    if (!parsed.type || !VALID_TYPES.has(parsed.type)) return;

    // Handle join with authentication.
    if (parsed.type === 'join') {
      await this.handleJoin(ws, parsed);
      return;
    }

    // Only relay from authenticated sockets.
    const att = ws.deserializeAttachment();
    if (!att?.authenticated) return;

    // Relay to every other authenticated connection.
    for (const s of this.getAuthenticatedSockets()) {
      if (s !== ws) {
        try { s.send(message); } catch (_) {}
      }
    }
  }

  async handleJoin(ws, parsed) {
    const keys = await this.loadPlayerKeys();
    const playerKey = parsed.playerKey;

    if (!playerKey || typeof playerKey !== 'string') {
      ws.send(JSON.stringify({
        type: 'system',
        text: 'Join rejected: missing playerKey.',
        rejected: true,
      }));
      ws.close(4001, 'Missing playerKey');
      return;
    }

    const isKnownKey = keys.includes(playerKey);

    if (!isKnownKey && keys.length >= 2) {
      // Room is full and this is not a known player reconnecting.
      ws.send(JSON.stringify({
        type: 'system',
        text: 'Room is full. Only 2 players allowed.',
        rejected: true,
      }));
      ws.close(4002, 'Room full');
      return;
    }

    // Register new key if there's room.
    if (!isKnownKey) {
      keys.push(playerKey);
      this.playerKeys = keys;
      await this.savePlayerKeys();
    }

    // Mark this socket as authenticated.
    ws.serializeAttachment({ playerKey, authenticated: true });

    const authed = this.getAuthenticatedSockets();
    const count = authed.length;

    // Notify the joining player.
    ws.send(JSON.stringify({
      type: 'system',
      text: `Joined room. ${count} player(s) here.`,
      peerCount: count,
    }));

    // Notify the other player.
    const joinMsg = JSON.stringify({
      type: 'system',
      text: `Opponent joined. ${count} player(s) in room.`,
      peerCount: count,
    });
    for (const s of authed) {
      if (s !== ws) {
        try { s.send(joinMsg); } catch (_) {}
      }
    }

    // Relay the join message to the other player.
    const relayMsg = JSON.stringify({ type: 'join' });
    for (const s of authed) {
      if (s !== ws) {
        try { s.send(relayMsg); } catch (_) {}
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    const authed = this.getAuthenticatedSockets();
    // The closing socket may still be in the list; filter it out.
    const remaining = authed.filter(s => s !== ws);

    const leaveMsg = JSON.stringify({
      type: 'system',
      text: `Opponent left. ${remaining.length} player(s) in room.`,
      peerCount: remaining.length,
    });

    for (const s of remaining) {
      try { s.send(leaveMsg); } catch (_) {}
    }

    ws.close(code, reason);
  }

  async webSocketError(ws, error) {
    ws.close(1011, 'WebSocket error');
  }
}
