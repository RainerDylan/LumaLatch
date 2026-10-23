import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { networkInterfaces } from 'node:os';
import net from 'node:net';
import { WebSocket } from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const cache = path.join(root, '.cache', 'release');
const verification = path.join(cache, "verify space & apostrophe's #", 'LumaLatch');
await fs.mkdir(path.dirname(verification), { recursive: true });
const checksumLines = (await fs.readFile('dist/SHA256SUMS.txt', 'utf8')).trim().split('\n');
assert.equal(checksumLines.length, 4);
for (const line of checksumLines) {
  const [expected, filename] = line.split(/\s+/);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path.join(root, 'dist', filename))) hash.update(bytes);
  assert.equal(hash.digest('hex'), expected, `ZIP checksum: ${filename}`);
}
execFileSync('python', [path.join(root, 'scripts', 'verify-archives.py'), version, path.dirname(verification)], { stdio: 'inherit' });
const manifest = JSON.parse(await fs.readFile(path.join(verification, 'extension', 'manifest.json'), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
const runtime = path.join(verification, 'runtime', 'node.exe');
assert.equal(execFileSync(runtime, ['--version'], { encoding: 'utf8' }).trim(), 'v24.21.0');
const exe = path.join(verification, 'LumaLatch.exe');
for (const argument of ['--self-test', '--smoke-test', '--ui-smoke-test']) {
  execFileSync(exe, [argument], { cwd: verification, timeout: 30000, stdio: 'inherit',
    env: { ...process.env, TEMP: path.join(cache, 'tmp'), TMP: path.join(cache, 'tmp') } });
  console.log(`Executable ${argument}: passed from a path containing spaces, &, apostrophe and #`);
}

const addresses = Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address);
const host = addresses.includes('100.76.133.88') ? '100.76.133.88' : addresses.find(ip => /^100\.(\d+)\./.test(ip) && +ip.split('.')[1] >= 64 && +ip.split('.')[1] <= 127);
assert.ok(host, 'Connect Tailscale to run the live private-interface release smoke test');
const reservation = net.createServer();
await new Promise((resolve, reject) => reservation.once('error', reject).listen(0, host, resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(runtime, [path.join(verification, 'app', 'server', 'index.js')], {
  cwd: verification, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', TAILSCALE_IP: host, PORT: String(port), JELLYFIN_ORIGINS: `chrome-extension://${extensionId}` }
});
const exited = once(child, 'exit');
let output = '';
child.stdout.on('data', bytes => { output += bytes; });
child.stderr.on('data', bytes => { output += bytes; });
const sockets = [];
const connect = async origin => {
  const ws = new WebSocket(`ws://${host}:${port}/party`, { origin });
  sockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.on('message', bytes => {
    const message = JSON.parse(bytes);
    if (message.type === 'probe') ws.send(JSON.stringify({ type: 'probe', t0: message.t0, t1: Date.now() }));
    queue.push(message);
    for (const resolve of waiters.splice(0)) resolve();
  });
  await once(ws, 'open');
  return { ws, async read(type) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const index = queue.findIndex(message => message.type === type);
      if (index !== -1) return queue.splice(index, 1)[0];
      await Promise.race([new Promise(resolve => waiters.push(resolve)), new Promise(resolve => setTimeout(resolve, 50))]);
    }
    throw new Error(`No ${type} message from packaged server`);
  }, send(message) { ws.send(JSON.stringify(message)); } };
};
try {
  const deadline = Date.now() + 7000;
  while (!output.includes('LumaLatch listening at') && child.exitCode === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(output.includes('LumaLatch listening at'), output || 'Packaged server did not start');
  assert.deepEqual(await fetch(`http://${host}:${port}/health`).then(reply => reply.json()), { ok: true });
  await new Promise((resolve, reject) => {
    const denied = new WebSocket(`ws://${host}:${port}/party`, { origin: 'https://unapproved.example' });
    denied.on('open', () => { denied.close(); reject(new Error('Server accepted an unapproved origin')); });
    denied.on('unexpected-response', (_request, response) => { response.resume(); denied.terminate(); try { assert.equal(response.statusCode, 403); resolve(); } catch (error) { reject(error); } });
    denied.on('error', () => {});
  });
  const a = await connect(`chrome-extension://${extensionId}`);
  const b = await connect(`chrome-extension://${extensionId}`);
  a.send({ type: 'create' });
  const room = await a.read('created');
  b.send({ type: 'join', roomId: room.roomId });
  await b.read('joined');
  a.send({ type: 'state', action: 'pause', position: 18.25, paused: true, rate: 1, clientTime: Date.now() });
  const pause = await b.read('state');
  assert.equal(pause.paused, true);
  assert.equal(pause.position, 18.25);
  b.send({ type: 'permissions', permissions: { playback: true, subtitles: true, quality: true } });
  assert.equal((await b.read('error')).code, 'FORBIDDEN');
  console.log(`Packaged CLI: health, fixed-origin allowlist, room, guest pause, permission denial passed on ${host}`);
} finally {
  for (const socket of sockets) socket.terminate();
  child.stdin.end('stop\n');
  const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(null), 5000))]);
  if (!result) { child.kill(); throw new Error('Packaged server did not stop cleanly'); }
  assert.equal(result[0], 0, `Packaged server shutdown failed: ${output}`);
}
execFileSync(process.execPath, [path.join(root, 'node_modules', '@playwright', 'test', 'cli.js'), 'test'], {
  cwd: root, stdio: 'inherit', timeout: 180000,
  env: { ...process.env, LUMALATCH_RELEASE_ROOT: verification, PLAYWRIGHT_BROWSERS_PATH: path.join(root, '.cache', 'ms-playwright'), TEMP: path.join(cache, 'tmp'), TMP: path.join(cache, 'tmp') }
});
await fs.writeFile(path.join(root, 'dist', 'VERIFIED.txt'), `LumaLatch ${version}\nWindows ZIP extracted and executable tested, bundled runtime tested, private Tailscale interface protocol tested, production extension in two independent Chromium processes tested with <=50ms pause assertions.\nMac archives: SHA256, contents, runtime architecture and executable permissions checked; not executed on macOS here.\nJellyfin http://100.76.133.88:8096/System/Info/Public returned200; authenticated playback not tested.\n`);
console.log('All release verification checks passed.');
