#!/usr/bin/env node
// MoxPod local dev relay.
//
// A dependency-free stand-in for the Cloudflare Worker so you can play a real
// two-session game on one machine: open two browser profiles (or a normal and
// an incognito window), point both at this relay, and you have a live pod.
//
// It mirrors the production worker's wire protocol -- same message shapes,
// same playerId scheme, same token bucket, and crucially the same per-type
// FIELD WHITELIST (RELAY_FIELDS below), which rebuilds every relayed message
// and drops anything not explicitly allowed. Without that last part a dev
// relay happily carries a protocol the real one silently truncates.
//
// The differences are all deliberate developer affordances:
//
//   * every frame is printed, in and out, with size and direction
//   * --rate lets you tighten or loosen the bucket to reproduce throttling
//   * --latency and --loss simulate a bad connection on purpose
//
// Usage:
//   node server/dev-relay.js                    # port 8787
//   node server/dev-relay.js --port 9000 --verbose
//   node server/dev-relay.js --rate 1           # provoke rate limiting
//   node server/dev-relay.js --latency 250 --loss 0.05
//   node server/dev-relay.js --no-sanitize        # disable the field whitelist
//
// Then in the extension popup, set the relay URL to ws://localhost:8787

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 65536;
const MIN_PLAYER_KEY_LENGTH = 16;

// Mirrored verbatim from server/src/index.js. The production worker does NOT
// forward messages as received: it rebuilds each one keeping only the fields
// whitelisted for its type, and silently drops the rest.
//
// This is the single most important thing this file has to reproduce. A dev
// relay that forwards everything makes the whole test suite pass against a
// protocol the real relay will not carry -- which is exactly the bug this
// comment exists to prevent recurring. Use --no-sanitize only to prove that
// a failure is caused by the whitelist.
const VALID_TYPES = new Set([
  'drawCard', 'discard', 'join', 'ping', 'leave',
  'game-init', 'game-ready', 'game-start',
  'zone-sync', 'life-sync', 'hand-count-sync',
]);

const RELAY_FIELDS = {
  'zone-sync': new Set(['action', 'zone', 'cardId', 'scryfallId', 'syncId', 'pctX', 'pctY',
    'fromZone', 'toZone', 'updates', 'syncIds', 'cards', 'targetId', 'gift']),
  'life-sync': new Set(['life']),
  'hand-count-sync': new Set(['handCount']),
  'game-init': new Set(['library']),
  'game-ready': new Set(['drawnCount']),
  'game-start': new Set([]),
  drawCard: new Set([]),
  discard: new Set([]),
};

function sanitizeRelayMessage(parsed) {
  const allowed = RELAY_FIELDS[parsed.type];
  if (!allowed) return null;
  const clean = { type: parsed.type };
  for (const key of allowed) {
    if (key in parsed) clean[key] = parsed[key];
  }
  return clean;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG = {
  port: Number(args.port ?? 8787),
  rateMaxTokens: Number(args.rate ?? 5),
  rateRefillPerSec: Number(args.rate ?? 5),
  latencyMs: Number(args.latency ?? 0),
  lossRate: Number(args.loss ?? 0),
  verbose: args.verbose === true || args.v === true,
  quiet: args.quiet === true,
  // Escape hatch: forward messages unfiltered, to prove a bug is caused by
  // the production field whitelist. Off by default -- fidelity beats comfort.
  sanitize: args['no-sanitize'] !== true,
};

/** roomId -> { gameType, maxPlayers, shareBattlefield, shareGraveyardExile, records[], sockets:Set } */
const rooms = new Map();

// ── HTTP ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  cors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname === '/health') {
    return json(res, 200, { ok: true, rooms: rooms.size, config: CONFIG });
  }

  const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})(\/info)?$/);
  if (!match) return json(res, 404, { error: 'Not found' });
  const roomId = match[1];
  const isInfo = !!match[2];

  if (req.method === 'GET' && isInfo) {
    const room = rooms.get(roomId);
    if (!room) return json(res, 404, { error: 'Room not found' });
    return json(res, 200, describeRoom(roomId, room));
  }

  if (req.method === 'POST' && !isInfo) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { /* defaults */ }
      if (rooms.get(roomId)?.records.length) {
        return json(res, 409, { error: 'Room already exists' });
      }
      const maxPlayers = clamp(Number(parsed.maxPlayers) || 2, 2, 4);
      const room = {
        gameType: parsed.gameType === 'traditional' ? 'traditional' : 'shared',
        maxPlayers,
        shareBattlefield: parsed.shareBattlefield !== false,
        shareGraveyardExile: parsed.shareGraveyardExile !== false,
        records: [],
        sockets: new Set(),
      };
      rooms.set(roomId, room);
      log('room', `created ${roomId} (${room.gameType}, max ${maxPlayers})`);
      return json(res, 201, describeRoom(roomId, room));
    });
    return undefined;
  }

  return json(res, 405, { error: 'Method not allowed' });
});

// ── WebSocket upgrade ───────────────────────────────────────────────

server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]{1,64})$/);
  const key = req.headers['sec-websocket-key'];
  if (!match || !key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const roomId = match[1];

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const conn = {
    socket, roomId,
    playerId: null, username: null, playerKey: null,
    authed: false,
    tokens: CONFIG.rateMaxTokens,
    lastRefill: Date.now(),
    buffer: Buffer.alloc(0),
    alive: true,
  };

  attach(conn);
  send(conn, {
    type: 'system',
    text: 'Connected to room. Send join with playerKey to authenticate.',
    peerCount: authedCount(roomId),
  });
});

function attach(conn) {
  conn.socket.on('data', (chunk) => {
    conn.buffer = Buffer.concat([conn.buffer, chunk]);
    for (;;) {
      const frame = readFrame(conn.buffer);
      if (!frame) break;
      conn.buffer = conn.buffer.subarray(frame.consumed);

      if (frame.opcode === 0x8) { closeConn(conn); return; }
      if (frame.opcode === 0x9) { writeFrame(conn.socket, 0xA, frame.payload); continue; }
      if (frame.opcode !== 0x1) continue;

      const text = frame.payload.toString('utf8');
      if (text.length > MAX_MESSAGE_BYTES) {
        send(conn, { type: 'error', code: 'too_large', text: 'Message too large' });
        continue;
      }
      handleMessage(conn, text);
    }
  });
  conn.socket.on('error', () => closeConn(conn));
  conn.socket.on('close', () => closeConn(conn));
}

// ── Protocol ────────────────────────────────────────────────────────

function handleMessage(conn, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }

  if (CONFIG.verbose) {
    log('recv', `${conn.playerId || '?'} ${parsed.type}${parsed.action ? ':' + parsed.action : ''} (${text.length}B)`);
  }

  if (parsed.type === 'ping') {
    send(conn, { type: 'pong', t: parsed.t || Date.now() });
    return;
  }

  if (parsed.type === 'join') return handleJoin(conn, parsed);
  if (!conn.authed) return;

  if (parsed.type === 'leave') { closeConn(conn); return; }

  if (!VALID_TYPES.has(parsed.type)) {
    if (CONFIG.verbose) log('drop', `unknown type ${parsed.type} from ${conn.playerId}`);
    return;
  }

  if (!takeToken(conn)) {
    send(conn, { type: 'error', code: 'rate_limited', text: 'Slow down' });
    log('rate', `${conn.playerId} rate limited on ${parsed.type}`);
    return;
  }

  const sanitized = CONFIG.sanitize ? sanitizeRelayMessage(parsed) : { ...parsed };
  if (!sanitized) return;
  if (CONFIG.sanitize && CONFIG.verbose) {
    const dropped = Object.keys(parsed).filter(k => !(k in sanitized) && k !== 'type');
    if (dropped.length) {
      log('strip', `${conn.playerId} ${parsed.type}: dropped ${dropped.join(', ')}`);
    }
  }

  // The relay is the authority on who you are: it overwrites username with the
  // authenticated value from join.
  const outbound = { ...sanitized, senderId: conn.playerId, username: conn.username };
  if (sanitized.type === 'zone-sync' && sanitized.targetId) {
    sendToTarget(conn, sanitized.targetId, outbound);
  } else {
    broadcast(conn.roomId, outbound, conn);
  }
}

function handleJoin(conn, parsed) {
  const room = rooms.get(conn.roomId) || autoCreateRoom(conn.roomId, parsed);
  const playerKey = String(parsed.playerKey || '');
  if (playerKey.length < MIN_PLAYER_KEY_LENGTH) {
    send(conn, { type: 'system', rejected: true, text: 'Invalid player key.' });
    closeConn(conn);
    return;
  }

  let record = room.records.find(r => r.playerKey === playerKey);
  if (!record) {
    if (room.records.length >= room.maxPlayers) {
      send(conn, {
        type: 'system', rejected: true,
        text: `This game already has ${room.maxPlayers} players connected.`,
      });
      closeConn(conn);
      return;
    }
    record = {
      playerKey,
      playerId: `p${room.records.length + 1}`,
      username: parsed.username || 'Anonymous',
    };
    room.records.push(record);
  } else if (parsed.username) {
    record.username = parsed.username;
  }

  conn.playerId = record.playerId;
  conn.username = record.username;
  conn.playerKey = playerKey;
  conn.authed = true;
  room.sockets.add(conn);

  const players = playerList(room);
  send(conn, {
    type: 'system',
    text: `Joined room. ${players.length} player(s) here.`,
    peerCount: authedCount(conn.roomId),
    seatCount: room.records.length,
    maxPlayers: room.maxPlayers,
    gameType: room.gameType,
    shareBattlefield: room.shareBattlefield,
    shareGraveyardExile: room.shareGraveyardExile,
    playerId: record.playerId,
    players,
  });
  broadcast(conn.roomId, {
    type: 'join', senderId: record.playerId, username: record.username, players,
  }, conn);

  log('join', `${record.username} -> ${record.playerId} in ${conn.roomId} (${players.length}/${room.maxPlayers})`);
}

/**
 * The production worker requires an explicit POST for traditional rooms, but
 * auto-creating on first join makes local two-tab testing one step shorter.
 */
function autoCreateRoom(roomId, parsed) {
  const room = {
    gameType: parsed.gameType === 'traditional' ? 'traditional' : 'shared',
    maxPlayers: 4,
    shareBattlefield: parsed.shareBattlefield !== false,
    shareGraveyardExile: parsed.shareGraveyardExile !== false,
    records: [],
    sockets: new Set(),
  };
  rooms.set(roomId, room);
  log('room', `auto-created ${roomId} (${room.gameType})`);
  return room;
}

function closeConn(conn) {
  if (!conn.alive) return;
  conn.alive = false;
  try { conn.socket.destroy(); } catch { /* already gone */ }

  const room = rooms.get(conn.roomId);
  if (!room) return;
  room.sockets.delete(conn);
  if (!conn.authed) return;

  const players = playerList(room);
  broadcast(conn.roomId, {
    type: 'system',
    text: `Player left the game. ${authedCount(conn.roomId)} player(s) in room.`,
    peerCount: authedCount(conn.roomId),
    seatCount: room.records.length,
    maxPlayers: room.maxPlayers,
    gameType: room.gameType,
    leftPlayerId: conn.playerId,
    left: true,
    players,
  }, null);
  log('leave', `${conn.playerId} left ${conn.roomId}`);

  if (room.sockets.size === 0) {
    // Keep the record list so a refresh reclaims the same seat, but drop
    // rooms nobody is in after a grace period.
    setTimeout(() => {
      if (rooms.get(conn.roomId)?.sockets.size === 0) {
        rooms.delete(conn.roomId);
        log('room', `disposed ${conn.roomId}`);
      }
    }, 60000).unref();
  }
}

// ── Delivery ────────────────────────────────────────────────────────

function broadcast(roomId, message, except) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const conn of room.sockets) {
    if (conn === except || !conn.authed) continue;
    send(conn, message);
  }
}

function sendToTarget(from, targetId, message) {
  const room = rooms.get(from.roomId);
  if (!room) return;
  for (const conn of room.sockets) {
    if (conn.playerId === targetId && conn.authed) {
      send(conn, message);
      return;
    }
  }
  if (CONFIG.verbose) log('drop', `no target ${targetId} in ${from.roomId}`);
}

function send(conn, message) {
  if (!conn.alive) return;
  const text = JSON.stringify(message);

  if (CONFIG.lossRate > 0 && Math.random() < CONFIG.lossRate) {
    log('loss', `dropped ${message.type} to ${conn.playerId || '?'} (simulated)`);
    return;
  }
  const deliver = () => {
    if (!conn.alive) return;
    writeFrame(conn.socket, 0x1, Buffer.from(text, 'utf8'));
    if (CONFIG.verbose) {
      log('send', `${conn.playerId || '?'} ${message.type}${message.action ? ':' + message.action : ''} (${text.length}B)`);
    }
  };
  if (CONFIG.latencyMs > 0) setTimeout(deliver, CONFIG.latencyMs).unref();
  else deliver();
}

function takeToken(conn) {
  const now = Date.now();
  const elapsed = (now - conn.lastRefill) / 1000;
  conn.lastRefill = now;
  conn.tokens = Math.min(CONFIG.rateMaxTokens, conn.tokens + elapsed * CONFIG.rateRefillPerSec);
  if (conn.tokens < 1) return false;
  conn.tokens -= 1;
  return true;
}

// ── WebSocket framing (RFC 6455, the subset we need) ────────────────

function readFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(MAX_MESSAGE_BYTES)) return null;
    length = Number(big);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { opcode, payload, consumed: offset + length };
}

function writeFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  try { socket.write(Buffer.concat([header, payload])); } catch { /* peer gone */ }
}

// ── Helpers ─────────────────────────────────────────────────────────

function playerList(room) {
  const active = new Set([...room.sockets].filter(c => c.authed).map(c => c.playerId));
  return room.records.map(record => ({
    id: record.playerId,
    username: record.username || 'Anonymous',
    connected: active.has(record.playerId),
  }));
}

function authedCount(roomId) {
  const room = rooms.get(roomId);
  if (!room) return 0;
  return [...room.sockets].filter(c => c.authed).length;
}

function describeRoom(roomId, room) {
  return {
    roomId,
    gameType: room.gameType,
    maxPlayers: room.maxPlayers,
    shareBattlefield: room.shareBattlefield,
    shareGraveyardExile: room.shareGraveyardExile,
    playerCount: room.records.length,
    connectedCount: authedCount(roomId),
    players: playerList(room),
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[name] = true;
    else { out[name] = next; i++; }
  }
  return out;
}

function log(tag, message) {
  if (CONFIG.quiet) return;
  const time = new Date().toISOString().slice(11, 23);
  console.log(`${time} [${tag.padEnd(5)}] ${message}`);
}

// ── Start ───────────────────────────────────────────────────────────

server.listen(CONFIG.port, () => {
  console.log(`\n  MoxPod dev relay`);
  console.log(`  ws://localhost:${CONFIG.port}/room/<roomId>`);
  console.log(`  health: http://localhost:${CONFIG.port}/health`);
  console.log(`  rate ${CONFIG.rateMaxTokens}/s` +
    (CONFIG.sanitize ? ', field whitelist ON (as production)' : ', WHITELIST OFF') +
    (CONFIG.latencyMs ? `, +${CONFIG.latencyMs}ms latency` : '') +
    (CONFIG.lossRate ? `, ${Math.round(CONFIG.lossRate * 100)}% loss` : '') +
    (CONFIG.verbose ? ', verbose' : '') + '\n');
});

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
