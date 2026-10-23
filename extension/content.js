(() => {
  if (globalThis.__lumalatchLoaded) return;
  globalThis.__lumalatchLoaded = true;

  const port = chrome.runtime.connect({ name: 'lumalatch' });
  const host = document.createElement('div');
  host.id = 'lumalatch-overlay';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host{all:initial;position:fixed;right:18px;bottom:18px;z-index:2147483647;color:#f6f4ed;font:13px/1.45 system-ui,sans-serif}
      *{box-sizing:border-box} .card{width:min(338px,calc(100vw - 24px));max-height:min(82vh,720px);overflow:auto;background:#172b38f5;border:1px solid #58877f;border-radius:16px;box-shadow:0 18px 55px #0009;padding:16px;backdrop-filter:blur(16px)}
      header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}h2{font-size:18px;letter-spacing:.01em;margin:0;color:#f6f4ed} .mark{display:inline-block;color:#75dcc8;margin-right:7px}
      .badge{font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#b7e9de;border:1px solid #58877f;border-radius:99px;padding:3px 8px}
      label{display:block;color:#d0dedd;font-weight:600;margin:10px 0 5px} input[type=url],input[type=text]{width:100%;border:1px solid #71918d;border-radius:8px;background:#0e202b;color:white;padding:9px 10px;font:13px system-ui;outline:none}input:focus-visible,button:focus-visible{outline:2px solid #f9d58d;outline-offset:2px}
      .row{display:flex;gap:7px;margin-top:8px}.row>*{min-width:0}.row input{flex:1}.row button{flex:none}button{border:1px solid #78b4a9;background:#254a53;color:#f6f4ed;border-radius:8px;padding:8px 10px;font:600 12px system-ui;cursor:pointer}button:hover:not(:disabled){background:#34646a}button:disabled{opacity:.45;cursor:default}.primary{background:#75dcc8;border-color:#75dcc8;color:#112b32}.primary:hover:not(:disabled){background:#9fe9d8}
      .divider{border:0;border-top:1px solid #45616a;margin:14px 0}.quiet{color:#a9c1c3;font-size:12px}.switch{display:flex;align-items:center;gap:9px;font-weight:500;margin:8px 0;color:#f6f4ed}.switch input{accent-color:#75dcc8;width:17px;height:17px;margin:0}
      #status{min-height:20px;margin:12px 0 0;color:#b7e9de;overflow-wrap:anywhere}.section-title{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#a9c1c3}
      [hidden]{display:none!important}
    </style>
    <section class="card" aria-label="LumaLatch player controls">
      <header><h2><span class="mark" aria-hidden="true">◉</span>LumaLatch</h2><span id="role" class="badge">Offline</span></header>
      <label for="server">Signaling server</label><input id="server" type="url" aria-label="Signaling server" placeholder="ws://100.x.y.z:8787/party" spellcheck="false" autocomplete="off">
      <div class="row"><button id="connect" type="button" class="primary">Connect</button><button id="disconnect" type="button" hidden>Disconnect</button></div>
      <hr class="divider"><p class="section-title">Watch party</p>
      <div class="row"><button id="create" type="button">Create Party</button><button id="leave" type="button">Leave Party</button></div>
      <label for="room">Party ID</label><div class="row"><input id="room" type="text" aria-label="Party ID" spellcheck="false" autocomplete="off"><button id="join" type="button">Join Party</button></div>
      <div class="row"><button id="copy" type="button">Copy invite</button></div>
      <div id="permissions" hidden><hr class="divider"><p class="section-title">Guest permissions</p>
        <label class="switch"><input id="playback" type="checkbox">Guest playback</label>
        <label class="switch"><input id="subtitles" type="checkbox">Guest subtitles</label>
        <label class="switch"><input id="quality" type="checkbox">Guest quality</label>
      </div>
      <hr class="divider"><p class="section-title">Jellyfin settings</p>
      <label for="subtitleValue">Subtitle track</label><div class="row"><input id="subtitleValue" type="text" placeholder="Native menu label" maxlength="100"><button id="applySubtitle" type="button">Set subtitles</button></div>
      <label for="qualityValue">Quality</label><div class="row"><input id="qualityValue" type="text" placeholder="Native menu label" maxlength="100"><button id="applyQuality" type="button">Set quality</button></div>
      <p class="quiet">Settings use Jellyfin's player menus. Unsupported menus are reported here.</p>
      <div id="status" role="status" aria-live="polite">Open a video, then connect.</div>
    </section>`;

  const $ = id => root.getElementById(id);
  let video = null;
  let connected = false;
  let roomId = null;
  let role = null;
  let serverUrl = '';
  let permissions = { playback: false, subtitles: false, quality: false };
  let clockOffset = 0;
  let sequence = -1;
  let latestState = null;
  const suppressed = new Map();

  const status = text => { $('status').textContent = text; };
  const post = message => port.postMessage(message);
  const can = kind => !!roomId && (role === 'host' || permissions[kind]);
  const draw = () => {
    $('role').textContent = role === 'host' ? 'Host' : role === 'guest' ? 'Guest' : connected ? 'Connected' : 'Offline';
    $('connect').hidden = connected;
    $('disconnect').hidden = !connected;
    $('create').disabled = !connected || !!roomId;
    $('join').disabled = !connected || !!roomId;
    $('leave').disabled = !roomId;
    $('copy').disabled = !roomId;
    $('permissions').hidden = role !== 'host';
    for (const key of ['playback', 'subtitles', 'quality']) $(key).checked = !!permissions[key];
    $('applySubtitle').disabled = !can('subtitles');
    $('applyQuality').disabled = !can('quality');
  };
  const mark = (event, value) => {
    suppressed.set(event, { value, expires: Date.now() + 1500 });
  };
  const isSuppressed = event => {
    const expected = suppressed.get(event.type);
    if (!expected || Date.now() > expected.expires) return false;
    const matches = event.type === 'seeked' ? Math.abs(video.currentTime - expected.value) < 0.5 :
      event.type === 'ratechange' ? Math.abs(video.playbackRate - expected.value) < 0.001 :
      event.type === 'pause' ? video.paused : !video.paused;
    if (matches) suppressed.delete(event.type);
    return matches;
  };
  const sendState = action => {
    if (!video || !can('playback') || !Number.isFinite(video.currentTime)) return;
    post({ type: 'state', action, position: Math.max(0, video.currentTime), paused: video.paused, rate: video.playbackRate, clientTime: Date.now() });
  };
  const onPlayback = event => {
    if (isSuppressed(event)) return;
    if (roomId && role === 'guest' && !permissions.playback) {
      if (latestState) applyState(latestState, true);
      status('Playback control requires host permission.');
      return;
    }
    sendState(event.type);
  };
  const bindVideo = next => {
    if (video === next) return;
    if (video) for (const name of ['play', 'pause', 'seeked', 'ratechange']) video.removeEventListener(name, onPlayback);
    video = next;
    suppressed.clear();
    if (video) {
      for (const name of ['play', 'pause', 'seeked', 'ratechange']) video.addEventListener(name, onPlayback);
      if (role === 'guest' && latestState) { sequence = -1; applyState(latestState); }
      if (role === 'host') sendState('sync');
    }
  };
  const scan = () => {
    const next = document.querySelector('video');
    bindVideo(next);
    const container = document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.body;
    if (next && container && host.parentNode !== container) container.append(host);
    if (!next && host.isConnected) host.remove();
  };
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('fullscreenchange', scan);
  scan();

  function applyState(state, force = false) {
    if (!state || !Number.isFinite(state.position) || !Number.isFinite(state.serverTime) || !Number.isFinite(state.rate)) return;
    latestState = state;
    if (!video) return;
    if (!force && state.sequence <= sequence) return;
    sequence = state.sequence;
    const elapsed = state.paused ? 0 : Math.max(0, (Date.now() + clockOffset - state.serverTime) / 1000);
    const target = Math.max(0, state.position + elapsed * state.rate);
    if (state.paused && !video.paused) { mark('pause', true); video.pause(); }
    if (Math.abs(video.playbackRate - state.rate) > 0.001) { mark('ratechange', state.rate); video.playbackRate = state.rate; }
    if (Math.abs(video.currentTime - target) > (state.action === 'sync' && !force ? 0.25 : 0.04)) {
      const seekTo = Number.isFinite(video.duration) ? Math.min(target, video.duration) : target;
      mark('seeked', seekTo);
      try { video.currentTime = seekTo; }
      catch { status('Player cannot seek to the synchronized position.'); }
    }
    if (!state.paused && video.paused) {
      mark('play', true);
      video.play().catch(error => {
        suppressed.delete('play');
        status(`Playback blocked: ${error.message}. Press play in Jellyfin.`);
      });
    }
  }

  const menuControls = {
    subtitles: '.btnSubtitles, [aria-label*="subtitle" i], [title*="subtitle" i]',
    quality: '.btnVideoQuality, .btnQuality, [aria-label*="quality" i], [title*="quality" i]'
  };
  const menuOptions = '[role="menuitem"], [role="option"], .listItem, .actionSheetMenuItem, .selectMenuItem';
  let activeMenu = null;
  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const kind = Object.keys(menuControls).find(key => event.target.closest(menuControls[key]));
    if (kind) activeMenu = kind;
    else if (!event.target.closest(menuOptions)) activeMenu = null;
    if (roomId && role === 'guest' && activeMenu && !permissions[activeMenu]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      status(`Jellyfin ${activeMenu} control requires host permission.`);
    }
  }, true);

  // ponytail: Jellyfin menu names vary by version; add a version adapter when a real menu shape is identified.
  async function applySetting(kind, value) {
    const visible = node => node instanceof HTMLElement && !!node.getClientRects().length;
    const trigger = [...document.querySelectorAll(menuControls[kind])].find(visible);
    if (!trigger) return status(`Jellyfin ${kind} menu unsupported on this player.`);
    trigger.click();
    const deadline = Date.now() + 1200;
    while (Date.now() < deadline) {
      const options = document.querySelectorAll(menuOptions);
      const option = [...options].find(node => visible(node) && node.textContent.trim().toLowerCase() === value.trim().toLowerCase());
      if (option) { option.click(); status(`Jellyfin ${kind}: ${value}`); return; }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    status(`Jellyfin ${kind} option “${value}” unsupported or unavailable.`);
  }

  function inviteUrl() {
    const source = new URL(location.href);
    const invite = new URL(source.pathname, source.origin);
    const allowed = ['id', 'itemId', 'serverId', 'parentId'];
    for (const key of allowed) if (source.searchParams.has(key)) invite.searchParams.set(key, source.searchParams.get(key));
    const [route, hashQuery] = source.hash.slice(1).split('?');
    if (/^\/[\w/-]*$/.test(route || '')) {
      const safeHash = new URLSearchParams();
      const params = new URLSearchParams(hashQuery || '');
      for (const key of allowed) if (params.has(key)) safeHash.set(key, params.get(key));
      invite.hash = `#${route}${safeHash.size ? `?${safeHash}` : ''}`;
    }
    invite.searchParams.set('lumalatchRoom', roomId);
    invite.searchParams.set('lumalatchServer', serverUrl);
    return invite.href;
  }

  const incoming = new URL(location.href);
  if (incoming.searchParams.has('lumalatchRoom')) $('room').value = incoming.searchParams.get('lumalatchRoom');
  if (incoming.searchParams.has('lumalatchServer')) $('server').value = incoming.searchParams.get('lumalatchServer');
  chrome.storage.local.get('serverUrl').then(saved => {
    if (!$('server').value) $('server').value = saved.serverUrl || 'ws://100.76.133.88:8787/party';
  });

  $('connect').addEventListener('click', () => { status('Connecting…'); post({ type: 'connect', url: $('server').value.trim() }); });
  $('disconnect').addEventListener('click', () => post({ type: 'disconnect' }));
  $('create').addEventListener('click', () => post({ type: 'create' }));
  $('join').addEventListener('click', () => post({ type: 'join', roomId: $('room').value.trim() }));
  $('leave').addEventListener('click', () => { post({ type: 'leave' }); roomId = role = latestState = null; sequence = -1; draw(); status('Left party.'); });
  $('copy').addEventListener('click', async () => {
    try {
      const value = inviteUrl();
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const input = document.createElement('textarea'); input.value = value; document.body.append(input); input.select();
        if (!document.execCommand('copy')) throw Error('Clipboard unavailable');
        input.remove();
      }
      status('Invite copied. Your friend must connect and join explicitly.');
    } catch (error) { status(`Could not copy invite: ${error.message}`); }
  });
  for (const key of ['playback', 'subtitles', 'quality']) $(key).addEventListener('change', () => {
    if (role !== 'host') return;
    post({ type: 'permissions', permissions: {
      playback: $('playback').checked, subtitles: $('subtitles').checked, quality: $('quality').checked
    } });
  });
  for (const [kind, field, button] of [['subtitles', 'subtitleValue', 'applySubtitle'], ['quality', 'qualityValue', 'applyQuality']]) {
    $(button).addEventListener('click', () => {
      const value = $(field).value.trim();
      if (!value || !can(kind)) return;
      post({ type: 'setting', kind, value });
    });
  }

  port.onMessage.addListener(message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'connection') {
      connected = message.connected;
      if (!connected) { roomId = role = latestState = null; sequence = -1; }
      else {
        serverUrl = message.url;
        $('server').value = serverUrl;
        chrome.storage.local.set({ serverUrl });
      }
      status(message.connected ? 'Connected. Create or join a party.' : message.reason || 'Disconnected.');
    } else if (message.type === 'created' || message.type === 'joined') {
      roomId = message.roomId;
      role = message.role;
      permissions = message.permissions;
      sequence = -1;
      latestState = null;
      $('room').value = roomId;
      status(role === 'host' ? 'Party created. Share the invite.' : 'Joined party.');
      if (role === 'host') sendState('sync');
      else applyState(message.state);
    } else if (message.type === 'state') applyState(message);
    else if (message.type === 'clock' && Number.isFinite(message.offset)) clockOffset = message.offset;
    else if (message.type === 'permissions') permissions = message.permissions;
    else if (message.type === 'setting') applySetting(message.kind, message.value);
    else if (message.type === 'ended' || message.type === 'left') { roomId = role = latestState = null; sequence = -1; status(message.type === 'ended' ? 'Host ended the party.' : 'Left party.'); }
    else if (message.type === 'error') status(message.message || 'Server error.');
    draw();
  });
  setInterval(() => { if (role === 'host') sendState('sync'); }, 2000);
  draw();
})();
