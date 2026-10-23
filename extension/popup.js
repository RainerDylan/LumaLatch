const button = document.getElementById('enable');
const status = document.getElementById('status');
const activeTab = chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => tabs[0]);

button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    const tab = await activeTab;
    const url = new URL(tab.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Open your Jellyfin site first.');
    const origin = `${url.protocol}//${url.hostname}/*`;
    if (!await chrome.permissions.request({ origins: [origin] })) throw new Error('Site access was not granted.');
    const id = `site-${Array.from(new TextEncoder().encode(`${url.protocol}//${url.hostname}`), b => b.toString(16).padStart(2, '0')).join('')}`;
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
    if (!registered.length) await chrome.scripting.registerContentScripts([{ id, matches: [origin], js: ['content.js'], runAt: 'document_idle', allFrames: false, persistAcrossSessions: true }]);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    status.textContent = 'Enabled here. Open a video to start.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
