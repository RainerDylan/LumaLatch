import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createPartyServer } from './server/index.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('extension/manifest.json', root), 'utf8'));
const id = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex')
  .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const addresses = [...new Set(Object.values(networkInterfaces()).flat().filter(Boolean).map(entry => entry.address))]
  .filter(ip => /^100\.(\d+)\.\d+\.\d+$/.test(ip) && Number(ip.split('.')[1]) >= 64 && Number(ip.split('.')[1]) <= 127);
const host = addresses.includes('100.76.133.88') ? '100.76.133.88' : addresses[0];
try {
  if (!host) throw new Error('Tailscale is not connected. Open Tailscale, sign into the invited network, connect, then open this launcher again.');
  const party = await createPartyServer({ host, port: 8787, allowedOrigins: [`chrome-extension://${id}`] });
  console.log(`\nLumaLatch 0.2.0 is ready. Keep this window open.\n\nSignaling server: ${party.url}\nJellyfin: http://100.76.133.88:8096\n\nIn Chrome, enable the extension on Jellyfin. Open the same movie.\nHost: Connect, Create Party, Copy invite.\nGuests: Connect, Join Party. Guests do not run this launcher.\n\nPress Control+C to stop. Stopping ends all hosted parties.\n`);
  const help = spawn('/usr/bin/open', [fileURLToPath(new URL('START-HERE.html', root))], { stdio: 'ignore' });
  help.on('error', () => console.log('Open START-HERE.html in the extracted folder for setup help.'));
  const stop = () => party.close().catch(error => { console.error(error.message); process.exitCode = 1; });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  console.error(`\nLumaLatch could not start: ${error.message}\n\nCheck START-HERE.html. If port 8787 is in use, stop only your earlier LumaLatch server.\n`);
  process.exitCode = 1;
}
