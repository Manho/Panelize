import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDERS } from '../modules/providers.js';
import { getProviderFrameOrigins } from '../modules/provider-open-url.js';

const MULTI_PANEL_HTML = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);
const MULTI_PANEL_BODY_HTML = MULTI_PANEL_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const ALL_PROVIDER_IDS = PROVIDERS.map((p) => p.id);
const BUILT_IN_BATCH = ALL_PROVIDER_IDS.slice(0, 8); // 8 built-ins (includes chatgpt, claude, gemini, grok, google, ...)
const OPTIONAL_AND_ANCHOR_BATCH = [
  'qwen-cn',
  'qwen-global',
  'chatglm',
  'zai-global',
  'yuanbao',
  'aistudio',
];

const EXPECTED_INITIAL_FRAME_URLS = {
  chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai',
  gemini: 'https://gemini.google.com',
  grok: 'https://grok.com',
  deepseek: 'https://chat.deepseek.com',
  kimi: 'https://www.kimi.com',
  google: 'https://www.google.com/search?udm=50',
  doubao: 'https://www.doubao.com/chat/',
  'qwen-cn': 'https://www.qianwen.com/',
  'qwen-global': 'https://chat.qwen.ai/',
  chatglm: 'https://chatglm.cn/',
  'zai-global': 'https://chat.z.ai/',
  yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
  aistudio: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
};

const EXPECTED_TEMP_CHAT_SUPPORTED = {
  chatgpt: true,
  claude: true,
  gemini: true,
  grok: true,
  deepseek: false,
  kimi: false,
  google: false,
  doubao: false,
  'qwen-cn': false,
  'qwen-global': false,
  chatglm: false,
  'zai-global': false,
  yuanbao: true,
  aistudio: true,
};

const EXPECTED_TEMP_CHAT_RETRY = {
  chatgpt: false,
  claude: false,
  gemini: true,
  grok: true,
  deepseek: false,
  kimi: false,
  google: false,
  doubao: false,
  'qwen-cn': false,
  'qwen-global': false,
  chatglm: false,
  'zai-global': false,
  yuanbao: true,
  aistudio: false,
};

const EXPECTED_TEMP_CHAT_URLS = {
  chatgpt: 'https://chatgpt.com/?temporary-chat=true',
  claude: 'https://claude.ai/new?incognito',
  grok: 'https://grok.com/c#private',
  aistudio: 'https://aistudio.google.com/prompts/new_chat?temporary=true',
};

const EXPECTED_TEMP_CHAT_NORMAL_URLS = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/',
  grok: 'https://grok.com/',
  yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
  aistudio: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
};

const EXPECTED_SEND_FOCUS_TRACKED = {
  chatgpt: true,
  claude: false,
  gemini: false,
  grok: false,
  deepseek: false,
  kimi: false,
  google: false,
  doubao: false,
  'qwen-cn': false,
  'qwen-global': false,
  chatglm: false,
  'zai-global': false,
  yuanbao: false,
  aistudio: true,
};

const EXPECTED_TARGET_ORIGINS = {
  chatgpt: ['https://chatgpt.com', 'https://chat.openai.com'],
  claude: ['https://claude.ai'],
  gemini: ['https://gemini.google.com'],
  grok: ['https://grok.com'],
  deepseek: ['https://chat.deepseek.com'],
  kimi: ['https://www.kimi.com', 'https://kimi.com'],
  google: ['https://www.google.com', 'https://google.com'],
  doubao: ['https://www.doubao.com', 'https://doubao.com'],
  'qwen-cn': ['https://www.qianwen.com'],
  'qwen-global': ['https://chat.qwen.ai'],
  chatglm: ['https://chatglm.cn'],
  'zai-global': ['https://chat.z.ai'],
  yuanbao: ['https://yuanbao.tencent.com'],
  aistudio: ['https://aistudio.google.com'],
};

describe('characterization: multi-panel provider predicates, special cases, and postMessage target origins', () => {
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
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      })
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
    chrome.runtime.sendMessage.mockClear();
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
    expect(panelItems).toHaveLength(providerIds.length);

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
        getSrc: () => iframe.getAttribute('src'),
        clearCalls: () => fakeWindow.postMessage.mockClear(),
        calls: () => fakeWindow.postMessage.mock.calls,
      };
    });

    return { mod, handleByProvider };
  }

  describe('direct exports: isSendFocusTrackedProvider and sendToPanel', () => {
    it('pins isSendFocusTrackedProvider across all 14 providers plus unknown ids', async () => {
      const { mod } = await bootMultiPanel(['chatgpt']);
      const actual = Object.fromEntries(
        ALL_PROVIDER_IDS.map((id) => [id, mod.isSendFocusTrackedProvider(id)])
      );
      expect(actual).toEqual(EXPECTED_SEND_FOCUS_TRACKED);
      expect(mod.isSendFocusTrackedProvider('unknown')).toBe(false);
      expect(mod.isSendFocusTrackedProvider('gemini')).toBe(false);
      expect(mod.isSendFocusTrackedProvider(undefined)).toBe(false);
    });

    it('pins sendToPanel postMessage target origins and exact payload for all 14 providers', async () => {
      const { mod } = await bootMultiPanel(['google'], { googleProviderMode: 'ai' });

      for (const providerId of ALL_PROVIDER_IDS) {
        const postMessage = vi.fn();
        const panel = {
          id: `panel-${providerId}`,
          providerId,
          iframe: { contentWindow: { postMessage } },
        };

        const result = await mod.sendToPanel(
          panel,
          'Hello world',
          [],
          true,
          'req-1',
          false,
          8000,
          { isFillAction: false, waitForActionResult: false }
        );

        expect(result).toEqual({
          ok: true,
          panelId: `panel-${providerId}`,
          provider: providerId,
          succeededImageIds: [],
        });

        const expectedPayload = {
          type: 'INJECT_TEXT',
          text: 'Hello world',
          images: [],
          autoSubmit: true,
          requestId: 'req-1',
          action: undefined,
          retry: undefined,
          providerMode: providerId === 'google' ? 'ai' : null,
          context: 'multi-panel',
        };

        expect(postMessage.mock.calls).toEqual(
          EXPECTED_TARGET_ORIGINS[providerId].map((origin) => [expectedPayload, origin])
        );
      }

      // Unknown provider has no frame origins, so postMessage is never called.
      const unknownPost = vi.fn();
      const unknownRes = await mod.sendToPanel(
        { id: 'panel-unknown', providerId: 'unknown', iframe: { contentWindow: { postMessage: unknownPost } } },
        'Ignored',
        [],
        true,
        'req-unknown',
        false,
        8000,
        { isFillAction: false, waitForActionResult: false }
      );
      expect(unknownRes).toEqual({
        ok: true,
        panelId: 'panel-unknown',
        provider: 'unknown',
        succeededImageIds: [],
      });
      expect(unknownPost).not.toHaveBeenCalled();
    });
  });

  describe('initial frame URLs, Google mode special case, and host->frame postMessage origins', () => {
    it('loads exact initial iframe URLs and renders .panel-google-mode-select only for google across all 14 providers', async () => {
      const initialUrls = {};
      const hasGoogleSelect = {};

      for (const batch of [BUILT_IN_BATCH, OPTIONAL_AND_ANCHOR_BATCH]) {
        const { handleByProvider } = await bootMultiPanel(batch);
        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          initialUrls[providerId] = handle.getSrc();
          hasGoogleSelect[providerId] = Boolean(
            handle.panelEl.querySelector('.panel-google-mode-select')
          );
        }
      }

      expect(initialUrls).toEqual(EXPECTED_INITIAL_FRAME_URLS);
      expect(hasGoogleSelect).toEqual({
        chatgpt: false,
        claude: false,
        gemini: false,
        grok: false,
        deepseek: false,
        kimi: false,
        google: true,
        doubao: false,
        'qwen-cn': false,
        'qwen-global': false,
        chatglm: false,
        'zai-global': false,
        yuanbao: false,
        aistudio: false,
      });
    });

    it('reloads only the google panel and updates providerMode when switching Google mode between ai and search', async () => {
      const { handleByProvider } = await bootMultiPanel(['chatgpt', 'google', 'aistudio'], {
        googleProviderMode: 'ai',
      });

      expect(handleByProvider.google.getSrc()).toBe('https://www.google.com/search?udm=50');

      const select = handleByProvider.google.panelEl.querySelector('.panel-google-mode-select');
      select.value = 'search';
      select.dispatchEvent(new Event('change'));

      await vi.waitFor(() => {
        expect(handleByProvider.google.getSrc()).toBe('https://www.google.com/');
      });
      expect(handleByProvider.chatgpt.getSrc()).toBe('https://chatgpt.com');
      expect(handleByProvider.aistudio.getSrc()).toBe(
        'https://aistudio.google.com/prompts/new_chat?temporary=false'
      );

      // Clear All sends providerMode: 'search' to google and providerMode: null to non-google panels
      document.getElementById('clear-all-btn').click();

      expect(handleByProvider.google.calls()).toEqual([
        [
          {
            type: 'CLEAR_INPUT',
            clearImages: true,
            providerMode: 'search',
            context: 'multi-panel',
          },
          'https://www.google.com',
        ],
        [
          {
            type: 'CLEAR_INPUT',
            clearImages: true,
            providerMode: 'search',
            context: 'multi-panel',
          },
          'https://google.com',
        ],
      ]);

      expect(handleByProvider.chatgpt.calls()).toEqual([
        [
          {
            type: 'CLEAR_INPUT',
            clearImages: true,
            providerMode: null,
            context: 'multi-panel',
          },
          'https://chatgpt.com',
        ],
        [
          {
            type: 'CLEAR_INPUT',
            clearImages: true,
            providerMode: null,
            context: 'multi-panel',
          },
          'https://chat.openai.com',
        ],
      ]);
    });

    it('posts NEW_CHAT and TRIGGER_SEND to exact getProviderFrameOrigins for all 14 providers', async () => {
      for (const batch of [BUILT_IN_BATCH, OPTIONAL_AND_ANCHOR_BATCH]) {
        const { handleByProvider } = await bootMultiPanel(batch);

        // 1) Normal-mode New Chat
        document.getElementById('new-chat-btn').click();
        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          const expectedMsg = {
            type: 'NEW_CHAT',
            providerMode: providerId === 'google' ? 'ai' : null,
            context: 'multi-panel',
          };
          expect(handle.calls()).toEqual(
            getProviderFrameOrigins(providerId).map((origin) => [expectedMsg, origin])
          );
          handle.clearCalls();
        }

        // 2) Empty unified-input Send All -> TRIGGER_SEND
        document.getElementById('unified-input').value = '';
        document.getElementById('send-all-btn').click();
        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          const calls = handle.calls();
          expect(calls.map(([, origin]) => origin)).toEqual(getProviderFrameOrigins(providerId));
          for (const [payload] of calls) {
            expect(payload).toEqual({
              type: 'TRIGGER_SEND',
              requestId: expect.stringMatching(/^send-focus-/),
              providerMode: providerId === 'google' ? 'ai' : null,
              context: 'multi-panel',
            });
          }
        }
      }
    });
  });

  describe('Temporary Chat sets, URLs, retry providers, and Grok in-page new-chat special case', () => {
    it('pins TEMP_CHAT_SUPPORTED_PROVIDERS, TEMP_CHAT_URLS, TEMP_CHAT_RETRY_PROVIDERS, and TEMP_CHAT_NORMAL_URLS across all 14 providers', async () => {
      const observedEnableBehavior = {};
      const observedLoadRetry = {};
      const observedDisableBehavior = {};

      for (const batch of [BUILT_IN_BATCH, OPTIONAL_AND_ANCHOR_BATCH]) {
        vi.useRealTimers();
        const { handleByProvider } = await bootMultiPanel(batch);
        vi.useFakeTimers();

        // Step A: Click #temporary-chat-btn to ENABLE temporary chat mode
        document.getElementById('temporary-chat-btn').click();
        vi.advanceTimersByTime(4500);

        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          const msgTypes = handle.calls().map(([msg]) => msg.type);
          observedEnableBehavior[providerId] = {
            srcAfterEnable: handle.getSrc(),
            postedNewChat: msgTypes.includes('NEW_CHAT'),
            enableTempChatCount:
              msgTypes.filter((t) => t === 'ENABLE_TEMP_CHAT').length /
              EXPECTED_TARGET_ORIGINS[providerId].length,
          };
          handle.clearCalls();
        }

        // Advance past the 5000ms activation cleanup window so pending retries are cleared
        vi.advanceTimersByTime(1000);

        // Step B: Dispatch iframe 'load' while temporary chat mode is enabled -> pins TEMP_CHAT_RETRY_PROVIDERS
        for (const handle of Object.values(handleByProvider)) {
          handle.clearCalls();
          handle.iframe.dispatchEvent(new Event('load'));
        }
        vi.advanceTimersByTime(4500);

        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          const retryMsgCount =
            handle.calls().filter(([msg]) => msg.type === 'ENABLE_TEMP_CHAT').length /
            EXPECTED_TARGET_ORIGINS[providerId].length;
          observedLoadRetry[providerId] = retryMsgCount > 0;
          if (EXPECTED_TEMP_CHAT_RETRY[providerId]) {
            // Exact 3 retries at [1200, 2500, 4000]ms
            expect(retryMsgCount).toBe(3);
          } else {
            expect(retryMsgCount).toBe(0);
          }
          handle.clearCalls();
        }

        // Step C: Click #temporary-chat-btn again to DISABLE temporary chat mode -> pins TEMP_CHAT_SUPPORTED_PROVIDERS & TEMP_CHAT_NORMAL_URLS
        const tempBtn = document.getElementById('temporary-chat-btn');
        tempBtn.disabled = false;
        tempBtn.click();

        for (const [providerId, handle] of Object.entries(handleByProvider)) {
          const msgTypes = handle.calls().map(([msg]) => msg.type);
          observedDisableBehavior[providerId] = {
            srcAfterDisable: handle.getSrc(),
            postedNewChatOnDisable: msgTypes.includes('NEW_CHAT'),
          };
        }
      }

      // Verify exact enable behavior per provider
      for (const providerId of ALL_PROVIDER_IDS) {
        if (Object.prototype.hasOwnProperty.call(EXPECTED_TEMP_CHAT_URLS, providerId)) {
          expect(observedEnableBehavior[providerId]).toEqual({
            srcAfterEnable: EXPECTED_TEMP_CHAT_URLS[providerId],
            postedNewChat: false,
            enableTempChatCount: 0,
          });
        } else if (EXPECTED_TEMP_CHAT_RETRY[providerId]) {
          expect(observedEnableBehavior[providerId]).toEqual({
            srcAfterEnable: EXPECTED_INITIAL_FRAME_URLS[providerId],
            postedNewChat: true,
            enableTempChatCount: 3,
          });
        } else {
          expect(observedEnableBehavior[providerId]).toEqual({
            srcAfterEnable: EXPECTED_INITIAL_FRAME_URLS[providerId],
            postedNewChat: true,
            enableTempChatCount: 0,
          });
        }
      }

      // Verify exact retry set on iframe load
      expect(observedLoadRetry).toEqual(EXPECTED_TEMP_CHAT_RETRY);

      // Verify exact disable behavior (supported providers reload to TEMP_CHAT_NORMAL_URLS; unsupported post NEW_CHAT)
      const actualSupportedMap = Object.fromEntries(
        ALL_PROVIDER_IDS.map((id) => [id, !observedDisableBehavior[id].postedNewChatOnDisable])
      );
      expect(actualSupportedMap).toEqual(EXPECTED_TEMP_CHAT_SUPPORTED);

      for (const [providerId, expectedNormalUrl] of Object.entries(EXPECTED_TEMP_CHAT_NORMAL_URLS)) {
        expect(observedDisableBehavior[providerId]).toEqual({
          srcAfterDisable: expectedNormalUrl,
          postedNewChatOnDisable: false,
        });
      }
      for (const providerId of ALL_PROVIDER_IDS) {
        if (!EXPECTED_TEMP_CHAT_SUPPORTED[providerId]) {
          expect(observedDisableBehavior[providerId]).toEqual({
            srcAfterDisable: EXPECTED_INITIAL_FRAME_URLS[providerId],
            postedNewChatOnDisable: true,
          });
        }
      }
    });

    it('pins Grok preferInPageNewChat special case when clicking #new-chat-btn in temporary chat mode', async () => {
      const { handleByProvider } = await bootMultiPanel([
        'chatgpt',
        'claude',
        'grok',
        'aistudio',
        'gemini',
      ]);
      vi.useFakeTimers();

      // Enable temporary chat mode first
      document.getElementById('temporary-chat-btn').click();
      vi.advanceTimersByTime(5500);

      // Mutate iframe src attributes to sentinel values to observe which panels reload iframe vs post in-page NEW_CHAT
      for (const handle of Object.values(handleByProvider)) {
        handle.iframe.setAttribute('src', 'https://sentinel.example/current');
        handle.clearCalls();
      }

      // Click #new-chat-btn (calls startFreshChatForPanel with preferInPageNewChat: true)
      const newChatBtn = document.getElementById('new-chat-btn');
      newChatBtn.disabled = false;
      newChatBtn.click();
      vi.advanceTimersByTime(4500);

      // Grok does NOT reload iframe.src; it posts NEW_CHAT + 3 ENABLE_TEMP_CHAT retries!
      expect(handleByProvider.grok.getSrc()).toBe('https://sentinel.example/current');
      expect(handleByProvider.grok.calls()).toEqual([
        [{ type: 'NEW_CHAT', providerMode: null, context: 'multi-panel' }, 'https://grok.com'],
        [{ type: 'ENABLE_TEMP_CHAT', providerMode: null, context: 'multi-panel' }, 'https://grok.com'],
        [{ type: 'ENABLE_TEMP_CHAT', providerMode: null, context: 'multi-panel' }, 'https://grok.com'],
        [{ type: 'ENABLE_TEMP_CHAT', providerMode: null, context: 'multi-panel' }, 'https://grok.com'],
      ]);

      // Other URL-driven providers (chatgpt, claude, aistudio) reload their iframe to TEMP_CHAT_URLS without posting NEW_CHAT
      for (const urlDrivenId of ['chatgpt', 'claude', 'aistudio']) {
        expect(handleByProvider[urlDrivenId].getSrc()).toBe(EXPECTED_TEMP_CHAT_URLS[urlDrivenId]);
        expect(handleByProvider[urlDrivenId].calls()).toEqual([]);
      }

      // Non-URL retry provider (gemini) also posts NEW_CHAT + 3 ENABLE_TEMP_CHAT retries without reloading iframe
      expect(handleByProvider.gemini.getSrc()).toBe('https://sentinel.example/current');
      expect(handleByProvider.gemini.calls().map(([msg]) => msg.type)).toEqual([
        'NEW_CHAT',
        'ENABLE_TEMP_CHAT',
        'ENABLE_TEMP_CHAT',
        'ENABLE_TEMP_CHAT',
      ]);
    });
  });

  describe('Grok WebSocket cookie sync and frame->host status message handling', () => {
    it('requests syncGrokWebSocketCookies only when a grok panel is added or switched to', async () => {
      await bootMultiPanel(['chatgpt', 'claude']);
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({
        action: 'syncGrokWebSocketCookies',
      });

      await bootMultiPanel(['chatgpt', 'grok']);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        action: 'syncGrokWebSocketCookies',
      });
    });

    it('accepts PANELIZE_PROVIDER_LOCATION only from matching panel window+origin+provider and opens current conversation URL in new tab', async () => {
      const { handleByProvider } = await bootMultiPanel(['chatgpt', 'aistudio']);

      //Spoofed provider field is ignored
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_PROVIDER_LOCATION',
            context: 'multi-panel-provider-status',
            provider: 'aistudio',
            url: 'https://aistudio.google.com/prompts/1SavedPromptId',
          },
          source: handleByProvider.chatgpt.fakeWindow,
          origin: 'https://chatgpt.com',
        })
      );

      handleByProvider.aistudio.panelEl.querySelector('.open-provider-top-level-btn').click();
      expect(chrome.tabs.create).toHaveBeenLastCalledWith({
        url: 'https://aistudio.google.com/prompts/new_chat',
      });

      // Valid location report from aistudio frame updates currentUrl
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_PROVIDER_LOCATION',
            context: 'multi-panel-provider-status',
            provider: 'aistudio',
            url: 'https://aistudio.google.com/prompts/1SavedPromptId',
          },
          source: handleByProvider.aistudio.fakeWindow,
          origin: 'https://aistudio.google.com',
        })
      );

      handleByProvider.aistudio.panelEl.querySelector('.open-provider-top-level-btn').click();
      expect(chrome.tabs.create).toHaveBeenLastCalledWith({
        url: 'https://aistudio.google.com/prompts/1SavedPromptId',
      });
    });

    it('keeps send-focus tracking alive past 12s on PANELIZE_PROVIDER_BUSY only for chatgpt and aistudio, and posts PANELIZE_RESTORE_USER_FOCUS to exact origins', async () => {
      const { handleByProvider } = await bootMultiPanel(['chatgpt', 'claude', 'aistudio']);
      vi.useFakeTimers();

      // Trigger Send All on empty input -> sends TRIGGER_SEND with activeSendFocusRequestId
      const unifiedInput = document.getElementById('unified-input');
      unifiedInput.value = '';
      document.getElementById('send-all-btn').click();
      await Promise.resolve();

      const requestId = handleByProvider.chatgpt.calls()[0][0].requestId;
      expect(requestId).toMatch(/^send-focus-/);
      for (const handle of Object.values(handleByProvider)) {
        handle.clearCalls();
      }

      // Send PANELIZE_PROVIDER_BUSY from claude (untracked) and aistudio (tracked)
      for (const [providerId, origin] of [
        ['claude', 'https://claude.ai'],
        ['aistudio', 'https://aistudio.google.com'],
      ]) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              type: 'PANELIZE_PROVIDER_BUSY',
              context: 'multi-panel-provider-status',
              provider: providerId,
              requestId,
            },
            source: handleByProvider[providerId].fakeWindow,
            origin,
          })
        );
      }

      // Advance past the 12000ms SEND_FOCUS_RESTORE_DELAYS window:
      // Because aistudio is tracked and busy, activeSendFocusRequestId remains active!
      vi.advanceTimersByTime(15000);
      unifiedInput.focus();

      // User interaction in aistudio cancels send focus restore and posts PANELIZE_RESTORE_USER_FOCUS
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_PROVIDER_USER_INTERACTION',
            context: 'multi-panel-provider-status',
            provider: 'aistudio',
            requestId,
          },
          source: handleByProvider.aistudio.fakeWindow,
          origin: 'https://aistudio.google.com',
        })
      );

      expect(handleByProvider.aistudio.calls()).toEqual([
        [
          { type: 'PANELIZE_RESTORE_USER_FOCUS', context: 'multi-panel' },
          'https://aistudio.google.com',
        ],
      ]);

      // Repeat with ONLY claude sending PANELIZE_PROVIDER_BUSY -> untracked, so session expires at 12000ms
      document.getElementById('send-all-btn').click();
      await Promise.resolve();
      const claudeReqId = handleByProvider.claude.calls()[0][0].requestId;
      for (const handle of Object.values(handleByProvider)) {
        handle.clearCalls();
      }

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_PROVIDER_BUSY',
            context: 'multi-panel-provider-status',
            provider: 'claude',
            requestId: claudeReqId,
          },
          source: handleByProvider.claude.fakeWindow,
          origin: 'https://claude.ai',
        })
      );

      vi.advanceTimersByTime(15000);
      unifiedInput.focus();

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_PROVIDER_USER_INTERACTION',
            context: 'multi-panel-provider-status',
            provider: 'claude',
            requestId: claudeReqId,
          },
          source: handleByProvider.claude.fakeWindow,
          origin: 'https://claude.ai',
        })
      );

      expect(handleByProvider.claude.calls()).toEqual([]);
    });
  });
});
