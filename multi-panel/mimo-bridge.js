import { applyTheme } from '../modules/theme-manager.js';

const MIMO_URL = 'https://aistudio.xiaomimimo.com/#/c';
const MIMO_ORIGIN = new URL(MIMO_URL).origin;
const MIMO_TAB_SESSION_KEY_PREFIX = 'panelizeMimoTabId';
const PANEL_CONTEXT = 'multi-panel';
const STATUS_CONTEXT = 'multi-panel-provider-status';
const ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
const COMMANDS = new Set([
  'INJECT_TEXT', 'INJECT_TEXT_WITH_IMAGES', 'TRIGGER_SEND', 'CLEAR_INPUT', 'NEW_CHAT'
]);

const connectionElement = document.getElementById('connection');
const statusElement = document.getElementById('status');
const responseElement = document.getElementById('response');
const connectButton = document.getElementById('connect');
let tabId = null;
let connected = false;
let checking = false;
const sessionKeyPromise = chrome.tabs.getCurrent()
  .then(tab => `${MIMO_TAB_SESSION_KEY_PREFIX}:${tab?.id ?? crypto.randomUUID()}`);

async function getSessionKey() {
  return sessionKeyPromise;
}

function postToPanel(payload) {
  window.parent.postMessage(payload, window.location.origin);
}

function updateConnection(isConnected, message, url = null) {
  connected = isConnected;
  connectionElement.textContent = isConnected ? 'Connected' : 'Not connected';
  statusElement.textContent = message;
  connectButton.textContent = tabId === null ? 'Open MiMo tab' : 'Show MiMo tab';
  if (!isConnected) responseElement.textContent = '';
  postToPanel({
    type: 'PANELIZE_MIMO_CONNECTION',
    provider: 'mimo',
    connected: isConnected,
    context: STATUS_CONTEXT
  });
  if (url) {
    postToPanel({
      type: 'PANELIZE_PROVIDER_LOCATION',
      provider: 'mimo',
      url,
      context: STATUS_CONTEXT
    });
  }
}

async function findMiMoTab() {
  const sessionKey = await getSessionKey();
  const stored = await chrome.storage.session.get(sessionKey);
  const storedId = stored[sessionKey];
  if (Number.isInteger(storedId)) {
    const tab = await chrome.tabs.get(storedId).catch(() => null);
    if (tab && !tab.url) return tab;
    if (tab?.url) {
      try {
        const origin = new URL(tab.url).origin;
        if (origin === MIMO_ORIGIN || origin === 'https://account.xiaomi.com') return tab;
      } catch {
        // The stored tab no longer points at MiMo.
      }
    }
  }
  await chrome.storage.session.remove(sessionKey);
  return null;
}

async function waitForMiMoScriptRegistration() {
  for (let attempt = 0; attempt < 12; attempt++) {
    const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['mimo-scripts'] });
    if (scripts.some(script => script.id === 'mimo-scripts')) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function checkConnection() {
  if (checking) return;
  checking = true;
  try {
    if (tabId === null) {
      tabId = (await findMiMoTab())?.id ?? null;
    }
    if (tabId === null) {
      updateConnection(false, 'Open MiMo in a browser tab to sign in and connect.');
      return;
    }
    const snapshot = await chrome.tabs.sendMessage(
      tabId,
      { type: 'PANELIZE_MIMO_SNAPSHOT' },
      { frameId: 0 }
    );
    if (snapshot?.provider !== 'mimo') {
      throw new Error('MiMo content script is not ready');
    }
    if (!snapshot.authenticated) {
      updateConnection(false, 'Sign in in the MiMo tab, then return here.', snapshot.url);
      return;
    }
    if (snapshot.draftConflict) {
      updateConnection(false, 'MiMo has an unsent draft. Handle it in the MiMo tab before connecting.', snapshot.url);
      return;
    }
    updateConnection(true, 'Ready to receive prompts from Panelize.', snapshot.url);
    responseElement.textContent = snapshot.responseText || '';
  } catch (error) {
    const tab = tabId === null ? null : await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      tabId = null;
      await chrome.storage.session.remove(await getSessionKey());
    }
    updateConnection(
      false,
      tab ? 'Finish loading or signing in in the MiMo tab.' : 'Open MiMo in a browser tab to connect.'
    );
  } finally {
    checking = false;
  }
}

async function openMiMoTab() {
  let tab = await findMiMoTab();
  if (tab?.url && new URL(tab.url).origin === MIMO_ORIGIN) {
    try {
      await chrome.tabs.sendMessage(
        tab.id,
        { type: 'PANELIZE_MIMO_SNAPSHOT' },
        { frameId: 0 }
      );
    } catch {
      // A tab opened before permission was granted has no registered content script.
      tab = null;
    }
  }
  if (!tab) {
    if (!await waitForMiMoScriptRegistration()) {
      updateConnection(false, 'Enable MiMo site access in Settings, then try again.');
      return;
    }
    tab = await chrome.tabs.create({ url: MIMO_URL, active: true });
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  tabId = tab.id;
  await chrome.storage.session.set({ [await getSessionKey()]: tabId });
  updateConnection(false, 'Sign in in the MiMo tab, then return here.');
  void checkConnection();
}

function reportUnavailable(requestId, reason = 'control-not-found') {
  if (!requestId) return;
  postToPanel({
    type: 'PANELIZE_ACTION_RESULT',
    context: ACTION_RESULT_CONTEXT,
    requestId,
    provider: 'mimo',
    action: 'fill',
    status: 'failed',
    reason,
    succeededImageIds: []
  });
}

async function forwardToMiMo(data) {
  const options = { frameId: 0 };
  if (data.type === 'INJECT_TEXT_WITH_IMAGES' && data.images?.length) {
    if (typeof data.requestId !== 'string' || !data.requestId) {
      return { accepted: false, reason: 'invalid-image' };
    }
    for (const [index, image] of data.images.entries()) {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: 'PANELIZE_MIMO_STAGE_IMAGE',
        context: 'multi-panel-bridge',
        requestId: data.requestId,
        image,
        index,
        total: data.images.length
      }, options);
      if (result?.accepted !== true) return result;
    }
    const { images, ...command } = data;
    return chrome.tabs.sendMessage(tabId, {
      ...command,
      stagedImageRequestId: data.requestId,
      context: 'multi-panel-bridge'
    }, options);
  }
  return chrome.tabs.sendMessage(tabId, {
    ...data,
    context: 'multi-panel-bridge'
  }, options);
}

window.addEventListener('message', async (event) => {
  if (event.source !== window.parent || event.origin !== window.location.origin ||
      event.data?.context !== PANEL_CONTEXT) {
    return;
  }
  if (event.data.type === 'PANELIZE_MIMO_OPEN_TAB') {
    await openMiMoTab().catch(() => {
      updateConnection(false, 'Could not open MiMo. Try again.');
    });
    return;
  }
  if (!COMMANDS.has(event.data.type)) return;
  if (!connected || tabId === null) {
    reportUnavailable(event.data.requestId);
    return;
  }
  try {
    const result = await forwardToMiMo(event.data);
    if (result?.reason === 'not-authenticated') {
      updateConnection(false, 'Sign in in the MiMo tab, then return here.');
      reportUnavailable(event.data.requestId);
      return;
    }
    if (result?.reason === 'draft-conflict') {
      updateConnection(false, 'MiMo has an unsent draft. Handle it in the MiMo tab before connecting.');
      reportUnavailable(event.data.requestId, 'draft-conflict');
      return;
    }
    if (result?.accepted !== true) {
      reportUnavailable(event.data.requestId, result?.reason || 'injection-error');
      return;
    }
  } catch {
    updateConnection(false, 'Reconnect MiMo in its browser tab.');
    reportUnavailable(event.data.requestId);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'PANELIZE_MIMO_RELAY' || sender.tab?.id !== tabId ||
      sender.frameId !== 0 ||
      message.payload?.provider !== 'mimo') {
    return;
  }
  postToPanel(message.payload);
});

connectButton.addEventListener('click', () => {
  void openMiMoTab().catch(() => {
    updateConnection(false, 'Could not open MiMo. Try the panel link above.');
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.theme) void applyTheme();
});
void applyTheme();
void checkConnection();
setInterval(() => { void checkConnection(); }, 1500);
