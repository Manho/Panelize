import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GEMINI_ACCOUNT_INDEX,
  extractGoogleAccountIndexFromUrl,
  getGeminiAccountOptionLabel,
  getGeminiProviderUrl,
  getGeminiTemporaryChatNormalUrl,
  getGeminiTopLevelFallbackUrl,
  normalizeGeminiAccountIndex,
  stripGoogleAccountPathPrefix,
  toGeminiAccountSelectValue,
} from '../modules/gemini-account.js';

const MULTI_PANEL_HTML = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);
const MULTI_PANEL_BODY_HTML = MULTI_PANEL_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const SAMPLE_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=';

describe('Gemini multi-account helpers', () => {
  it('normalizes account indices and falls back to default null for unset or out-of-range values', () => {
    expect(normalizeGeminiAccountIndex(null)).toBe(DEFAULT_GEMINI_ACCOUNT_INDEX);
    expect(normalizeGeminiAccountIndex(undefined)).toBe(null);
    expect(normalizeGeminiAccountIndex('')).toBe(null);
    expect(normalizeGeminiAccountIndex('default')).toBe(null);
    expect(normalizeGeminiAccountIndex(0)).toBe(0);
    expect(normalizeGeminiAccountIndex('1')).toBe(1);
    expect(normalizeGeminiAccountIndex(' 4 ')).toBe(4);
    expect(normalizeGeminiAccountIndex(-1)).toBe(null);
    expect(normalizeGeminiAccountIndex(12)).toBe(null);
    expect(normalizeGeminiAccountIndex('u1')).toBe(null);
  });

  it('extracts and strips /u/<n> path prefixes cleanly', () => {
    expect(extractGoogleAccountIndexFromUrl('https://gemini.google.com/u/1/app?pageId=none')).toBe(1);
    expect(extractGoogleAccountIndexFromUrl('https://aistudio.google.com/u/2/prompts/abc123')).toBe(2);
    expect(extractGoogleAccountIndexFromUrl('https://gemini.google.com/app')).toBe(null);
    expect(extractGoogleAccountIndexFromUrl('javascript:alert(1)')).toBe(null);

    expect(stripGoogleAccountPathPrefix('/u/1/app/abc123')).toBe('/app/abc123');
    expect(stripGoogleAccountPathPrefix('/u/0')).toBe('/');
    expect(stripGoogleAccountPathPrefix('/app')).toBe('/app');
  });

  it('formats Gemini URLs and option labels for default and explicit accounts', () => {
    expect(getGeminiProviderUrl(null)).toBe('https://gemini.google.com');
    expect(getGeminiProviderUrl(1)).toBe('https://gemini.google.com/u/1/app');
    expect(getGeminiTemporaryChatNormalUrl(null)).toBe('https://gemini.google.com/');
    expect(getGeminiTemporaryChatNormalUrl(1)).toBe('https://gemini.google.com/u/1/app');
    expect(getGeminiTopLevelFallbackUrl(null)).toBe('https://gemini.google.com/app');
    expect(getGeminiTopLevelFallbackUrl(1)).toBe('https://gemini.google.com/u/1/app');
    expect(toGeminiAccountSelectValue(null)).toBe('');
    expect(toGeminiAccountSelectValue(1)).toBe('1');
    expect(getGeminiAccountOptionLabel(null)).toBe('Default');
    expect(getGeminiAccountOptionLabel(1)).toBe('/u/1');
  });
});

describe('multi-panel Gemini account selector & Send All cleared-panel retry', () => {
  let cleanupListeners = [];

  beforeEach(() => {
    vi.clearAllMocks();
    cleanupListeners = [];

    if (window.happyDOM?.settings?.navigation) {
      window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
    }

    const origWinAdd = window.addEventListener.bind(window);
    const origWinRemove = window.removeEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    const origDocRemove = document.removeEventListener.bind(document);

    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origWinRemove(type, listener, options));
      return origWinAdd(type, listener, options);
    });
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origDocRemove(type, listener, options));
      return origDocAdd(type, listener, options);
    });

    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.windows = {
      getCurrent: vi.fn(() => Promise.resolve({ type: 'normal' })),
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    };
    chrome.tabs = {
      create: vi.fn(() => Promise.resolve({ id: 99 })),
    };
    chrome.storage.session = {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.local.get.mockImplementation((keys) =>
      Promise.resolve(
        typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? { ...keys } : {}
      )
    );
    chrome.storage.local.set.mockResolvedValue();
    chrome.storage.local.remove.mockResolvedValue();
    chrome.storage.sync.set.mockResolvedValue();
    chrome.runtime.sendMessage.mockImplementation((_msg, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    });
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );
  });

  afterEach(() => {
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.fetch;
    document.body.innerHTML = '';
  });

  async function bootMultiPanel(providerIds, extraSyncSettings = {}) {
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }
    vi.resetModules();
    chrome.storage.session.get.mockClear();
    document.body.innerHTML = MULTI_PANEL_BODY_HTML;

    const layout = `1x${Math.max(1, Math.min(providerIds.length, 12))}`;
    chrome.storage.sync.get.mockImplementation((defaults) => {
      const base =
        typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? { ...defaults }
          : {};
      return Promise.resolve({
        ...base,
        theme: 'light',
        language: 'en',
        multiPanelLayout: layout,
        enabledProviders: [...providerIds],
        providerOrder: [...providerIds],
        multiPanelProviders: [...providerIds],
        ...extraSyncSettings,
      });
    });

    const mod = await import('../multi-panel/multi-panel.js');
    await vi.waitFor(() => {
      const calls = chrome.storage.session.get.mock.calls.map(([arg]) => arg);
      expect(calls).toContain('pendingMultiPanelAction');
    });

    const panelItems = Array.from(document.querySelectorAll('#panel-grid .panel-item'));
    const handleByProvider = {};
    panelItems.forEach((panelEl, index) => {
      const providerId = providerIds[index];
      const iframe = panelEl.querySelector('iframe');
      const fakeWindow = {
        marker: providerId,
        postMessage: vi.fn(),
      };
      Object.defineProperty(iframe, 'contentWindow', {
        configurable: true,
        value: fakeWindow,
      });
      iframe.focus = vi.fn();
      handleByProvider[providerId] = {
        providerId,
        panelId: panelEl.id,
        panelEl,
        iframe,
        fakeWindow,
      };
    });

    return { mod, handleByProvider };
  }

  it('switches Gemini panel to /u/1/app, persists geminiAccountIndex, and syncs on in-frame /u/<n> navigation', async () => {
    const { handleByProvider } = await bootMultiPanel(['gemini', 'chatgpt']);
    const geminiHandle = handleByProvider.gemini;
    const chatgptHandle = handleByProvider.chatgpt;

    const accountSelect = geminiHandle.panelEl.querySelector('.panel-gemini-account-select');
    expect(accountSelect).not.toBeNull();
    expect(chatgptHandle.panelEl.querySelector('.panel-gemini-account-select')).toBeNull();
    expect(accountSelect.value).toBe('');
    expect(geminiHandle.iframe.getAttribute('src')).toBe('https://gemini.google.com');

    accountSelect.value = '1';
    accountSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(chrome.storage.sync.set).toHaveBeenCalledWith({ geminiAccountIndex: 1 });
    });
    expect(geminiHandle.iframe.getAttribute('src')).toBe('https://gemini.google.com/u/1/app');

    // Simulate user switching to /u/2 inside the Gemini iframe
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'PANELIZE_PROVIDER_LOCATION',
          context: 'multi-panel-provider-status',
          provider: 'gemini',
          url: 'https://gemini.google.com/u/2/app?pageId=none',
        },
        source: geminiHandle.fakeWindow,
        origin: 'https://gemini.google.com',
      })
    );

    await vi.waitFor(() => {
      expect(accountSelect.value).toBe('2');
    });
    expect(chrome.storage.sync.set).toHaveBeenCalledWith({ geminiAccountIndex: 2 });

    // Open in new tab falls back to /u/2/app when on landing page
    geminiHandle.panelEl.querySelector('.open-provider-top-level-btn').click();
    await vi.waitFor(() => {
      expect(chrome.tabs.create).toHaveBeenCalledWith({
        url: 'https://gemini.google.com/u/2/app',
      });
    });
  });

  it('re-targets all panels on Send All after a partial image fill failure while Retry Failed targets only failed panels', async () => {
    const { mod, handleByProvider } = await bootMultiPanel(['deepseek', 'kimi']);
    const deepseek = handleByProvider.deepseek;
    const kimi = handleByProvider.kimi;

    // Auto-reply to fill action messages from each fake panel window
    let kimiShouldSucceed = false;
    deepseek.fakeWindow.postMessage.mockImplementation((msg) => {
      if (msg?.type === 'INJECT_TEXT_WITH_IMAGES') {
        queueMicrotask(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'PANELIZE_ACTION_RESULT',
                context: 'multi-panel-action-result',
                requestId: msg.requestId,
                provider: 'deepseek',
                action: 'fill',
                status: 'succeeded',
                succeededImageIds: (msg.fallbackImages || msg.images).map((i) => i.id),
              },
              source: deepseek.fakeWindow,
              origin: 'https://chat.deepseek.com',
            })
          );
        });
      }
    });
    kimi.fakeWindow.postMessage.mockImplementation((msg) => {
      if (msg?.type === 'INJECT_TEXT_WITH_IMAGES') {
        // Kimi has two origins (`www.kimi.com` and `kimi.com`); respond once per requestId
        if (kimi.fakeWindow._lastAckedRequestId === msg.requestId) return;
        kimi.fakeWindow._lastAckedRequestId = msg.requestId;
        queueMicrotask(() => {
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'PANELIZE_ACTION_RESULT',
                context: 'multi-panel-action-result',
                requestId: msg.requestId,
                provider: 'kimi',
                action: 'fill',
                status: kimiShouldSucceed ? 'succeeded' : 'failed',
                ...(kimiShouldSucceed ? {} : { reason: 'preview-timeout' }),
                succeededImageIds: kimiShouldSucceed
                  ? (msg.fallbackImages || msg.images).map((i) => i.id)
                  : [],
              },
              source: kimi.fakeWindow,
              origin: 'https://www.kimi.com',
            })
          );
        });
      }
    });

    // Attach an image via FileReader
    const fileInput = document.getElementById('image-file-input');
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'chart.png', { type: 'image/png' });
    const origFileReader = globalThis.FileReader;
    globalThis.FileReader = class MockFileReader {
      readAsDataURL() {
        this.result = SAMPLE_PNG_DATA_URL;
        if (this.onload) this.onload({ target: { result: SAMPLE_PNG_DATA_URL } });
      }
    };
    try {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      globalThis.FileReader = origFileReader;
    }

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.image-preview-item')).toHaveLength(1);
    });

    // Pass 1: Send All -> DeepSeek succeeds, Kimi fails
    await mod.broadcastMessage('Analyze this chart', true);
    expect(document.getElementById('send-status').textContent).toBe('Filled 1/2; 1 failed');

    deepseek.fakeWindow.postMessage.mockClear();
    kimi.fakeWindow.postMessage.mockClear();

    // Pass 2: Retry Failed (autoSubmit = false) -> ONLY targets Kimi, NOT DeepSeek
    await mod.broadcastMessage('Analyze this chart', false);
    expect(deepseek.fakeWindow.postMessage).not.toHaveBeenCalled();
    expect(kimi.fakeWindow.postMessage).toHaveBeenCalled();

    deepseek.fakeWindow.postMessage.mockClear();
    kimi.fakeWindow.postMessage.mockClear();

    // Pass 3: User deleted DeepSeek's prompt and clicks Send All (autoSubmit = true) again!
    // Must reach DeepSeek too with fallbackImages so cleared DeepSeek is re-populated.
    kimiShouldSucceed = true;
    await mod.broadcastMessage('Analyze this chart', true);
    expect(deepseek.fakeWindow.postMessage).toHaveBeenCalledTimes(1);
    const deepseekPayload = deepseek.fakeWindow.postMessage.mock.calls[0][0];
    expect(deepseekPayload).toMatchObject({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: 'Analyze this chart',
      images: [],
      retry: true,
    });
    expect(deepseekPayload.fallbackImages).toHaveLength(1);
    expect(document.getElementById('send-status').textContent).toBe('Filled 2 inputs');
  });

  it('keeps per-panel Gemini accounts independent so changing one Gemini panel does not reload another', async () => {
    await bootMultiPanel(['gemini', 'gemini']);
    const panelEls = Array.from(document.querySelectorAll('#panel-grid .panel-item'));
    expect(panelEls).toHaveLength(2);

    const [firstPanelEl, secondPanelEl] = panelEls;
    const firstIframe = firstPanelEl.querySelector('iframe');
    const secondIframe = secondPanelEl.querySelector('iframe');
    const firstSelect = firstPanelEl.querySelector('.panel-gemini-account-select');
    const secondSelect = secondPanelEl.querySelector('.panel-gemini-account-select');

    // Select /u/0 in the first Gemini panel
    firstSelect.value = '0';
    firstSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(firstIframe.getAttribute('src')).toBe('https://gemini.google.com/u/0/app');
    });
    expect(secondIframe.getAttribute('src')).toBe('https://gemini.google.com');
    expect(secondSelect.value).toBe('');

    // Simulate active conversation on first Gemini panel, then switch second Gemini panel to /u/1
    firstIframe.setAttribute('src', 'https://gemini.google.com/u/0/app/live-conv-1');
    secondSelect.value = '1';
    secondSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(secondIframe.getAttribute('src')).toBe('https://gemini.google.com/u/1/app');
    });
    // First Gemini panel must NOT be reloaded or have its account selector overwritten
    expect(firstIframe.getAttribute('src')).toBe('https://gemini.google.com/u/0/app/live-conv-1');
    expect(firstSelect.value).toBe('0');
    expect(secondSelect.value).toBe('1');
  });

  it('preserves missing image IDs via attemptedImageIds when a cleared-composer fallback retry partially fails', async () => {
    const { mod, handleByProvider } = await bootMultiPanel(['deepseek']);
    const deepseek = handleByProvider.deepseek;

    // Attach 3 images A, B, C
    const fileInput = document.getElementById('image-file-input');
    const files = ['a.png', 'b.png', 'c.png'].map(
      (name) => new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' })
    );
    const origFileReader = globalThis.FileReader;
    globalThis.FileReader = class MockFileReader {
      readAsDataURL() {
        this.result = SAMPLE_PNG_DATA_URL;
        if (this.onload) this.onload({ target: { result: SAMPLE_PNG_DATA_URL } });
      }
    };
    try {
      Object.defineProperty(fileInput, 'files', { configurable: true, value: files });
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    } finally {
      globalThis.FileReader = origFileReader;
    }

    await vi.waitFor(() => {
      expect(document.querySelectorAll('.image-preview-item')).toHaveLength(3);
    });

    let pass = 0;
    deepseek.fakeWindow.postMessage.mockImplementation((msg) => {
      if (msg?.type !== 'INJECT_TEXT_WITH_IMAGES') return;
      pass += 1;
      const allIds = (msg.fallbackImages || msg.images).map((img) => img.id);
      queueMicrotask(() => {
        if (pass === 1) {
          // Pass 1: A and B succeed, C fails -> pending=[C]
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'PANELIZE_ACTION_RESULT',
                context: 'multi-panel-action-result',
                requestId: msg.requestId,
                provider: 'deepseek',
                action: 'fill',
                status: 'failed',
                reason: 'preview-timeout',
                succeededImageIds: [allIds[0], allIds[1]],
              },
              source: deepseek.fakeWindow,
              origin: 'https://chat.deepseek.com',
            })
          );
        } else if (pass === 2) {
          // Pass 2: composer was cleared, frame attempted all [A, B, C]; A succeeded, B failed!
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'PANELIZE_ACTION_RESULT',
                context: 'multi-panel-action-result',
                requestId: msg.requestId,
                provider: 'deepseek',
                action: 'fill',
                status: 'failed',
                reason: 'preview-timeout',
                succeededImageIds: [allIds[0]],
                attemptedImageIds: allIds,
              },
              source: deepseek.fakeWindow,
              origin: 'https://chat.deepseek.com',
            })
          );
        } else {
          // Pass 3: must receive BOTH B and C in msg.images!
          window.dispatchEvent(
            new MessageEvent('message', {
              data: {
                type: 'PANELIZE_ACTION_RESULT',
                context: 'multi-panel-action-result',
                requestId: msg.requestId,
                provider: 'deepseek',
                action: 'fill',
                status: 'succeeded',
                succeededImageIds: msg.images.map((img) => img.id),
              },
              source: deepseek.fakeWindow,
              origin: 'https://chat.deepseek.com',
            })
          );
        }
      });
    });

    // Pass 1
    await mod.broadcastMessage('Three images', true);
    const allThreeIds = deepseek.fakeWindow.postMessage.mock.calls[0][0].images.map((i) => i.id);

    // Pass 2 (user cleared composer, clicks Send All; A succeeds, B fails)
    await mod.broadcastMessage('Three images', true);

    // Pass 3 (Retry Failed): must retry BOTH B and C, never dropping B
    deepseek.fakeWindow.postMessage.mockClear();
    await mod.broadcastMessage('Three images', false);
    const pass3Payload = deepseek.fakeWindow.postMessage.mock.calls[0][0];
    expect(pass3Payload.images.map((i) => i.id)).toEqual([allThreeIds[1], allThreeIds[2]]);
  });
});
