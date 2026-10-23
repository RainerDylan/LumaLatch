import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const MAX_ROOMS = 128;
const MAX_MEMBERS = 32;
const MAX_CLIENTS = 512;
const MAX_PAYLOAD = 16 * 1024;
const PERMISSIONS = ['playback', 'subtitles', 'quality'];
const ACTIONS = new Set(['play', 'pause', 'seeked', 'ratechange', 'sync']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;

function originsAllowlist(origins) {
  if (origins === undefined) return new Set();
  if (!Array.isArray(origins) && !(origins instanceof Set)) {
    throw new TypeError('allowedOrigins must be an array or Set of explicit origins');
  }
  const result = new Set();
  for (const origin of origins) {
    if (typeof origin !== 'string') throw new TypeError('Invalid allowed origin');
    if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      result.add(origin);
      continue;
    }
    let url;
    try { url = new URL(origin); } catch { throw new TypeError('Invalid allowed origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new TypeError('allowedOrigins entries must be exact http(s) or chrome-extension origins');
    }
    result.add(origin);
  }
  return result;
}

export async function createPartyServer({ host = '127.0.0.1', port = 0, allowedOrigins } = {}) {
  const origins = originsAllowlist(allowedOrigins);
  if (typeof host !== 'string' || !host || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('Invalid host or port');
  }
  const rooms = new Map();
  const clients = new Set();
  const server = http.createServer((request, response) => {
    const healthy = request.method === 'GET' && request.url === '/health';
    response.writeHead(healthy ? 200 : 404, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(healthy ? { ok: true } : { error: 'Not found' }));
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 10000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  function send(client, message) {
    if (client.ws.readyState !== WebSocket.OPEN) return;
    if (client.ws.bufferedAmount > 64 * 1024) return client.ws.terminate();
    client.ws.send(JSON.stringify(message));
  }
  const error = (client, code, message) => send(client, { type: 'error', code, message });
  const broadcast = (room, message) => {
    for (const member of room.members) send(member, message);
  };

  function leave(client) {
    const room = client.room;
    if (!room) return;
    client.room = null;
    room.members.delete(client);
    if (room.host === client) {
      // Empty rooms expire immediately; a room cannot survive its host socket.
      rooms.delete(room.id);
      for (const member of room.members) member.room = null;
      broadcast(room, { type: 'ended' });
      room.members.clear();
    } else {
      broadcast(room, { type: 'members', count: room.members.size });
    }
  }

  function probe(client) {
    const t0 = Date.now();
    client.probe = { t0, started: performance.now() };
    send(client, { type: 'probe', t0 });
  }

  function receive(client, data, binary) {
    const now = Date.now();
    const monotonic = performance.now();
    client.tokens = Math.min(120, client.tokens + (monotonic - client.refill) * 0.03);
    client.refill = monotonic;
    if (client.tokens < 1) {
      if (client.ws.readyState === WebSocket.OPEN) {
        error(client, 'RATE_LIMIT', 'Too many messages');
        client.ws.close(1008, 'Message rate limit');
      }
      return;
    }
    client.tokens--;
    if (binary) return error(client, 'INVALID_MESSAGE', 'JSON text messages required');
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { return error(client, 'INVALID_MESSAGE', 'Invalid JSON'); }
    if (!object(message) || typeof message.type !== 'string') {
      return error(client, 'INVALID_MESSAGE', 'Message must be an object with a type');
    }

    if (message.type === 'probe') {
      const pending = client.probe;
      if (!pending || !timestamp(message.t0) || message.t0 !== pending.t0 || !timestamp(message.t1)) {
        return error(client, 'INVALID_PROBE', 'Unsolicited or invalid probe');
      }
      const rtt = monotonic - pending.started;
      const offset = pending.t0 + rtt / 2 - message.t1;
      if (rtt > 10000 || Math.abs(offset) > 86400000) {
        return error(client, 'INVALID_PROBE', 'Probe timing outside supported bounds');
      }
      client.probe = null;
      client.samples.push({ offset, rtt });
      if (client.samples.length > 8) client.samples.shift();
      const best = client.samples.reduce((a, b) => a.rtt <= b.rtt ? a : b);
      client.offset = best.offset;
      return send(client, { type: 'clock', ...best });
    }
    if (message.type === 'ping') {
      if (!timestamp(message.clientTime)) return error(client, 'INVALID_MESSAGE', 'Invalid clientTime');
      return send(client, { type: 'pong', clientTime: message.clientTime, serverTime: now });
    }
    if (message.type === 'leave') {
      leave(client);
      return send(client, { type: 'left' });
    }
    if (message.type === 'create' || message.type === 'join') {
      if (client.room) return error(client, 'ALREADY_IN_ROOM', 'Leave the current room first');
      let room;
      if (message.type === 'create') {
        if (rooms.size >= MAX_ROOMS) return error(client, 'ROOM_LIMIT', 'Room limit reached');
        let id;
        do { id = randomBytes(16).toString('base64url'); } while (rooms.has(id));
        room = { id, host: client, members: new Set(),
          permissions: { playback: false, subtitles: false, quality: false },
          state: { type: 'state', action: 'sync', position: 0, paused: true, rate: 1, serverTime: now, sequence: 0 }
        };
        rooms.set(id, room);
      } else {
        if (typeof message.roomId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(message.roomId)) {
          return error(client, 'INVALID_MESSAGE', 'Invalid room ID');
        }
        room = rooms.get(message.roomId);
        if (!room) return error(client, 'ROOM_NOT_FOUND', 'Room does not exist or has ended');
        if (room.members.size >= MAX_MEMBERS) return error(client, 'ROOM_FULL', 'Room is full');
      }
      client.room = room;
      room.members.add(client);
      send(client, { type: message.type === 'create' ? 'created' : 'joined', roomId: room.id,
        permissions: room.permissions, state: room.state, role: room.host === client ? 'host' : 'guest' });
      return broadcast(room, { type: 'members', count: room.members.size });
    }
    if (!['permissions', 'state', 'setting'].includes(message.type)) {
      return error(client, 'INVALID_MESSAGE', 'Unknown message type');
    }
    const room = client.room;
    if (!room) return error(client, 'NOT_IN_ROOM', 'Join a room first');
    const isHost = room.host === client;
    if (message.type === 'permissions') {
      if (!isHost) return error(client, 'FORBIDDEN', 'Only the host may change permissions');
      const value = message.permissions;
      if (!object(value) || Object.keys(value).length !== 3 ||
          !PERMISSIONS.every(key => typeof value[key] === 'boolean')) {
        return error(client, 'INVALID_MESSAGE', 'Expected playback, subtitles and quality booleans');
      }
      room.permissions = Object.fromEntries(PERMISSIONS.map(key => [key, value[key]]));
      return broadcast(room, { type: 'permissions', permissions: room.permissions });
    }
    if (message.type === 'setting') {
      if (!['subtitles', 'quality'].includes(message.kind) || typeof message.value !== 'string' ||
          message.value.length > 256 || /[\u0000-\u001f\u007f]/.test(message.value)) {
        return error(client, 'INVALID_MESSAGE', 'Invalid setting');
      }
      if (!isHost && !room.permissions[message.kind]) return error(client, 'FORBIDDEN', 'Setting permission required');
      return broadcast(room, { type: 'setting', kind: message.kind, value: message.value });
    }
    if (!isHost && !room.permissions.playback) return error(client, 'FORBIDDEN', 'Playback permission required');
    if (!ACTIONS.has(message.action) || !Number.isFinite(message.position) || message.position < 0 ||
        message.position > Number.MAX_SAFE_INTEGER - 40 || typeof message.paused !== 'boolean' ||
        !Number.isFinite(message.rate) || message.rate < 0.25 || message.rate > 4 || !timestamp(message.clientTime)) {
      return error(client, 'INVALID_MESSAGE', 'Invalid playback state');
    }
    // Sender clocks cannot project more than 10 seconds or into the future.
    const eventTime = Math.max(now - 10000, Math.min(now, message.clientTime + client.offset));
    const position = message.position + (message.paused ? 0 : (now - eventTime) * message.rate / 1000);
    room.state = { type: 'state', action: message.action, position, paused: message.paused,
      rate: message.rate, serverTime: now, sequence: room.state.sequence + 1 };
    broadcast(room, room.state);
  }

  server.on('upgrade', (request, socket, head) => {
    const reject = (status, reason) => {
      socket.on('error', () => {});
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (request.url !== '/party') return reject(404, 'Not Found');
    if (request.headers.origin !== undefined && !origins.has(request.headers.origin)) return reject(403, 'Forbidden');
    if (clients.size >= MAX_CLIENTS) return reject(503, 'Service Unavailable');
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
  });
  wss.on('connection', ws => {
    const client = { ws, room: null, offset: 0, samples: [], probe: null,
      tokens: 120, refill: performance.now(), alive: true };
    clients.add(client);
    ws.on('message', (data, binary) => receive(client, data, binary));
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {}); // ws emits errors for invalid frames and oversized payloads.
    ws.on('close', () => { leave(client); clients.delete(client); });
    send(client, { type: 'welcome', clientId: randomUUID() });
    probe(client);
  });

  const timer = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
      probe(client);
    }
  }, 5000);
  timer.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.off('error', reject); resolve(); });
    });
  } catch (error) {
    clearInterval(timer);
    wss.close();
    throw error;
  }
  let closing;
  const close = () => closing ??= (async () => {
    clearInterval(timer);
    for (const client of clients) client.ws.terminate();
    await Promise.all([
      new Promise(resolve => wss.close(resolve)),
      new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      })
    ]);
    rooms.clear();
    clients.clear();
  })();
  const address = server.address();
  const hostname = isIP(address.address) === 6 ? `[${address.address}]` : address.address;
  return { server, wss, url: `ws://${hostname}:${address.port}/party`, close };
}

function canonicalIP(address) {
  return isIP(address) === 6 ? new URL(`http://[${address}]`).hostname.toLowerCase() : address;
}

async function main() {
  const rawPort = process.env.PORT ?? '8787';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const host = process.env.TAILSCALE_IP;
  const version = isIP(host ?? '');
  const ipv4 = version === 4 && host.split('.')[0] === '100' &&
    Number(host.split('.')[1]) >= 64 && Number(host.split('.')[1]) <= 127;
  const ipv6 = version === 6 && canonicalIP(host).startsWith('[fd7a:115c:a1e0:');
  if (!ipv4 && !ipv6) throw new Error('TAILSCALE_IP must be a Tailscale IPv4 or IPv6 address');
  const assigned = Object.values(networkInterfaces()).flat().some(entry =>
    entry && canonicalIP(entry.address.split('%')[0]) === canonicalIP(host));
  if (!assigned) throw new Error('TAILSCALE_IP must be assigned to a local network interface');
  const allowedOrigins = (process.env.JELLYFIN_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const party = await createPartyServer({ host, port: Number(rawPort), allowedOrigins });
  console.log(`LumaLatch listening at ${party.url}`);
  const stop = () => party.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  // Desktop launcher owns this pipe; stopping the child never kills another server.
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    let input = '';
    process.stdin.on('data', chunk => {
      input = (input + chunk).slice(-128);
      if (input.split(/\r?\n/).includes('stop')) {
        process.stdin.pause();
        stop();
      }
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
