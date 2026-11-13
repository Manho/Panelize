import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  CUSTOM_PROVIDER_ICON,
  CUSTOM_PROVIDER_ICON_DARK,
} from '../modules/custom-providers.js';
import {
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';
import {
  SNAPSHOT_MESSAGES,
  captureCurrentView,
  captureFullAnswers,
} from '../modules/snapshot-capture.js';

const LOCALES_DIR = resolve(process.cwd(), '_locales');
const EN_MESSAGES = JSON.parse(
  readFileSync(resolve(LOCALES_DIR, 'en/messages.json'), 'utf8')
);
const MULTI_PANEL_HTML = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);
const MULTI_PANEL_BODY_HTML = MULTI_PANEL_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const rect = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

function snapshotMessageEvent(data, source, origin = 'https://chatgpt.com') {
  const event = new Event('message');
  Object.defineProperty(event, 'data', { value: data });
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'origin', { value: origin });
  return event;
}

function installStatefulChromeStorage({
  syncInitial = {},
  localInitial = {},
  sessionInitial = {},
} = {}) {
  const areas = {
    sync: structuredClone(syncInitial),
    local: structuredClone(localInitial),
    session: structuredClone(sessionInitial),
  };
  const onChangedListeners = [];

  function makeArea(areaName) {
    const store = areas[areaName];
    return {
      get: vi.fn(async (keys) => {
        if (keys === null || keys === undefined) {
          return structuredClone(store);
        }
        if (typeof keys === 'string') {
          return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (key in store) out[key] = structuredClone(store[key]);
          }
          return out;
        }
        const out = { ...structuredClone(keys) };
        for (const key of Object.keys(keys)) {
          if (key in store) {
            out[key] = structuredClone(store[key]);
          }
        }
        return out;
      }),
      set: vi.fn(async (patch) => {
        const changes = {};
        for (const [key, newValue] of Object.entries(patch)) {
          const oldValue = key in store ? structuredClone(store[key]) : undefined;
          store[key] = structuredClone(newValue);
          changes[key] = { oldValue, newValue: structuredClone(newValue) };
        }
        for (const listener of [...onChangedListeners]) {
          listener(changes, areaName);
        }
      }),
      remove: vi.fn(async (keys) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const key of keyList) {
          delete store[key];
        }
      }),
      clear: vi.fn(async () => {
        for (const key of Object.keys(store)) {
          delete store[key];
        }
      }),
    };
  }

  chrome.storage = {
    sync: makeArea('sync'),
    local: makeArea('local'),
    session: makeArea('session'),
    onChanged: {
      addListener: vi.fn((fn) => {
        onChangedListeners.push(fn);
      }),
      removeListener: vi.fn((fn) => {
        const idx = onChangedListeners.indexOf(fn);
        if (idx >= 0) onChangedListeners.splice(idx, 1);
      }),
    },
  };

  return { areas, onChangedListeners };
}

describe('B2.3 provider capability gates (inPageNewChat, snapshotStitch, imageUpload)', () => {
  let cleanupListeners = [];

  beforeEach(() => {
    vi.clearAllMocks();
    cleanupListeners = [];
    setCustomProviderDescriptors([]);

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

    chrome.i18n = {
      getMessage: vi.fn((key) => key),
      getUILanguage: vi.fn(() => 'en'),
    };
    chrome.runtime.getManifest = vi.fn(() => ({ version: '2.1.0' }));
    chrome.management = {
      getSelf: vi.fn(() => Promise.resolve({ installType: 'normal' })),
    };
    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    };
    chrome.windows = {
      getCurrent: vi.fn(() => Promise.resolve({ type: 'normal' })),
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    };
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes('_locales/')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(structuredClone(EN_MESSAGES)),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });
  });

  afterEach(() => {
    for (const fn of cleanupListeners.splice(0)) {
      fn();
    }
    document.body.innerHTML = '';
    setCustomProviderDescriptors([]);
    resetExtraProviderDescriptors();
    vi.restoreAllMocks();
    delete globalThis.fetch;
    delete globalThis.createImageBitmap;
  });

  describe('all 10 locales include msgImagesSkippedForPanels', () => {
    const locales = readdirSync(LOCALES_DIR).sort();

    it('ships msgImagesSkippedForPanels with $1 substitution across all 10 locales', () => {
      expect(locales).toEqual([
        'de',
        'en',
        'es',
        'fr',
        'it',
        'ja',
        'ko',
        'ru',
        'zh_CN',
        'zh_TW',
      ]);

      for (const locale of locales) {
        const messages = JSON.parse(
          readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8')
        );
        const text = messages.msgImagesSkippedForPanels?.message;
        expect(typeof text, `${locale}.msgImagesSkippedForPanels`).toBe('string');
        expect(text.trim().length, `${locale}.msgImagesSkippedForPanels`).toBeGreaterThan(0);
        expect(text, `${locale}.msgImagesSkippedForPanels`).toContain('$1');
      }
    });
  });

  describe('snapshotStitch: false gate in modules/snapshot-capture.js', () => {
    function createMockCanvasContext() {
      return {
        fillStyle: '#ffffff',
        fillRect: vi.fn(),
        drawImage: vi.fn(),
        getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([255, 255, 255, 255]) })),
        save: vi.fn(),
        beginPath: vi.fn(),
        rect: vi.fn(),
        clip: vi.fn(),
        restore: vi.fn(),
      };
    }

    function createSnapshotPanel({
      name,
      left,
      origin,
      snapshotStitch,
      maxScrollTop = 900,
    }) {
      const element = document.createElement('div');
      element.getBoundingClientRect = () => rect(left, 0, 400, 600);
      document.body.appendChild(element);

      const receivedMessages = [];
      const contentWindow = {
        postMessage: vi.fn((message, targetOrigin) => {
          receivedMessages.push({ message, targetOrigin });
          if (
            message.type === SNAPSHOT_MESSAGES.PREPARE ||
            message.type === SNAPSHOT_MESSAGES.SCROLL ||
            message.type === SNAPSHOT_MESSAGES.RESTORE
          ) {
            queueMicrotask(() => {
              window.dispatchEvent(
                snapshotMessageEvent(
                  {
                    type: SNAPSHOT_MESSAGES.STATE,
                    context: 'multi-panel-snapshot',
                    requestId: message.requestId,
                    clip: { left: 0, top: 50, right: 400, bottom: 500 },
                    viewport: { width: 400, height: 560 },
                    alignedBy: 'prompt',
                    scrollTop: message.scrollTop ?? 0,
                    originalScrollTop: 0,
                    maxScrollTop,
                  },
                  contentWindow,
                  origin
                )
              );
            });
          }
        }),
      };

      const iframe = {
        contentWindow,
        getBoundingClientRect: () => rect(left, 40, 400, 560),
      };

      return {
        panel: {
          id: name,
          name,
          iframe,
          targetOrigins: [origin],
          element,
          snapshotStitch,
        },
        receivedMessages,
      };
    }

    it('skips both PREPARE and RESTORE in captureFullAnswers for snapshotStitch: false while keeping visible-view fallback and currentViewOnly notice', async () => {
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() =>
        createMockCanvasContext()
      );
      globalThis.createImageBitmap = vi.fn(async (_src, _sx, _sy, _sw, _sh, opts) => ({
        width: opts?.resizeWidth || 400,
        height: opts?.resizeHeight || 500,
        close: vi.fn(),
      }));

      const grid = document.createElement('div');
      grid.getBoundingClientRect = () => rect(0, 0, 800, 600);

      const builtin = createSnapshotPanel({
        name: 'ChatGPT',
        left: 0,
        origin: 'https://chatgpt.com',
        snapshotStitch: true,
        maxScrollTop: 700,
      });
      const custom = createSnapshotPanel({
        name: 'Local Open WebUI',
        left: 400,
        origin: 'http://127.0.0.1:3000',
        snapshotStitch: false,
      });

      const result = await captureFullAnswers({
        source: {
          grab: async () => ({
            width: window.innerWidth,
            height: window.innerHeight,
            close: vi.fn(),
          }),
        },
        grid,
        panels: [builtin.panel, custom.panel],
        prompt: 'Compare architectures',
        getChromeHeight: () => 120,
      });

      // Built-in panel received PREPARE, SCROLL, and RESTORE as usual
      const builtinTypes = builtin.receivedMessages.map((m) => m.message.type);
      expect(builtinTypes[0]).toBe(SNAPSHOT_MESSAGES.PREPARE);
      expect(builtinTypes).toContain(SNAPSHOT_MESSAGES.SCROLL);
      expect(builtinTypes.at(-1)).toBe(SNAPSHOT_MESSAGES.RESTORE);

      // Custom panel with snapshotStitch: false received ZERO messages (neither PREPARE nor RESTORE)
      expect(custom.receivedMessages).toEqual([]);

      // Visible-view crop fallback and currentViewOnly notice apply to the custom panel
      expect(result.names).toEqual(['ChatGPT', 'Local Open WebUI']);
      expect(result.currentViewOnly).toEqual(['Local Open WebUI']);
      expect(result.alignment).toContainEqual({
        name: 'Local Open WebUI',
        alignedBy: null,
        originalScrollTop: null,
        startScrollTop: null,
        endScrollTop: null,
        maxScrollTop: null,
      });
    });

    it('skips both PREPARE and RESTORE in captureCurrentView when capabilities.snapshotStitch is false', async () => {
      globalThis.createImageBitmap = vi.fn(async () => ({
        width: 800,
        height: 600,
        close: vi.fn(),
      }));

      const grid = document.createElement('div');
      grid.getBoundingClientRect = () => rect(0, 0, 800, 600);

      const builtin = createSnapshotPanel({
        name: 'ChatGPT',
        left: 0,
        origin: 'https://chatgpt.com',
        snapshotStitch: true,
      });
      const custom = createSnapshotPanel({
        name: 'Gradio Chat',
        left: 400,
        origin: 'http://127.0.0.1:7860',
        snapshotStitch: undefined,
      });
      custom.panel.capabilities = { snapshotStitch: false };

      const result = await captureCurrentView({
        source: {
          grab: async () => ({
            width: window.innerWidth,
            height: window.innerHeight,
            close: vi.fn(),
          }),
        },
        grid,
        panels: [builtin.panel, custom.panel],
        prompt: 'Short prompt',
      });

      expect(builtin.receivedMessages.map((m) => m.message.type)).toEqual([
        SNAPSHOT_MESSAGES.PREPARE,
        SNAPSHOT_MESSAGES.RESTORE,
      ]);
      expect(custom.receivedMessages).toEqual([]);
      expect(result.names).toEqual(['ChatGPT', 'Gradio Chat']);
    });
  });

  describe('inPageNewChat: false and imageUpload: false gates in multi-panel/multi-panel.js', () => {
    const CUSTOM_RECORD = {
      id: 'custom-1111111111',
      name: 'Local Open WebUI',
      url: 'http://127.0.0.1:3000/chat',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };

    async function bootMultiPanelWithBuiltinsAndCustom() {
      vi.resetModules();
      document.body.innerHTML = MULTI_PANEL_BODY_HTML;

      installStatefulChromeStorage({
        localInitial: {
          [CUSTOM_PROVIDERS_STORAGE_KEY]: [CUSTOM_RECORD],
        },
        syncInitial: {
          theme: 'light',
          language: 'en',
          multiPanelLayout: '1x3',
          enabledProviders: ['chatgpt', 'deepseek', CUSTOM_RECORD.id],
          providerOrder: ['chatgpt', 'deepseek', CUSTOM_RECORD.id],
          multiPanelProviders: ['chatgpt', 'deepseek', CUSTOM_RECORD.id],
        },
      });

      const mpMod = await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        const panelEls = document.querySelectorAll('#panel-grid .panel-item');
        expect(panelEls).toHaveLength(3);
      });

      const panelEls = Array.from(document.querySelectorAll('#panel-grid .panel-item'));
      return {
        mpMod,
        chatgptEl: panelEls[0],
        deepseekEl: panelEls[1],
        customEl: panelEls[2],
      };
    }

    it('reloads the iframe instead of posting NEW_CHAT for inPageNewChat: false across newChatAllProviders and temporaryChatAllProviders, while leaving built-ins unchanged', async () => {
      const { chatgptEl, deepseekEl, customEl } = await bootMultiPanelWithBuiltinsAndCustom();

      const chatgptIframe = chatgptEl.querySelector('iframe');
      const deepseekIframe = deepseekEl.querySelector('iframe');
      const customIframe = customEl.querySelector('iframe');

      const chatgptPost = vi.fn();
      const deepseekPost = vi.fn();
      const customPost = vi.fn();

      Object.defineProperty(chatgptIframe, 'contentWindow', {
        configurable: true,
        value: { postMessage: chatgptPost },
      });
      Object.defineProperty(deepseekIframe, 'contentWindow', {
        configurable: true,
        value: { postMessage: deepseekPost },
      });
      Object.defineProperty(customIframe, 'contentWindow', {
        configurable: true,
        value: { postMessage: customPost },
      });

      // Simulate user navigating custom iframe to a deeper conversation path
      customIframe.setAttribute('src', 'http://127.0.0.1:3000/chat/c/deep-thread');

      // 1. newChatAllProviders (#new-chat-btn)
      document.getElementById('new-chat-btn').click();

      expect(chatgptPost).toHaveBeenCalledWith(
        {
          type: 'NEW_CHAT',
          providerMode: null,
          context: 'multi-panel',
        },
        'https://chatgpt.com'
      );
      expect('providerId' in chatgptPost.mock.calls[0][0]).toBe(false);

      expect(deepseekPost).toHaveBeenCalledWith(
        {
          type: 'NEW_CHAT',
          providerMode: null,
          context: 'multi-panel',
        },
        'https://chat.deepseek.com'
      );
      expect('providerId' in deepseekPost.mock.calls[0][0]).toBe(false);

      // Custom panel never received NEW_CHAT; instead its iframe reloaded to its configured URL
      expect(customPost).not.toHaveBeenCalled();
      expect(customIframe.getAttribute('src')).toBe('http://127.0.0.1:3000/chat');

      // 2. temporaryChatAllProviders: enable temporary chat
      chatgptPost.mockClear();
      deepseekPost.mockClear();
      customPost.mockClear();
      customIframe.setAttribute('src', 'http://127.0.0.1:3000/chat/c/another-thread');

      const tempBtn = document.getElementById('temporary-chat-btn');
      tempBtn.click();

      // ChatGPT is URL-driven temporary chat -> reloads to temporary-chat URL
      expect(chatgptIframe.getAttribute('src')).toBe('https://chatgpt.com/?temporary-chat=true');
      // DeepSeek has tempChat: null and inPageNewChat: true -> posts NEW_CHAT
      expect(deepseekPost).toHaveBeenCalledWith(
        {
          type: 'NEW_CHAT',
          providerMode: null,
          context: 'multi-panel',
        },
        'https://chat.deepseek.com'
      );
      // Custom has tempChat: null and inPageNewChat: false -> reloads iframe, never posts NEW_CHAT
      expect(customPost).not.toHaveBeenCalled();
      expect(customIframe.getAttribute('src')).toBe('http://127.0.0.1:3000/chat');

      // 3. temporaryChatAllProviders: disable temporary chat
      deepseekPost.mockClear();
      customPost.mockClear();
      customIframe.setAttribute('src', 'http://127.0.0.1:3000/chat/c/while-temp');
      tempBtn.disabled = false;
      tempBtn.click();

      expect(chatgptIframe.getAttribute('src')).toBe('https://chatgpt.com/');
      expect(deepseekPost).toHaveBeenCalledWith(
        {
          type: 'NEW_CHAT',
          providerMode: null,
          context: 'multi-panel',
        },
        'https://chat.deepseek.com'
      );
      expect(customPost).not.toHaveBeenCalled();
      expect(customIframe.getAttribute('src')).toBe('http://127.0.0.1:3000/chat');
    });

    it('forwards images to custom web panels by default, and gracefully treats runtime reason: "unsupported" as image-skipped without blocking fill cleanup', async () => {
      const { mpMod, chatgptEl, deepseekEl, customEl } =
        await bootMultiPanelWithBuiltinsAndCustom();

      const chatgptIframe = chatgptEl.querySelector('iframe');
      const deepseekIframe = deepseekEl.querySelector('iframe');
      const customIframe = customEl.querySelector('iframe');

      const attachActionResponder = (
        iframe,
        { providerId, origin, failReason = null }
      ) => {
        const calls = [];
        const cw = {
          postMessage: vi.fn((message, targetOrigin) => {
            calls.push({ message: structuredClone(message), targetOrigin });
            if (targetOrigin !== origin) {
              return;
            }
            if (message.type === 'INJECT_TEXT_WITH_IMAGES' && message.action === 'fill') {
              queueMicrotask(() => {
                const ev = new MessageEvent('message', {
                  origin,
                  source: cw,
                  data: failReason
                    ? {
                        type: 'PANELIZE_ACTION_RESULT',
                        context: 'multi-panel-action-result',
                        requestId: message.requestId,
                        provider: providerId,
                        action: 'fill',
                        status: 'failed',
                        reason: failReason,
                        succeededImageIds: [],
                      }
                    : {
                        type: 'PANELIZE_ACTION_RESULT',
                        context: 'multi-panel-action-result',
                        requestId: message.requestId,
                        provider: providerId,
                        action: 'fill',
                        status: 'succeeded',
                        succeededImageIds: (message.images || []).map((img) => img.id),
                      },
                });
                window.dispatchEvent(ev);
              });
            }
          }),
        };
        Object.defineProperty(iframe, 'contentWindow', {
          configurable: true,
          value: cw,
        });
        return { cw, calls };
      };

      const chatgptFrame = attachActionResponder(chatgptIframe, {
        providerId: 'chatgpt',
        origin: 'https://chatgpt.com',
      });
      const deepseekFrame = attachActionResponder(deepseekIframe, {
        providerId: 'deepseek',
        origin: 'https://chat.deepseek.com',
      });
      const customFrame = attachActionResponder(customIframe, {
        providerId: CUSTOM_RECORD.id,
        origin: 'http://127.0.0.1:3000',
      });

      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const imageFile = new File([pngBytes], 'diagram.png', { type: 'image/png' });
      const fileInput = document.getElementById('image-file-input');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [imageFile],
      });
      fileInput.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.image-preview-item')).toHaveLength(1);
      });

      document.querySelectorAll('.panelize-toast').forEach((el) => el.remove());

      // 1. Image-capable custom web panel (e.g. Perplexity) receives full images payload and succeeds with zero skipped toast
      await mpMod.broadcastMessage('Explain this architecture diagram', false);

      expect(chatgptFrame.calls[0].message.images).toHaveLength(1);
      expect(deepseekFrame.calls[0].message.images).toHaveLength(1);
      expect(customFrame.calls).toHaveLength(1);
      expect(customFrame.calls[0].targetOrigin).toBe('http://127.0.0.1:3000');
      expect(customFrame.calls[0].message.type).toBe('INJECT_TEXT_WITH_IMAGES');
      expect(customFrame.calls[0].message.providerId).toBe(CUSTOM_RECORD.id);
      expect(customFrame.calls[0].message.images).toHaveLength(1);
      expect(customFrame.calls[0].message.images[0].name).toBe('diagram.png');

      const fillBtn = document.getElementById('fill-input-btn');
      expect(fillBtn.dataset.retryFailed).toBe('false');
      expect(document.getElementById('send-status').textContent).toBe('Filled 3 inputs');
      expect(document.querySelectorAll('.image-preview-item')).toHaveLength(0);
      expect(
        Array.from(document.querySelectorAll('.panelize-toast')).map((el) => el.textContent)
      ).not.toContain('Images were not sent to: Local Open WebUI');

      // 2. Text-only custom web site replying reason: 'unsupported' triggers localized skipped toast without entering failedFillPanelIds
      const textOnlyCustomFrame = attachActionResponder(customIframe, {
        providerId: CUSTOM_RECORD.id,
        origin: 'http://127.0.0.1:3000',
        failReason: 'unsupported',
      });
      chatgptFrame.calls.length = 0;
      deepseekFrame.calls.length = 0;

      const secondFile = new File([pngBytes], 'second.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [secondFile],
      });
      fileInput.dispatchEvent(new Event('change'));
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.image-preview-item')).toHaveLength(1);
      });
      document.querySelectorAll('.panelize-toast').forEach((el) => el.remove());

      await mpMod.broadcastMessage('Text fallback prompt', false);

      expect(textOnlyCustomFrame.calls[0].message.images).toHaveLength(1);
      expect(fillBtn.dataset.retryFailed).toBe('false');
      expect(document.getElementById('send-status').textContent).toBe('Filled 3 inputs');
      expect(document.querySelectorAll('.image-preview-item')).toHaveLength(0);
      expect(
        Array.from(document.querySelectorAll('.panelize-toast')).map((el) => el.textContent)
      ).toContain('Images were not sent to: Local Open WebUI');
    });

    it('sends ENABLE_TEMP_CHAT on custom web iframe load when temporary chat is enabled and DISABLE_TEMP_CHAT when disabled', async () => {
      const { customEl } = await bootMultiPanelWithBuiltinsAndCustom();
      const customIframe = customEl.querySelector('iframe');
      const sentTypes = [];

      const cw = {
        postMessage: vi.fn((message, targetOrigin) => {
          if (targetOrigin !== 'http://127.0.0.1:3000') return;
          sentTypes.push(message.type);
          if (message.type === 'PANELIZE_CUSTOM_FRAME_PING') {
            queueMicrotask(() => {
              window.dispatchEvent(
                new MessageEvent('message', {
                  origin: 'http://127.0.0.1:3000',
                  source: cw,
                  data: {
                    type: 'PANELIZE_CUSTOM_FRAME_PONG',
                    provider: CUSTOM_RECORD.id,
                    requestId: message.requestId,
                    context: 'multi-panel-provider-status',
                  },
                })
              );
            });
          } else if (message.type === 'ENABLE_TEMP_CHAT') {
            queueMicrotask(() => {
              window.dispatchEvent(
                new MessageEvent('message', {
                  origin: 'http://127.0.0.1:3000',
                  source: cw,
                  data: {
                    type: 'PANELIZE_TEMP_CHAT_ENABLED',
                    provider: CUSTOM_RECORD.id,
                    context: 'multi-panel-provider-status',
                  },
                })
              );
            });
          } else if (message.type === 'DISABLE_TEMP_CHAT') {
            queueMicrotask(() => {
              window.dispatchEvent(
                new MessageEvent('message', {
                  origin: 'http://127.0.0.1:3000',
                  source: cw,
                  data: {
                    type: 'PANELIZE_TEMP_CHAT_DISABLED',
                    provider: CUSTOM_RECORD.id,
                    context: 'multi-panel-provider-status',
                  },
                })
              );
            });
          }
        }),
      };
      Object.defineProperty(customIframe, 'contentWindow', {
        configurable: true,
        value: cw,
      });

      const tempBtn = document.getElementById('temporary-chat-btn');
      tempBtn.click();
      expect(customIframe.getAttribute('src')).toBe('http://127.0.0.1:3000/chat');

      // Simulate iframe load after reload -> triggers ping -> ENABLE_TEMP_CHAT
      customIframe.dispatchEvent(new Event('load'));
      await vi.waitFor(() => {
        expect(sentTypes).toContain('ENABLE_TEMP_CHAT');
      });

      // Now disable temporary chat -> reloads iframe -> on load sends DISABLE_TEMP_CHAT
      sentTypes.length = 0;
      tempBtn.disabled = false;
      tempBtn.click();
      customIframe.dispatchEvent(new Event('load'));
      await vi.waitFor(() => {
        expect(sentTypes).toContain('DISABLE_TEMP_CHAT');
      });
    });

    it('sends text-only INJECT_TEXT_WITH_IMAGES (images: []) to explicit imageUpload: false descriptors, shows localized toast, and never puts them in failedFillPanelIds because of images', async () => {
      vi.resetModules();
      document.body.innerHTML = MULTI_PANEL_BODY_HTML;

      installStatefulChromeStorage({
        localInitial: {},
        syncInitial: {
          theme: 'light',
          language: 'en',
          multiPanelLayout: '1x3',
          enabledProviders: ['chatgpt', 'deepseek', 'textonly-builtin'],
          providerOrder: ['chatgpt', 'deepseek', 'textonly-builtin'],
          multiPanelProviders: ['chatgpt', 'deepseek', 'textonly-builtin'],
        },
      });

      const regMod = await import('../modules/provider-registry.js');
      regMod.registerExtraProviderDescriptors([
        {
          id: 'textonly-builtin',
          name: 'TextOnly AI',
          url: 'http://127.0.0.1:3000/chat',
          topLevelUrl: 'http://127.0.0.1:3000/chat',
          icon: CUSTOM_PROVIDER_ICON,
          iconDark: CUSTOM_PROVIDER_ICON_DARK,
          enabled: true,
          access: 'builtin',
          frameOrigins: ['http://127.0.0.1:3000'],
          allowedHosts: ['127.0.0.1'],
          permissionOrigins: null,
          contentScript: null,
          frameRule: null,
          tempChat: null,
          capabilities: {
            imageUpload: false,
            inPageNewChat: false,
            snapshotStitch: false,
          },
        },
      ]);

      const mpMod = await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(3);
      });
      const [chatgptEl, deepseekEl, customEl] = Array.from(
        document.querySelectorAll('#panel-grid .panel-item')
      );

      const chatgptIframe = chatgptEl.querySelector('iframe');
      const deepseekIframe = deepseekEl.querySelector('iframe');
      const customIframe = customEl.querySelector('iframe');

      const attachActionResponder = (iframe, { providerId, origin, failUpload = false }) => {
        const calls = [];
        const cw = {
          postMessage: vi.fn((message, targetOrigin) => {
            calls.push({ message: structuredClone(message), targetOrigin });
            // Only reply once on the active origin
            if (targetOrigin !== origin) {
              return;
            }
            if (message.type === 'INJECT_TEXT_WITH_IMAGES' && message.action === 'fill') {
              queueMicrotask(() => {
                const ev = new MessageEvent('message', {
                  origin,
                  source: cw,
                  data: failUpload
                    ? {
                        type: 'PANELIZE_ACTION_RESULT',
                        context: 'multi-panel-action-result',
                        requestId: message.requestId,
                        provider: providerId,
                        action: 'fill',
                        status: 'failed',
                        reason: 'upload-failed',
                        succeededImageIds: [],
                      }
                    : {
                        type: 'PANELIZE_ACTION_RESULT',
                        context: 'multi-panel-action-result',
                        requestId: message.requestId,
                        provider: providerId,
                        action: 'fill',
                        status: 'succeeded',
                        succeededImageIds: (message.images || []).map((img) => img.id),
                      },
                });
                window.dispatchEvent(ev);
              });
            }
          }),
        };
        Object.defineProperty(iframe, 'contentWindow', {
          configurable: true,
          value: cw,
        });
        return { cw, calls };
      };

      const chatgptFrame = attachActionResponder(chatgptIframe, {
        providerId: 'chatgpt',
        origin: 'https://chatgpt.com',
      });
      const deepseekFrame = attachActionResponder(deepseekIframe, {
        providerId: 'deepseek',
        origin: 'https://chat.deepseek.com',
      });
      const customFrame = attachActionResponder(customIframe, {
        providerId: 'textonly-builtin',
        origin: 'http://127.0.0.1:3000',
      });

      // Attach an image via #image-file-input change event
      const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const imageFile = new File([pngBytes], 'diagram.png', { type: 'image/png' });
      const fileInput = document.getElementById('image-file-input');
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [imageFile],
      });
      fileInput.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(document.querySelectorAll('.image-preview-item')).toHaveLength(1);
      });

      // Clear any earlier toasts before broadcasting
      document.querySelectorAll('.panelize-toast').forEach((el) => el.remove());

      await mpMod.broadcastMessage('Explain this architecture diagram', false);

      // Built-in panels received full images payload with no providerId envelope leak
      expect(chatgptFrame.calls[0].message.type).toBe('INJECT_TEXT_WITH_IMAGES');
      expect(chatgptFrame.calls[0].message.action).toBe('fill');
      expect(chatgptFrame.calls[0].message.text).toBe('Explain this architecture diagram');
      expect(chatgptFrame.calls[0].message.images).toHaveLength(1);
      expect(chatgptFrame.calls[0].message.images[0].name).toBe('diagram.png');
      expect('providerId' in chatgptFrame.calls[0].message).toBe(false);

      expect(deepseekFrame.calls[0].message.images).toHaveLength(1);
      expect('providerId' in deepseekFrame.calls[0].message).toBe(false);

      // imageUpload: false panel received INJECT_TEXT_WITH_IMAGES with images: []
      expect(customFrame.calls).toHaveLength(1);
      expect(customFrame.calls[0]).toEqual({
        targetOrigin: 'http://127.0.0.1:3000',
        message: expect.objectContaining({
          type: 'INJECT_TEXT_WITH_IMAGES',
          context: 'multi-panel',
          action: 'fill',
          text: 'Explain this architecture diagram',
          images: [],
          autoSubmit: false,
        }),
      });

      // Waiter succeeded for all panels; imageUpload: false panel did NOT enter failedFillPanelIds
      const fillBtn = document.getElementById('fill-input-btn');
      expect(fillBtn.dataset.retryFailed).toBe('false');
      expect(document.getElementById('send-status').textContent).toBe('Filled 3 inputs');

      // One localized toast naming the skipped panel was displayed
      const toasts = Array.from(document.querySelectorAll('.panelize-toast')).map(
        (el) => el.textContent
      );
      expect(toasts).toContain('Images were not sent to: TextOnly AI');

      // Now verify partial failure + image-only empty-text broadcast:
      // Make DeepSeek fail image upload while ChatGPT succeeds and Custom skips images with empty text
      const deepseekFailingFrame = attachActionResponder(deepseekIframe, {
        providerId: 'deepseek',
        origin: 'https://chat.deepseek.com',
        failUpload: true,
      });
      chatgptFrame.calls.length = 0;
      customFrame.calls.length = 0;

      const secondFile = new File([pngBytes], 'second.png', { type: 'image/png' });
      Object.defineProperty(fileInput, 'files', {
        configurable: true,
        value: [secondFile],
      });
      fileInput.dispatchEvent(new Event('change'));
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.image-preview-item')).toHaveLength(1);
      });
      document.querySelectorAll('.panelize-toast').forEach((el) => el.remove());

      await mpMod.broadcastMessage('', false);

      // Custom panel was NOT posted empty text and did NOT enter failedFillPanelIds; only DeepSeek did!
      expect(customFrame.calls).toEqual([]);
      expect(deepseekFailingFrame.calls[0].message.images).toHaveLength(1);
      expect(fillBtn.dataset.retryFailed).toBe('true');

      // Retrying targets ONLY the failed built-in panel (DeepSeek), not ChatGPT and not Custom!
      chatgptFrame.calls.length = 0;
      deepseekFailingFrame.calls.length = 0;
      customFrame.calls.length = 0;

      await mpMod.broadcastMessage('', false);
      expect(deepseekFailingFrame.calls.length).toBeGreaterThan(0);
      expect(chatgptFrame.calls).toEqual([]);
      expect(customFrame.calls).toEqual([]);
    });
  });
});
