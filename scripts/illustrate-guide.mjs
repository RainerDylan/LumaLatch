// Refresh real UI captures and clearly labelled OS illustrations in the self-contained guide.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createFixtureServer } from '../tests/fixture/server.js';
import { createPartyServer } from '../server/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const cache = path.join(root, '.cache', 'illustrated-guide');
await fs.mkdir(path.join(cache, 'tmp'), { recursive: true });
process.env.TEMP = process.env.TMP = process.env.TMPDIR = path.join(cache, 'tmp');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('@playwright/test');
const extension = path.join(root, 'extension');
const manifest = JSON.parse(await fs.readFile(path.join(extension, 'manifest.json'), 'utf8'));
const extensionId = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + parseInt(value, 16)));
const context = await chromium.launchPersistentContext(path.join(cache, `profile-${Date.now()}`), {
  channel: 'chromium', headless: true, viewport: { width: 1060, height: 850 }, deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required']
});
let fixture, party;
const captures = new Map();
try {
  const drawing = await context.newPage();
  async function illustration(name, width, height, content) {
    await drawing.setViewportSize({ width, height });
    await drawing.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#edf3f0;color:#19313c;font:20px/1.4 Arial;padding:24px}.window{background:white;border:1px solid #bccbc7;border-radius:12px;overflow:hidden;box-shadow:0 5px 15px #1232}.bar{background:#e4e9e8;padding:12px 18px;font-weight:bold}.area{padding:20px}.line{padding:10px 14px;border-bottom:1px solid #e2e9e7}.selected{border:3px solid #126c5d;background:#e0f5ed;border-radius:6px}.button{display:inline-block;border-radius:5px;padding:8px 18px;background:#17695d;color:white;font-weight:bold}.badge{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:#f9d58d;color:#172b38;font-weight:bold;margin-right:10px}.muted{color:#546a70;font-size:17px}.row{display:flex;gap:20px}.device{flex:1;text-align:center;background:white;border:2px solid #92b5ac;border-radius:14px;padding:22px 12px}h2{margin:0 0 8px;font-size:25px}p{margin:8px 0}.folder{color:#20685c;font-weight:bold}</style>${content}`);
    await drawing.evaluate(() => document.fonts.ready);
    const png = await drawing.screenshot();
    captures.set(name, png);
    await fs.writeFile(path.join(cache, `${name}.png`), png);
  }
  async function annotated(name, png, width, height, marks) {
    await drawing.setViewportSize({ width:width+40, height:height+40 });
    await drawing.setContent(`<style>body{margin:0;background:white}img{position:absolute;left:20px;top:20px;width:${width}px;height:${height}px;display:block}.mark{position:absolute;box-sizing:border-box;border:3px solid #e5a923;border-radius:6px;box-shadow:0 0 0 2px white}.n{position:absolute;left:-17px;top:-19px;background:#f9d58d;border:2px solid white;color:#152f39;width:31px;height:31px;border-radius:50%;display:grid;place-items:center;font:700 20px Arial}[data-n="4"] .n{left:auto;right:-16px}</style><img src="data:image/png;base64,${png.toString('base64')}">${marks.map(m => `<div class="mark" data-n="${m.n}" style="left:${m.x+20}px;top:${m.y+20}px;width:${m.w}px;height:${m.h}px"><span class="n">${m.n}</span></div>`).join('')}`);
    const result = await drawing.screenshot();
    captures.set(name, result);
    await fs.writeFile(path.join(cache, `${name}.png`), result);
  }
  await illustration('devices', 1000, 330, `<h2>One server. Two watching laptops.</h2><div class="row"><div class="device"><span class="badge">1</span><h2>Main PC</h2><p>LumaLatch.exe</p><p>Start server</p><p class="muted">100.76.133.88</p></div><div class="device"><span class="badge">2</span><h2>Laptop 1</h2><p>Chrome extension</p><p>Create Party</p><p class="muted">Party host</p></div><div class="device"><span class="badge">3</span><h2>Laptop 2</h2><p>Chrome extension</p><p>Join Party</p><p class="muted">Guest</p></div></div>`);
  await illustration('windows-extract', 1000, 400, `<div class="window"><div class="bar">File Explorer · Downloads — illustration</div><div class="area"><div class="line selected">LumaLatch-0.2.0-Windows-x64.zip <span class="muted">(main PC)</span></div><div class="row" style="margin:18px 0 0 180px"><div class="window" style="width:340px"><div class="line">Open</div><div class="line selected"><span class="badge">1</span>Extract All…</div><div class="line muted">Copy</div></div><div style="padding-top:40px"><span class="badge">2</span>Choose Documents<br><br><span class="button">Extract</span></div></div></div></div>`);
  await illustration('windows-folder', 1000, 380, `<div class="window"><div class="bar">Documents › LumaLatch — extracted host folder · illustration</div><div class="area"><div class="line selected"><span class="badge">3</span><strong>LumaLatch.exe</strong> <span class="muted">Double-click on the main PC</span></div><div class="line folder">extension <span class="muted">Chrome uses this folder</span></div><div class="line folder">app &nbsp; runtime &nbsp; licenses <span class="muted">Keep these beside the app</span></div><div class="line">Quick-Start.pdf &nbsp; START-HERE.html</div></div></div>`);
  await illustration('mac-extract', 1000, 400, `<div class="window"><div class="bar">● &nbsp; ● &nbsp; ● &nbsp; Finder · Downloads — illustration</div><div class="row"><div style="background:#f0f2f1;padding:20px;width:210px"><p>Downloads</p><p class="selected" style="padding:8px">Documents</p></div><div class="area" style="flex:1"><div class="line selected"><span class="badge">1</span>LumaLatch-0.2.0-Guest.zip</div><p style="margin:18px 0"><span class="badge">2</span>Double-click the ZIP to extract.</p><div class="line folder"><span class="badge">3</span>LumaLatch → move into Documents</div><p class="muted">Laptop guests need the extension, not a Mac server runtime.</p></div></div></div>`);
  await illustration('choose-folder', 1000, 390, `<div class="window"><div class="bar">Windows · Choose the extension folder — illustration</div><div class="area"><div class="muted">File Explorer folder picker</div><div class="line folder">Documents</div><div class="line folder" style="padding-left:45px">LumaLatch</div><div class="line selected" style="margin-left:70px"><span class="badge">3</span><strong>extension</strong> <span class="muted">Select this folder</span></div><div style="text-align:right;margin-top:22px"><span class="button">Select Folder</span></div></div></div>`);
  await illustration('mac-choose-folder', 1000, 390, `<div class="window"><div class="bar">Mac · Choose the extension folder — illustration</div><div class="area"><div class="muted">Finder folder picker</div><div class="line folder">Documents</div><div class="line folder" style="padding-left:45px">LumaLatch</div><div class="line selected" style="margin-left:70px"><span class="badge">3</span><strong>extension</strong> <span class="muted">Select this folder</span></div><div style="text-align:right;margin-top:22px"><span class="button">Select</span></div></div></div>`);
  await illustration('chrome-toolbar', 1000, 220, `<div class="window"><div class="bar">Chrome toolbar — illustration</div><div class="area row" style="align-items:center"><div style="flex:1;background:#eef2f1;border-radius:24px;padding:12px 20px;font-size:17px">http://100.76.133.88:8096/web/index.html#/home</div><div class="selected" style="padding:8px"><span class="badge">1</span>Extensions</div><div>⋮</div></div><p class="muted" style="margin:0 20px 18px">Look for Chrome’s puzzle-piece icon near the top right, then choose LumaLatch.</p></div>`);
  const native = path.join(root, '.cache', 'release', "verify space & apostrophe's #", 'LumaLatch', 'ui-smoke.png');
  // Actual native launcher, before Start server; DrawToBitmap omits the combo's text.
  const nativeBytes = await fs.readFile(native);
  await drawing.setViewportSize({width:nativeBytes.readUInt32BE(16),height:nativeBytes.readUInt32BE(20)});
  await drawing.setContent(`<style>body{margin:0}img{display:block}</style><img src="data:image/png;base64,${nativeBytes.toString('base64')}">`);
  await drawing.locator('img').evaluate(node => node.decode());
  await annotated('launcher', await drawing.screenshot({clip:{x:14,y:320,width:810,height:375}}), 810, 375,
    [{n:1,x:8,y:267,w:785,h:29},{n:2,x:9,y:67,w:135,h:39},{n:3,x:9,y:112,w:190,h:38}]);
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.locator('extensions-toolbar').waitFor();
  const toggle = manager.locator('#devMode');
  if (!await toggle.evaluate(node => node.checked)) await toggle.click();
  await manager.locator('#loadUnpacked').waitFor({ state: 'visible' });
  await manager.locator('#loadUnpacked').scrollIntoViewIfNeeded();
  await manager.getByText('LumaLatch', { exact: true }).waitFor();
  const dev = await toggle.boundingBox();
  const load = await manager.locator('#loadUnpacked').boundingBox();
  await annotated('extensions', await manager.screenshot({clip:{x:0,y:0,width:1060,height:455}}), 1060, 455,
    [{n:1,x:dev.x-7,y:dev.y-6,w:dev.width+14,h:dev.height+12},
     {n:2,x:load.x-6,y:load.y-5,w:load.width+12,h:load.height+10}]);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupBytes = await popup.locator('body').screenshot();
  const popupSize = await popup.locator('body').boundingBox();
  const enable = await popup.locator('#enable').boundingBox();
  await annotated('popup', popupBytes, Math.round(popupSize.width), Math.round(popupSize.height),
    [{n:2,x:enable.x-3,y:enable.y-3,w:enable.width+6,h:enable.height+6}]);
  fixture = await createFixtureServer();
  party = await createPartyServer({ host: '100.76.133.88', port: 8787, allowedOrigins: [`chrome-extension://${extensionId}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  async function openPlayer() {
    const page = await context.newPage();
    await page.goto(fixture.url);
    const session = await context.browser().newBrowserCDPSession();
    try {
      const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }, { exclude: true }] });
      const target = targetInfos.filter(t => t.url === fixture.url).at(-1);
      assert.ok(target);
      await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
      await worker.evaluate(async url => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.filter(t => t.url === url).at(-1);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      }, fixture.url);
      const after = await session.send('Target.getTargets');
      for (const target of after.targetInfos.filter(t => t.url === `chrome-extension://${extensionId}/popup.html` && t.type !== 'page')) {
        await session.send('Target.closeTarget', { targetId: target.targetId });
      }
    } finally { await session.detach(); }
    await page.locator('#lumalatch-overlay').waitFor();
    await page.getByLabel('Signaling server').fill(party.url);
    return page;
  }
  async function panelShot(name, page, ids) {
    const panel = page.locator('#lumalatch-overlay .card');
    const base = await panel.boundingBox();
    const marks = [];
    for (const [n, selector] of ids) {
      const item = await page.locator(`#lumalatch-overlay ${selector}`).boundingBox();
      marks.push({ n, x:item.x-base.x-3, y:item.y-base.y-3, w:item.width+6, h:item.height+6 });
    }
    const height = Math.min(Math.ceil(base.height), Math.ceil(Math.max(...marks.map(m => m.y+m.h))+18));
    await annotated(name, await page.screenshot({clip:{x:base.x,y:base.y,width:Math.ceil(base.width),height}}), Math.ceil(base.width), height, marks);
  }
  const host = await openPlayer();
  await panelShot('connect', host, [[1,'#server'],[2,'#connect']]);
  await host.getByRole('button', { name:'Connect', exact:true }).click();
  await host.getByRole('status').filter({ hasText:'Connected.' }).waitFor();
  await panelShot('create', host, [[1,'#create']]);
  await host.getByRole('button', { name:'Create Party', exact:true }).click();
  await host.locator('#role').filter({ hasText:'Host' }).waitFor();
  await panelShot('host', host, [[1,'#role'],[2,'#copy'],[3,'#permissions']]);
  const roomId = await host.getByLabel('Party ID').inputValue();
  const guest = await openPlayer();
  await guest.getByRole('button', { name:'Connect', exact:true }).click();
  await guest.getByRole('status').filter({ hasText:'Connected.' }).waitFor();
  await guest.getByLabel('Party ID').fill(roomId);
  await panelShot('join', guest, [[1,'#room'],[2,'#join']]);
  await guest.getByRole('button', { name:'Join Party', exact:true }).click();
  await guest.locator('#role').filter({ hasText:'Guest' }).waitFor();
  await panelShot('guest', guest, [[3,'#role'],[4,'#status']]);
  await host.getByLabel('Guest playback', { exact:true }).check();
  const permissions = host.locator('#permissions');
  const permissionsPng = await permissions.screenshot();
  captures.set('permissions', permissionsPng);
  await fs.writeFile(path.join(cache, 'permissions.png'), permissionsPng);
  const health = await context.newPage();
  await health.goto('http://100.76.133.88:8787/health');
  assert.deepEqual(JSON.parse(await health.locator('body').innerText()), { ok:true });
  await illustration('health',1000,230,`<div class="window"><div class="bar">Connection check · URL and expected response</div><div class="area"><div class="line">http://100.76.133.88:8787/health</div><p style="font:28px Consolas,monospace;padding:6px 14px">{"ok":true}</p></div></div>`);
  let html = await fs.readFile('docs/Quick-Start.html', 'utf8');
  for (const [name, bytes] of captures) {
    const pattern = new RegExp(`(<img\\b[^>]*data-shot="${name}"[^>]*\\bsrc=")[^"]*(")`, 'g');
    let uses = 0;
    html = html.replace(pattern, (_match, before, after) => { uses++; return `${before}data:image/png;base64,${bytes.toString('base64')}${after}`; });
    assert.ok(uses > 0, `Unused guide picture ${name}`);
  }
  await fs.writeFile('docs/Quick-Start.html', html);
  await fs.writeFile(path.join(cache, 'capture-report.json'), JSON.stringify({ pictures: [...captures.keys()], source: 'Production extension with local test media; native launcher screenshot; labelled OS illustrations', roomClosed: true }, null, 2));
  console.log(`Embedded ${captures.size} pictures in Quick-Start.html`);
} finally {
  await context.close();
  await party?.close();
  await fixture?.close();
}
