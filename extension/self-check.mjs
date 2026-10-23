import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

let connectPort;
let receive;
let socket;
const sent = [];
const toTab = [];
class FakeWebSocket {
  static OPEN = 1;
  readyState = 1;
  constructor(url) { this.url = url; socket = this; }
  send(value) { sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; }
}
const port = {
  name: 'lumalatch', sender: { tab: { id: 1 } },
  postMessage(message) { toTab.push(message); },
  onMessage: { addListener(listener) { receive = listener; } },
  onDisconnect: { addListener() {} }
};
runInNewContext(readFileSync(new URL('./background.js', import.meta.url), 'utf8'), {
  chrome: { runtime: { onConnect: { addListener(listener) { connectPort = listener; } } } },
  WebSocket: FakeWebSocket, URL, Date
});
connectPort(port);
receive({ type: 'connect', url: 'ws://127.0.0.1:8787' });
assert.equal(socket.url, 'ws://127.0.0.1:8787/party');
socket.onopen();
socket.onmessage({ data: JSON.stringify({ type: 'probe', t0: Date.now() }) });
assert.equal(sent.at(-1).type, 'probe');
receive({ type: 'join', roomId: 'a'.repeat(22) });
assert.equal(sent.at(-1).type, 'join');
socket.onmessage({ data: JSON.stringify({ type: 'joined', roomId: 'a'.repeat(22), role: 'guest', permissions: { playback: false, subtitles: false, quality: false },
  state: { position: 0, paused: true, rate: 1, serverTime: Date.now(), sequence: 0 } }) });
const state = { type: 'state', action: 'pause', position: 5, paused: true, rate: 1, clientTime: Date.now() - 25 };
receive(state);
assert.notEqual(sent.at(-1).type, 'state');
socket.onmessage({ data: JSON.stringify({ type: 'permissions', permissions: { playback: true, subtitles: false, quality: false } }) });
receive(state);
assert.equal(sent.at(-1).type, 'state');
assert.equal(typeof sent.at(-1).clientTime, 'number');
assert.equal(sent.at(-1).clientTime, state.clientTime);
socket.onmessage({ data: JSON.stringify({ type: 'permissions', permissions: null }) });
assert.equal(toTab.at(-1).type, 'error');
socket.onmessage({ data: JSON.stringify({ type: 'state', position: 'bad' }) });
assert.equal(toTab.at(-1).type, 'error');
receive({ type: 'leave' });
assert.equal(sent.at(-1).type, 'leave');
assert.ok(toTab.some(message => message.type === 'connection' && message.connected));
console.log('background broker self-check passed');
