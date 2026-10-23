import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import WebSocket from 'ws';

const origin = 'http://jellyfin.test';
const defaults = { playback: false, subtitles: false, quality: false };
const state = (changes = {}) => ({ type: 'state', action: 'pause', position: 10, paused: true,
  rate: 1, clientTime: Date.now(), ...changes });

async function setup(t, options = {}) {
  const { createPartyServer } = await import('../server/index.js');
  const party = await createPartyServer({ allowedOrigins: [origin], ...options });
  t.after(() => party.close());
  return party;
}

async function connect(t, party, options = {}) {
  const ws = new WebSocket(party.url, options);
  const queue = [];
  const pending = [];
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    const index = pending.findIndex(waiter => waiter.type === message.type);
    if (index === -1) queue.push(message);
    else pending.splice(index, 1)[0].resolve(message);
  });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  return {
    ws, queue,
    send: message => ws.send(JSON.stringify(message)),
    next(type, timeout = 2000) {
      const index = queue.findIndex(message => message.type === type);
      if (index !== -1) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, timeout);
        const waiter = { type, resolve(message) { clearTimeout(timer); resolve(message); } };
        pending.push(waiter);
      });
    }
  };
}

async function room(t) {
  const party = await setup(t);
  const host = await connect(t, party);
  host.send({ type: 'create' });
  const created = await host.next('created');
  const guest = await connect(t, party);
  guest.send({ type: 'join', roomId: created.roomId });
  const joined = await guest.next('joined');
  return { party, host, guest, created, joined };
}

test('API creates rooms with unguessable capabilities and single socket membership', async t => {
  const { party, host, guest, created, joined } = await room(t);
  assert.equal((await host.next('welcome')).type, 'welcome');
  assert.equal(created.role, 'host');
  assert.equal(joined.role, 'guest');
  assert.match(created.roomId, /^[A-Za-z0-9_-]{22,}$/);
  assert.deepEqual(created.permissions, defaults);
  assert.deepEqual(joined.state, created.state);
  host.send({ type: 'create' });
  assert.equal((await host.next('error')).code, 'ALREADY_IN_ROOM');
  guest.send({ type: 'join', roomId: created.roomId });
  assert.equal((await guest.next('error')).code, 'ALREADY_IN_ROOM');
  const stranger = await connect(t, party);
  stranger.send({ type: 'join', roomId: 'A'.repeat(22) });
  assert.equal((await stranger.next('error')).code, 'ROOM_NOT_FOUND');
  stranger.send({ type: 'create' });
  assert.notEqual((await stranger.next('created')).roomId, created.roomId);
});

test('permissions enforce host socket authority for playback, sync and settings', async t => {
  const { host, guest } = await room(t);
  guest.send({ type: 'permissions', permissions: { playback: true, subtitles: true, quality: true }, role: 'host' });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  for (const message of [state(), state({ action: 'sync' }),
    { type: 'setting', kind: 'subtitles', value: 'English' },
    { type: 'setting', kind: 'quality', value: '720p' }]) {
    guest.send(message);
    assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  }
  const permissions = { playback: true, subtitles: true, quality: false };
  host.send({ type: 'permissions', permissions });
  assert.deepEqual((await guest.next('permissions')).permissions, permissions);
  assert.deepEqual((await host.next('permissions')).permissions, permissions);
  guest.send(state({ action: 'sync' }));
  assert.equal((await host.next('state')).action, 'sync');
  await guest.next('state');
  guest.send({ type: 'setting', kind: 'subtitles', value: 'English' });
  assert.deepEqual(await host.next('setting'), { type: 'setting', kind: 'subtitles', value: 'English' });
  await guest.next('setting');
  guest.send({ type: 'setting', kind: 'quality', value: '720p' });
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
  host.send({ type: 'setting', kind: 'quality', value: '1080p' });
  assert.equal((await guest.next('setting')).value, '1080p');
  host.send({ type: 'permissions', permissions: defaults });
  await guest.next('permissions');
  guest.send(state());
  assert.equal((await guest.next('error')).code, 'FORBIDDEN');
});

test('authoritative state echoes, advances sequence and retains late join state', async t => {
  const { party, host, guest, created } = await room(t);
  for (const [index, action] of ['play', 'pause', 'seeked', 'ratechange', 'sync'].entries()) {
    host.send(state({ action, paused: action === 'pause', position: 20 + index, rate: 1.5 }));
    const received = await guest.next('state');
    assert.deepEqual(await host.next('state'), received);
    assert.equal(received.sequence, index + 1);
    assert.equal(received.action, action);
    assert.equal(received.rate, 1.5);
    assert.ok(received.position >= 20 + index && received.position < 21 + index);
    assert.ok(Math.abs(received.serverTime - Date.now()) < 1000);
  }
  const late = await connect(t, party);
  late.send({ type: 'join', roomId: created.roomId });
  const joined = await late.next('joined');
  assert.equal(joined.state.sequence, 5);
  assert.equal(joined.state.action, 'sync');
  assert.equal(joined.state.paused, false);
});

test('probe establishes server-minus-client offset and rejects duplicate or forged echoes', async t => {
  const party = await setup(t);
  const host = await connect(t, party);
  const probe = await host.next('probe');
  const clientTime = Date.now() - 5000;
  host.send({ type: 'probe', t0: probe.t0, t1: clientTime });
  const clock = await host.next('clock');
  assert.ok(Math.abs(clock.offset - 5000) < 100);
  assert.ok(clock.rtt >= 0 && clock.rtt < 1000);
  host.send({ type: 'probe', t0: probe.t0, t1: clientTime });
  assert.equal((await host.next('error')).code, 'INVALID_PROBE');
  host.send({ type: 'probe', t0: -1, t1: Date.now() });
  assert.equal((await host.next('error')).code, 'INVALID_PROBE');
  host.send({ type: 'ping', clientTime: 123 });
  const pong = await host.next('pong');
  assert.equal(pong.clientTime, 123);
  assert.ok(Math.abs(pong.serverTime - Date.now()) < 1000);
  host.send({ type: 'create' });
  await host.next('created');
  host.send(state({ action: 'play', paused: false, position: 10, rate: 2, clientTime: Date.now() - 5500 }));
  const adjusted = await host.next('state');
  assert.ok(adjusted.position > 10.8 && adjusted.position < 11.3, JSON.stringify(adjusted));
  host.send(state({ paused: true, position: 10, clientTime: Date.now() - 5500 }));
  assert.equal((await host.next('state')).position, 10);
});

test('invalid probe times do not consume the outstanding probe', async t => {
  const party = await setup(t);
  const client = await connect(t, party);
  const probe = await client.next('probe');
  for (const t1 of [0, -1, null, '123', Number.MAX_SAFE_INTEGER]) {
    client.send({ type: 'probe', t0: probe.t0, t1 });
    assert.equal((await client.next('error')).code, 'INVALID_PROBE');
  }
  client.send({ type: 'probe', t0: probe.t0, t1: Date.now() });
  assert.equal((await client.next('clock')).type, 'clock');
});

test('recurring probes prefer a lower RTT sample and bound timestamp projections', async t => {
  const party = await setup(t);
  const host = await connect(t, party);
  const first = await host.next('probe');
  host.send({ type: 'probe', t0: first.t0, t1: Date.now() });
  const initial = await host.next('clock');
  const second = await host.next('probe', 6000);
  await delay(70);
  host.send({ type: 'probe', t0: second.t0, t1: Date.now() - 3000 });
  const selected = await host.next('clock');
  assert.equal(selected.offset, initial.offset);
  assert.equal(selected.rtt, initial.rtt);
  host.send({ type: 'create' });
  await host.next('created');
  host.send(state({ paused: false, position: 0, rate: 4, clientTime: Date.now() - 1e9 }));
  assert.equal((await host.next('state')).position, 40);
  host.send(state({ paused: false, position: 5, clientTime: Date.now() + 1e9 }));
  assert.equal((await host.next('state')).position, 5);
});

test('malformed inputs cannot mutate rooms or crash the server', async t => {
  const { host } = await room(t);
  for (const message of ['{', 'null', '[]', '12', '{"type":"unknown"}']) {
    host.ws.send(message);
    assert.equal((await host.next('error')).code, 'INVALID_MESSAGE');
  }
  for (const message of [state({ position: -1 }), state({ rate: 0.24 }), state({ rate: 4.01 }),
    state({ paused: 0 }), state({ action: 'ended' }), state({ clientTime: null }),
    state({ position: '1' }), state({ position: 1e308, paused: false }),
    { type: 'permissions', permissions: { playback: 'yes' } },
    { type: 'permissions', permissions: { ...defaults, admin: true } },
    { type: 'setting', kind: 'script', value: 'alert(1)' },
    { type: 'setting', kind: 'subtitles', value: 'x'.repeat(257) },
    { type: 'setting', kind: 'quality', value: '\u0000' },
    { type: 'join', roomId: '../wrong' }]) {
    host.send(message);
    assert.equal((await host.next('error')).type, 'error');
  }
  host.ws.send(Buffer.from('{}'));
  assert.equal((await host.next('error')).code, 'INVALID_MESSAGE');
  host.send(state());
  assert.equal((await host.next('state')).sequence, 1);
});

test('host disconnect and explicit leave end room without promoting a guest', async t => {
  const { party, host, guest, created } = await room(t);
  host.ws.close();
  await guest.next('ended');
  guest.send(state());
  assert.equal((await guest.next('error')).code, 'NOT_IN_ROOM');
  guest.send({ type: 'join', roomId: created.roomId });
  assert.equal((await guest.next('error')).code, 'ROOM_NOT_FOUND');
  guest.send({ type: 'create' });
  const nextRoom = await guest.next('created');
  const newcomer = await connect(t, party);
  newcomer.send({ type: 'join', roomId: nextRoom.roomId });
  await newcomer.next('joined');
  newcomer.send({ type: 'leave' });
  await newcomer.next('left');
  newcomer.send({ type: 'join', roomId: nextRoom.roomId });
  await newcomer.next('joined');
  guest.send({ type: 'leave' });
  await newcomer.next('ended');
  await guest.next('left');
  newcomer.send({ type: 'join', roomId: nextRoom.roomId });
  assert.equal((await newcomer.next('error')).code, 'ROOM_NOT_FOUND');
});

test('HTTP health is JSON; unexpected Origins and WebSocket paths are rejected', async t => {
  const party = await setup(t);
  const health = await fetch(party.url.replace('ws:', 'http:').replace('/party', '/health'));
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await health.json(), { ok: true });
  const allowed = await connect(t, party, { origin });
  await allowed.next('welcome');
  for (const [url, options, status] of [
    [party.url, { origin: 'http://evil.test' }, 403],
    [party.url, { origin: 'null' }, 403],
    [party.url, { origin: `${origin}.evil.test` }, 403],
    [party.url.replace('/party', '/other'), {}, 404]
  ]) {
    const ws = new WebSocket(url, options);
    await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_request, response) => {
        response.resume();
        ws.terminate();
        try { assert.equal(response.statusCode, status); resolve(); } catch (error) { reject(error); }
      });
      ws.on('error', () => {});
      ws.on('open', () => reject(new Error('Unexpected upgrade')));
    });
  }
  const restricted = await setup(t, { allowedOrigins: undefined });
  const ws = new WebSocket(restricted.url, { origin });
  ws.on('error', () => {});
  await new Promise(resolve => ws.on('unexpected-response', (_request, response) => {
    assert.equal(response.statusCode, 403); response.resume(); ws.terminate(); resolve();
  }));
});

test('payload and message rate limits close abusive sockets', async t => {
  const party = await setup(t);
  const oversized = await connect(t, party);
  const closed = once(oversized.ws, 'close');
  oversized.ws.send('x'.repeat(17000));
  assert.equal((await closed)[0], 1009);
  const flood = await connect(t, party);
  const limited = once(flood.ws, 'close');
  for (let i = 0; i < 150; i++) flood.send({ type: 'ping', clientTime: i });
  assert.equal((await limited)[0], 1008);
});

test('room and member bounds reject overflow and free capacity on host exit', async t => {
  const party = await setup(t);
  const hosts = [];
  for (let i = 0; i < 129; i++) {
    const host = await connect(t, party);
    host.send({ type: 'create' });
    hosts.push(host);
    if (i < 128) await host.next('created');
    else assert.equal((await host.next('error')).code, 'ROOM_LIMIT');
  }
  hosts[0].send({ type: 'leave' });
  await hosts[0].next('left');
  const overflow = hosts.at(-1);
  overflow.send({ type: 'create' });
  const created = await overflow.next('created');
  for (let i = 0; i < 32; i++) {
    const guest = await connect(t, party);
    guest.send({ type: 'join', roomId: created.roomId });
    if (i < 31) await guest.next('joined');
    else assert.equal((await guest.next('error')).code, 'ROOM_FULL');
  }
});

test('connection cap rejects overflow before upgrade and shutdown closes live clients', async t => {
  const party = await setup(t);
  const clients = [];
  for (let i = 0; i < 512; i++) clients.push(await connect(t, party));
  const overflow = new WebSocket(party.url);
  overflow.on('error', () => {});
  await new Promise((resolve, reject) => {
    overflow.on('open', () => reject(new Error('Connection limit bypassed')));
    overflow.on('unexpected-response', (_request, response) => {
      response.resume();
      overflow.terminate();
      try { assert.equal(response.statusCode, 503); resolve(); } catch (error) { reject(error); }
    });
  });
  const closed = once(clients[0].ws, 'close');
  await Promise.all([party.close(), party.close()]);
  await closed;
  assert.equal(party.server.listening, false);
});

test('API rejects unsafe origin configuration, invalid ports and occupied bindings', async t => {
  const { createPartyServer } = await import('../server/index.js');
  for (const allowedOrigins of ['*', ['*'], ['null'], ['http://user:password@jellyfin.test'],
    ['http://jellyfin.test/path'], ['http://jellyfin.test/'], ['https://jellyfin.test?x=1'], [null]]) {
    await assert.rejects(createPartyServer({ allowedOrigins }), /origin/i);
  }
  for (const port of [-1, 65536, '8787', 0.5, NaN]) {
    await assert.rejects(createPartyServer({ port }), /host or port/);
  }
  const party = await setup(t);
  await assert.rejects(createPartyServer({ port: party.server.address().port }), { code: 'EADDRINUSE' });
});

test('CLI refuses missing, non-Tailscale, unassigned IPs and invalid ports', () => {
  for (const env of [{ TAILSCALE_IP: '' }, { TAILSCALE_IP: '0.0.0.0' },
    { TAILSCALE_IP: '127.0.0.1' }, { TAILSCALE_IP: '100.1.2.3' },
    { TAILSCALE_IP: 'fd00::1' }, { TAILSCALE_IP: '100.127.255.254' },
    { TAILSCALE_IP: 'fd7a:115c:a1e0::ffff:fffe' }]) {
    const result = spawnSync(process.execPath, ['server/index.js'], {
      cwd: process.cwd(), env: { ...process.env, ...env }, encoding: 'utf8', timeout: 3000
    });
    assert.equal(result.status, 1, `${JSON.stringify(env)}: ${result.stderr}`);
    assert.match(result.stderr, /TAILSCALE_IP|PORT/);
  }
  for (const PORT of ['0', '65536', 'abc', '8.5', '-1', '']) {
    const result = spawnSync(process.execPath, ['server/index.js'], {
      cwd: process.cwd(), env: { ...process.env, TAILSCALE_IP: '100.64.0.1', PORT }, encoding: 'utf8', timeout: 3000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PORT/);
  }
});
