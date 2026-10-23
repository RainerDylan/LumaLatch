import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium, expect, test } from '@playwright/test';
import { createFixtureServer } from '../fixture/server.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const releaseRoot = process.env.LUMALATCH_RELEASE_ROOT;
const extensionDir = path.join(releaseRoot || rootDir, 'extension');
const { createPartyServer } = await import(pathToFileURL(releaseRoot ?
  path.join(releaseRoot, 'app', 'server', 'index.js') : path.join(rootDir, 'server', 'index.js')).href);

async function launchExtension(profileDir, browserErrors) {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required'
    ]
  });
  const monitorPage = page => {
    page.on('pageerror', error => browserErrors.push(`${page.url()}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') browserErrors.push(`${page.url()}: ${message.text()}`);
    });
  };
  context.pages().forEach(monitorPage);
  context.on('page', monitorPage);
  context.on('weberror', error => browserErrors.push(`${error.page()?.url() ?? 'worker'}: ${error.error().message}`));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  worker.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`${worker.url()}: ${message.text()}`);
  });
  const extensionId = new URL(worker.url()).host;
  expect(extensionId).toMatch(/^[a-p]{32}$/);
  return { context, worker, extensionId };
}

async function browserProcessId(context) {
  const session = await context.browser().newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    return processInfo.find(process => process.type === 'browser')?.id;
  } finally {
    await session.detach();
  }
}

async function enableExtension(context, worker, extensionId, fixtureUrl) {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(fixtureUrl);
  const session = await context.browser().newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets', {
    filter: [{ type: 'tab' }, { exclude: true }]
  });
  const target = targetInfos.find(candidate => candidate.url === fixtureUrl);
  if (!target) throw new Error('Fixture page target was not found');
  await session.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  await worker.evaluate(async fixtureUrl => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(candidate => candidate.url?.startsWith(fixtureUrl));
    if (!tab?.id) throw new Error('Fixture tab was not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  }, fixtureUrl);
  const afterAction = await session.send('Target.getTargets');
  const popup = afterAction.targetInfos.find(candidate => candidate.url === `chrome-extension://${extensionId}/popup.html`);
  if (popup) await session.send('Target.closeTarget', { targetId: popup.targetId });
  await session.detach();
  await expect(page.locator('#lumalatch-overlay')).toBeAttached();
  await page.locator('video').evaluate(video => video.readyState >= 1 ? undefined : new Promise(resolve => {
    video.addEventListener('loadedmetadata', resolve, { once: true });
  }));
  return page;
}

async function connect(page, serverUrl) {
  await page.getByLabel('Signaling server').fill(serverUrl);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Connected.');
}

const eventCount = (page, type) => page.evaluate(type => window.__mediaEvents.filter(event => event.type === type).length, type);

async function waitForEvent(page, type, index) {
  await page.waitForFunction(({ type, index }) =>
    window.__mediaEvents.filter(event => event.type === type).length > index, { type, index });
  return page.evaluate(({ type, index }) =>
    window.__mediaEvents.filter(event => event.type === type)[index], { type, index });
}

async function setCurrentTime(page, time) {
  const before = await eventCount(page, 'seeked');
  await page.locator('video').evaluate((video, value) => { video.currentTime = value; }, time);
  await waitForEvent(page, 'seeked', before);
}

test('two extension processes synchronize real media and enforce guest permissions', async ({}, testInfo) => {
  const browserErrors = [];
  const latencies = [];
  const serverPauses = [];
  let fixture;
  let party;
  let host;
  let guest;
  let failure;

  try {
    fixture = await createFixtureServer();
    host = await launchExtension(testInfo.outputPath('host-profile'), browserErrors);
    guest = await launchExtension(testInfo.outputPath('guest-profile'), browserErrors);

    expect(host.extensionId).toBe(guest.extensionId);
    const [hostPid, guestPid] = await Promise.all([
      browserProcessId(host.context),
      browserProcessId(guest.context)
    ]);
    expect(hostPid, 'host browser PID').toBeTruthy();
    expect(guestPid, 'guest browser PID').toBeTruthy();
    expect(hostPid, 'persistent contexts must use independent Chromium processes').not.toBe(guestPid);

    party = await createPartyServer({ allowedOrigins: [`chrome-extension://${host.extensionId}`] });
    party.wss.on('connection', socket => socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'state' && message.action === 'pause') {
        serverPauses.push({ clientTime: message.clientTime, receivedAt: Date.now() });
      }
    }));
    const [hostPage, guestPage] = await Promise.all([
      enableExtension(host.context, host.worker, host.extensionId, fixture.url),
      enableExtension(guest.context, guest.worker, guest.extensionId, fixture.url)
    ]);
    await Promise.all([connect(hostPage, party.url), connect(guestPage, party.url)]);

    await hostPage.getByRole('button', { name: 'Create Party' }).click();
    await expect(hostPage.getByRole('status')).toContainText('Party created.');
    const roomId = await hostPage.getByLabel('Party ID').inputValue();
    expect(roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await guestPage.getByLabel('Party ID').fill(roomId);
    await guestPage.getByRole('button', { name: 'Join Party' }).click();
    await expect(guestPage.getByRole('status')).toContainText('Joined party.');

    const initialGuestPlay = await eventCount(guestPage, 'play');
    await hostPage.locator('video').evaluate(video => video.play());
    await waitForEvent(guestPage, 'play', initialGuestPlay);

    for (let sample = 0; sample < 6; sample++) {
      const hostPauseIndex = await eventCount(hostPage, 'pause');
      const guestPauseIndex = await eventCount(guestPage, 'pause');
      await hostPage.locator('video').evaluate(video => video.pause());
      const [hostEvent, guestEvent] = await Promise.all([
        waitForEvent(hostPage, 'pause', hostPauseIndex),
        waitForEvent(guestPage, 'pause', guestPauseIndex)
      ]);
      const latencyMs = guestEvent.at - hostEvent.at;
      latencies.push({ sample: sample + 1, hostAt: hostEvent.at, guestAt: guestEvent.at, latencyMs,
        serverReceivedAt: serverPauses[sample]?.receivedAt, clientTime: serverPauses[sample]?.clientTime });
      expect(latencyMs, `pause sample ${sample + 1}`).toBeGreaterThanOrEqual(0);
      expect(latencyMs, `pause sample ${sample + 1}`).toBeLessThanOrEqual(50);
      if (sample < 5) {
        const guestPlayIndex = await eventCount(guestPage, 'play');
        await hostPage.locator('video').evaluate(video => video.play());
        await waitForEvent(guestPage, 'play', guestPlayIndex);
      }
    }

    const guestRateIndex = await eventCount(guestPage, 'ratechange');
    const guestSeekIndex = await eventCount(guestPage, 'seeked');
    await hostPage.locator('video').evaluate(video => {
      video.playbackRate = 1.5;
      video.currentTime = 3.25;
    });
    await Promise.all([
      waitForEvent(guestPage, 'ratechange', guestRateIndex),
      waitForEvent(guestPage, 'seeked', guestSeekIndex)
    ]);
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.playbackRate)).toBe(1.5);
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(3.25, 1);

    await expect(guestPage.getByRole('button', { name: 'Set subtitles' })).toBeDisabled();
    await expect(guestPage.getByRole('button', { name: 'Set quality' })).toBeDisabled();
    await guestPage.locator('.btnSubtitles').click();
    await expect(guestPage.locator('#subtitle-menu')).toBeHidden();
    await guestPage.locator('.btnVideoQuality').click();
    await expect(guestPage.locator('#quality-menu')).toBeHidden();
    await setCurrentTime(guestPage, 4.75);
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(3.25, 1);
    expect(await hostPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(3.25, 1);

    await hostPage.getByLabel('Guest playback').check();
    await expect(guestPage.getByLabel('Guest playback')).toBeChecked();
    await setCurrentTime(guestPage, 5.5);
    await expect.poll(() => hostPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(5.5, 1);

    await hostPage.getByLabel('Guest subtitles').check();
    await hostPage.getByLabel('Guest quality').check();
    await expect(guestPage.getByRole('button', { name: 'Set subtitles' })).toBeEnabled();
    await expect(guestPage.getByRole('button', { name: 'Set quality' })).toBeEnabled();
    await guestPage.locator('.btnSubtitles').click();
    await expect(guestPage.locator('#subtitle-menu')).toBeVisible();
    await guestPage.locator('#subtitle-menu').getByRole('menuitem', { name: 'English' }).click();
    await expect.poll(() => guestPage.locator('body').getAttribute('data-subtitle')).toBe('English');
    await guestPage.getByLabel('Subtitle track').fill('English');
    await guestPage.getByRole('button', { name: 'Set subtitles' }).click();
    await expect.poll(() => hostPage.locator('body').getAttribute('data-subtitle')).toBe('English');
    await guestPage.getByLabel('Quality', { exact: true }).fill('720p');
    await guestPage.getByRole('button', { name: 'Set quality' }).click();
    await expect.poll(() => hostPage.locator('body').getAttribute('data-quality')).toBe('720p');

    await guestPage.locator('.btnVideoQuality').click();
    await expect(guestPage.locator('#quality-menu')).toBeVisible();
    await hostPage.getByLabel('Guest quality').uncheck();
    await expect(guestPage.getByRole('button', { name: 'Set quality' })).toBeDisabled();
    await guestPage.locator('#quality-menu').getByRole('menuitem', { name: '1080p' }).click();
    await expect(guestPage.locator('#quality-menu')).toBeVisible();
    expect(await guestPage.locator('body').getAttribute('data-quality')).toBe('720p');
    await hostPage.getByLabel('Quality', { exact: true }).fill('1080p');
    await hostPage.getByRole('button', { name: 'Set quality' }).click();
    await expect.poll(() => guestPage.locator('body').getAttribute('data-quality')).toBe('1080p');

    await hostPage.getByLabel('Guest playback').uncheck();
    await expect(guestPage.getByLabel('Guest playback')).not.toBeChecked();
    await setCurrentTime(guestPage, 6.75);
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(5.5, 1);

    await host.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: fixture.url });
    await hostPage.evaluate(() => history.replaceState(null, '', '?api_key=secret&X-Emby-Token=secret#/videoosd?id=movie&api_key=secret'));
    await hostPage.getByRole('button', { name: 'Copy invite' }).click();
    await expect(hostPage.getByRole('status')).toContainText('Invite copied.');
    const invite = new URL(await hostPage.evaluate(() => navigator.clipboard.readText()));
    expect(invite.searchParams.get('lumalatchRoom')).toBe(roomId);
    expect(invite.searchParams.get('lumalatchServer')).toBe(party.url);
    expect(invite.href).not.toContain('secret');
    expect(invite.hash).toBe('#/videoosd?id=movie');

    await hostPage.evaluate(() => window.replaceVideo());
    await expect(hostPage.locator('video')).toHaveAttribute('data-instance', 'replacement');
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.currentTime)).toBeLessThan(0.4);
    await hostPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await setCurrentTime(hostPage, 1.75);
    await expect.poll(() => guestPage.locator('video').evaluate(video => video.currentTime)).toBeCloseTo(1.75, 1);
    await hostPage.getByRole('button', { name: 'Leave Party' }).click();
    await expect(guestPage.getByRole('status')).toContainText('Host ended the party.');
  } catch (error) {
    failure = error;
  } finally {
    if (latencies.length) {
      fs.writeFileSync(testInfo.outputPath('pause-latencies.json'), JSON.stringify(latencies, null, 2));
      await testInfo.attach('pause-latencies.json', {
        body: Buffer.from(JSON.stringify(latencies, null, 2)),
        contentType: 'application/json'
      });
      console.log(`pause latencies ms: ${latencies.map(sample => sample.latencyMs).join(', ')}`);
    }
    await Promise.allSettled([
      host?.context.close(),
      guest?.context.close(),
      party?.close(),
      fixture?.close()
    ].filter(Boolean));
  }

  if (browserErrors.length) {
    throw new Error(`Unexpected browser errors:\n${browserErrors.join('\n')}`, { cause: failure });
  }
  if (failure) throw failure;
});
