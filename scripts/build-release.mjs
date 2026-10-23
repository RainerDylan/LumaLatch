import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const version = JSON.parse(await fs.readFile('package.json', 'utf8')).version;
const runtimeVersion = 'v24.21.0';
const cache = path.join(root, '.cache', 'release');
const output = path.join(root, 'dist');
await fs.mkdir(path.join(cache, 'tmp'), { recursive: true });
await fs.mkdir(output, { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(cache, 'tmp');
const sha = data => createHash('sha256').update(data).digest('hex');
async function shaFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, destination, expectedHash) {
  try {
    await fs.access(destination);
    if (!expectedHash || await shaFile(destination) === expectedHash) return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  console.log(`Downloading ${path.basename(destination)}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const partial = destination + '.part';
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (expectedHash) assert.equal(await shaFile(partial), expectedHash, `Runtime checksum failed: ${url}`);
  await fs.rename(partial, destination);
}

const base = `https://nodejs.org/dist/${runtimeVersion}/`;
const sumsPath = path.join(cache, 'SHASUMS256.txt');
await download(`${base}SHASUMS256.txt`, sumsPath);
const sums = new Map((await fs.readFile(sumsPath, 'utf8')).trim().split(/\r?\n/).map(line => {
  const [hash, filename] = line.split(/\s+/);
  return [filename, hash];
}));
const variants = [
  { label: 'Windows-x64', artifact: `node-${runtimeVersion}-win-x64.zip`, node: 'node.exe', packageNode: 'runtime/node.exe' },
  { label: 'Mac-Apple-Silicon', artifact: `node-${runtimeVersion}-darwin-arm64.tar.gz`, node: 'bin/node', packageNode: 'runtime/bin/node' },
  { label: 'Mac-Intel', artifact: `node-${runtimeVersion}-darwin-x64.tar.gz`, node: 'bin/node', packageNode: 'runtime/bin/node' }
];
for (const variant of variants) {
  const hash = sums.get(variant.artifact);
  assert.match(hash ?? '', /^[a-f0-9]{64}$/, `Official runtime not found: ${variant.artifact}`);
  variant.archive = path.join(cache, variant.artifact);
  await download(`${base}${variant.artifact}`, variant.archive, hash);
  variant.unpacked = path.join(cache, variant.artifact.replace(/\.(zip|tar\.gz)$/, ''));
  if (!await fs.stat(path.join(variant.unpacked, variant.node)).then(() => true, () => false)) {
    execFileSync('tar.exe', ['-xf', variant.archive, '-C', cache], { stdio: 'inherit' });
  }
}
if (process.argv.includes('--download-only')) process.exit(0);

// Development-only browser dependency; the release contains no Playwright or npm.
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  await page.setContent('<style>body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#172b38"/><circle cx="32" cy="32" r="21" fill="#75dcc8"/><circle cx="42" cy="23" r="20" fill="#172b38"/><circle cx="47" cy="42" r="5" fill="#f9d58d"/></svg>');
  const png = await page.screenshot({ omitBackground: true });
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
  ico[6] = 64; ico[7] = 64; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(cache, 'app.ico'), Buffer.concat([ico, png]));
  await page.setViewportSize({ width: 1000, height: 1300 });
  await page.goto(pathToFileURL(path.join(root, 'docs', 'Quick-Start.html')).href);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
  const layout = await page.evaluate(() => {
    const pages = [...document.querySelectorAll('.page')];
    const issues = [];
    const ids = [...document.querySelectorAll('[id]')].map(node => node.id);
    if (ids.length !== new Set(ids).size) issues.push('Duplicate guide IDs');
    for (const [index, node] of pages.entries()) {
      if (!node.id.startsWith(index < 10 ? 'w-' : 'm-')) issues.push(`Page ${index+1}: wrong operating system section`);
      const footer = node.querySelector('.footer').getBoundingClientRect();
      if (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2) issues.push(`Page ${index+1}: overflow`);
      if (!node.querySelector('img')) issues.push(`Page ${index+1}: no picture`);
      for (const child of node.children) {
        if (child.classList.contains('footer')) continue;
        if (child.getBoundingClientRect().bottom > footer.top-7) issues.push(`Page ${index+1}: ${child.tagName} overlaps footer`);
      }
    }
    for (const image of document.images) if (!image.naturalWidth || !image.alt || !image.src.startsWith('data:image/png;base64,')) issues.push('Missing image, alt text or embedded data');
    for (const link of document.querySelectorAll('a[href^="#"]')) {
      const target = document.getElementById(link.hash.slice(1));
      if (!target) issues.push(`Broken link: ${link.hash}`);
      const namedPage = /page (\d+)/i.exec(link.textContent);
      if (target && namedPage && pages.indexOf(target.closest('.page'))+1 !== Number(namedPage[1])) issues.push(`Wrong page reference: ${link.textContent}`);
    }
    return { pages: pages.length, pictures: document.images.length, issues };
  });
  assert.equal(layout.pages, 19, 'Separate Windows and Mac walkthrough page count');
  assert.equal(layout.pictures, 28, 'Illustrated guide picture count');
  assert.deepEqual(layout.issues, [], 'Illustrated guide layout and pictures');
  const pdf = await page.pdf({ path: path.join(root, 'docs', 'Quick-Start.pdf'), preferCSSPageSize: true, printBackground: true, tagged: true, outline: true });
  assert.equal([...pdf.toString('latin1').matchAll(/\/Type\s*\/Page\b/g)].length, layout.pages);
  for (let i = 0; i < layout.pages; i++) await page.locator('.page').nth(i).screenshot({ path: path.join(cache, `guide-${i + 1}.png`) });
  console.log(`Quick Start: ${layout.pages} pages, ${layout.pictures} pictures; no overflow, footer overlaps or broken links`);
} finally { await browser.close(); }

const csc = path.join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const launcher = path.join(cache, 'LumaLatch.exe');
execFileSync(csc, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
  `/win32icon:${path.join(cache, 'app.ico')}`, `/out:${launcher}`,
  '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll',
  '/reference:System.Net.Http.dll', path.join(root, 'desktop', 'Launcher.cs')], { stdio: 'inherit' });

const manifest = JSON.parse(await fs.readFile('extension/manifest.json', 'utf8'));
const extensionId = sha(Buffer.from(manifest.key, 'base64')).slice(0, 32)
  .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const checksums = [];
for (const variant of [...variants, { label: 'Guest' }]) {
  const packageRoot = path.join(cache, 'stage', variant.label, 'LumaLatch');
  assert.ok(packageRoot.startsWith(cache + path.sep), 'Unsafe staging path');
  await fs.rm(packageRoot, { recursive: true, force: true });
  await fs.mkdir(packageRoot, { recursive: true });
  const copy = async (source, target) => {
    await fs.mkdir(path.dirname(path.join(packageRoot, target)), { recursive: true });
    await fs.cp(path.join(root, source), path.join(packageRoot, target), { recursive: true });
  };
  for (const name of ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js']) await copy(`extension/${name}`, `extension/${name}`);
  await copy('docs/Quick-Start.html', 'START-HERE.html');
  await copy('docs/Quick-Start.pdf', 'Quick-Start.pdf');
  const note = `LumaLatch ${version} - ${variant.label}\r\n\r\nExtract this entire ZIP to a permanent folder first.\r\n${variant.label === 'Windows-x64' ? 'Double-click LumaLatch.exe. No Node.js installation or commands needed.' : variant.label === 'Guest' ? 'Open START-HERE.html. Guests install only the Chrome extension; no server executable is needed.' : 'Double-click Start LumaLatch.command. The runtime is included; no npm installation needed.'}\r\n\r\nJellyfin: http://100.76.133.88:8096\r\nOpen START-HERE.html or Quick-Start.pdf for the steps.\r\nGoogle Chrome and Tailscale are separate prerequisites.\r\nChrome requires Developer mode > Load unpacked > extension folder.\r\nFixed extension ID: ${extensionId}\r\n\r\nWindows launcher is unsigned; it is not a signed installer.\r\nMac builds are not signed/notarized and have not been run on macOS here.\r\nDo not disable OS protections. Managed systems may require admin approval.\r\n\r\nKeep this whole folder. Moving the installed extension may require reloading it.\r\nSHA256SUMS.txt beside the release ZIPs verifies downloaded file integrity.\r\n`;
  await fs.writeFile(path.join(packageRoot, 'READ-ME-FIRST.txt'), note);
  if (variant.node) {
    await fs.mkdir(path.dirname(path.join(packageRoot, variant.packageNode)), { recursive: true });
    await fs.copyFile(path.join(variant.unpacked, variant.node), path.join(packageRoot, variant.packageNode));
    await fs.mkdir(path.join(packageRoot, 'licenses'), { recursive: true });
    await fs.copyFile(path.join(variant.unpacked, 'LICENSE'), path.join(packageRoot, 'licenses', 'Node-LICENSE.txt'));
    await copy('node_modules/ws', 'app/node_modules/ws');
    await copy('server', 'app/server');
    await fs.writeFile(path.join(packageRoot, 'app', 'package.json'), JSON.stringify({ name: 'lumalatch-runtime', version, private: true, type: 'module' }, null, 2));
    await fs.writeFile(path.join(packageRoot, 'licenses', 'THIRD-PARTY.txt'), `Node.js ${runtimeVersion}: https://nodejs.org/ (license included)\nws ${JSON.parse(await fs.readFile('node_modules/ws/package.json', 'utf8')).version}: https://github.com/websockets/ws (app/node_modules/ws/LICENSE included)\n`);
    if (variant.label === 'Windows-x64') await fs.copyFile(launcher, path.join(packageRoot, 'LumaLatch.exe'));
    else {
      await copy('desktop/Start LumaLatch.command', 'Start LumaLatch.command');
      await copy('desktop/mac-launcher.mjs', 'app/mac-launcher.mjs');
    }
  }
  const archive = path.join(output, `LumaLatch-${version}-${variant.label}.zip`);
  execFileSync('python', [path.join(root, 'scripts', 'archive.py'), packageRoot, archive], { stdio: 'inherit' });
  checksums.push(`${await shaFile(archive)}  ${path.basename(archive)}`);
}
await fs.writeFile(path.join(output, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
console.log(`Release built. Fixed extension ID: ${extensionId}`);
