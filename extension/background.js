const validPermissions = value => value && ['playback', 'subtitles', 'quality'].every(key => typeof value[key] === 'boolean');
const validState = value => value && Number.isFinite(value.position) && value.position >= 0 &&
  typeof value.paused === 'boolean' && Number.isFinite(value.rate) && value.rate >= 0.25 && value.rate <= 4 &&
  Number.isSafeInteger(value.serverTime) && value.serverTime >= 0 && Number.isSafeInteger(value.sequence) && value.sequence >= 0;

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'lumalatch' || !port.sender?.tab) return port.disconnect();
  let socket = null;
  let roomId = null;
  let role = null;
  let permissions = { playback: false, subtitles: false, quality: false };

  const send = message => { try { port.postMessage(message); } catch { /* tab closed */ } };
  const clearRoom = () => { roomId = null; role = null; permissions = { playback: false, subtitles: false, quality: false }; };
  const transmit = message => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else send({ type: 'error', message: 'Connect to the signaling server first.' });
  };
  const close = reason => {
    if (socket) {
      socket.onclose = socket.onmessage = socket.onerror = socket.onopen = null;
      socket.close();
      socket = null;
    }
    clearRoom();
    send({ type: 'connection', connected: false, reason });
  };

  port.onDisconnect.addListener(() => close('Tab closed.'));
  port.onMessage.addListener(message => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'connect') {
      let url;
      try {
        url = new URL(message.url);
        if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
        url.pathname = '/party';
      } catch { return send({ type: 'error', message: 'Enter a valid ws:// or wss:// signaling URL.' }); }
      close('Connecting…');
      try {
        socket = new WebSocket(url.href);
        socket.onopen = () => send({ type: 'connection', connected: true, url: url.href });
        socket.onerror = () => send({ type: 'error', message: `Signaling connection failed. Check the address and allow chrome-extension://${chrome.runtime.id} as a server origin.` });
        socket.onclose = () => { socket = null; clearRoom(); send({ type: 'connection', connected: false, reason: 'Connection closed. Connect again to rejoin.' }); };
        socket.onmessage = event => {
          let data;
          try { data = JSON.parse(event.data); } catch { return send({ type: 'error', message: 'Invalid server message.' }); }
          if (!data || typeof data.type !== 'string') return;
          if (data.type === 'probe') {
            if (Number.isSafeInteger(data.t0) && data.t0 >= 0) transmit({ type: 'probe', t0: data.t0, t1: Date.now() });
            return;
          }
          if (data.type === 'created' || data.type === 'joined') {
            if (typeof data.roomId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(data.roomId) ||
                data.role !== (data.type === 'created' ? 'host' : 'guest') || !validPermissions(data.permissions) || !validState(data.state)) {
              return send({ type: 'error', message: 'Invalid server room state.' });
            }
            roomId = data.roomId;
            role = data.role;
            permissions = data.permissions;
          }
          if (data.type === 'permissions') {
            if (!validPermissions(data.permissions)) return send({ type: 'error', message: 'Invalid server permissions.' });
            permissions = data.permissions;
          }
          if (data.type === 'state' && !validState(data)) return send({ type: 'error', message: 'Invalid server playback state.' });
          if (data.type === 'clock' && (!Number.isFinite(data.offset) || Math.abs(data.offset) > 86400000 ||
              !Number.isFinite(data.rtt) || data.rtt < 0 || data.rtt > 10000)) return;
          if (data.type === 'setting' && (!['subtitles', 'quality'].includes(data.kind) || typeof data.value !== 'string' ||
              data.value.length > 256 || /[\u0000-\u001f\u007f]/.test(data.value))) return;
          if (data.type === 'ended' || data.type === 'left') clearRoom();
          send(data);
        };
      } catch (error) { close(error.message); }
      return;
    }
    if (message.type === 'disconnect') return close('Disconnected.');
    if (message.type === 'leave') {
      if (roomId) transmit({ type: 'leave' });
      clearRoom();
      return;
    }
    if (socket?.readyState !== WebSocket.OPEN) return send({ type: 'error', message: 'Connect to the signaling server first.' });
    if (message.type === 'create' && !roomId) return transmit({ type: 'create' });
    if (message.type === 'join' && !roomId && typeof message.roomId === 'string') return transmit({ type: 'join', roomId: message.roomId.trim() });
    if (message.type === 'state' && roomId && (role === 'host' || permissions.playback)) {
      return transmit({ type: 'state', action: message.action, position: message.position, paused: message.paused, rate: message.rate,
        clientTime: Number.isSafeInteger(message.clientTime) ? message.clientTime : Date.now() });
    }
    if (message.type === 'permissions' && roomId && role === 'host') return transmit({ type: 'permissions', permissions: message.permissions });
    if (message.type === 'setting' && roomId && (role === 'host' || permissions[message.kind])) {
      return transmit({ type: 'setting', kind: message.kind, value: message.value });
    }
  });
});
