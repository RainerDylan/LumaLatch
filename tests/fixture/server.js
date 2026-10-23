import http from 'node:http';

const SAMPLE_RATE = 8_000;
const DURATION_SECONDS = 12;

function playableWave() {
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS;
  const wave = Buffer.alloc(44 + sampleCount);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(SAMPLE_RATE, 24);
  wave.writeUInt32LE(SAMPLE_RATE, 28);
  wave.writeUInt16LE(1, 32);
  wave.writeUInt16LE(8, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(sampleCount, 40);
  for (let index = 0; index < sampleCount; index++) {
    wave[44 + index] = 128 + Math.round(Math.sin(index * Math.PI / 20) * 16);
  }
  return wave;
}

const media = playableWave();
const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,">
<title>LumaLatch integration fixture</title>
<style>
  body{font:16px sans-serif;margin:24px} video{display:block;width:480px;height:270px;background:#111}
  [hidden]{display:none!important}.menu{margin-top:8px}.menu button{display:block}
</style>
<h1>Local Jellyfin fixture</h1>
<video id="video" muted playsinline preload="auto" src="/media.wav"></video>
<button class="btnSubtitles" type="button">Subtitles</button>
<div id="subtitle-menu" class="menu" role="menu" hidden><button role="menuitem" type="button">English</button></div>
<button class="btnVideoQuality" type="button">Quality</button>
<div id="quality-menu" class="menu" role="menu" hidden><button role="menuitem" type="button">720p</button><button role="menuitem" type="button">1080p</button></div>
<div id="fixture-status">Ready</div>
<script>
  window.__mediaEvents = [];
  const instrument = video => {
    for (const type of ['play', 'pause', 'seeked', 'ratechange']) {
      video.addEventListener(type, () => window.__mediaEvents.push({ type, at: Date.now(), instance: video.dataset.instance }));
    }
  };
  const configure = (video, instance) => {
    video.id = 'video';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = '/media.wav';
    video.dataset.instance = instance;
    instrument(video);
    return video;
  };
  configure(document.getElementById('video'), 'initial');
  window.replaceVideo = () => {
    const next = configure(document.createElement('video'), 'replacement');
    document.getElementById('video').replaceWith(next);
    return next;
  };
  document.querySelector('.btnSubtitles').addEventListener('click', () => document.getElementById('subtitle-menu').hidden = false);
  document.querySelector('.btnVideoQuality').addEventListener('click', () => document.getElementById('quality-menu').hidden = false);
  for (const option of document.querySelectorAll('[role="menuitem"]')) option.addEventListener('click', () => {
    const kind = option.closest('[id$="-menu"]').id.replace('-menu', '');
    document.body.dataset[kind] = option.textContent.trim();
    option.parentElement.hidden = true;
    document.getElementById('fixture-status').textContent = kind + ': ' + option.textContent.trim();
  });
</script>
</html>`;

function serveMedia(request, response) {
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' };
  const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  if (!match) {
    response.writeHead(200, { ...headers, 'Content-Length': media.length });
    return response.end(media);
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), media.length - 1) : media.length - 1;
  if (start >= media.length || end < start) {
    response.writeHead(416, { 'Content-Range': `bytes */${media.length}` });
    return response.end();
  }
  response.writeHead(206, {
    ...headers,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${media.length}`
  });
  response.end(media.subarray(start, end + 1));
}

export async function createFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    if (url.pathname === '/media.wav') return serveMedia(request, response);
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204);
      return response.end();
    }
    if (url.pathname !== '/') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found');
    }
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page),
      'Cache-Control': 'no-store'
    });
    response.end(page);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  };
}
