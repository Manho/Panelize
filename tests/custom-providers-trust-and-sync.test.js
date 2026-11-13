import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasProviderDescriptor,
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import { getProviderById } from '../modules/providers.js';
import {
  LEGACY_DEFAULT_PROVIDER_IDS,
  migrateEnabledProvidersOnUpdate,
} from '../modules/provider-defaults.js';
import { preserveForeignCustomIds } from '../modules/provider-order.js';
import {
  findMessageSourcePanel,
  getProviderFallbackUrl,
  getProviderFrameOrigins,
  getProviderOpenUrl,
  isProviderAllowedUrl,
  isProviderCurrentUrl,
  isProviderFrameOrigin,
} from '../modules/provider-open-url.js';
import { reconcileOptionalProviderAccess } from '../modules/optional-provider-access.js';

const MULTI_PANEL_HTML = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);
const MULTI_PANEL_BODY_HTML = MULTI_PANEL_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const OPTIONS_HTML = readFileSync(
  resolve(process.cwd(), 'options/options.html'),
  'utf8'
);
const OPTIONS_BODY_HTML = OPTIONS_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

function makeCustomRecord(overrides = {}) {
  return {
    id: 'custom-0123456789',
    name: 'Local Open WebUI',
    url: 'http://localhost:3000/',
    frameRuleId: 10000,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function installStatefulChromeStorage({ syncInitial = {}, localInitial = {}, sessionInitial = {} } = {}) {
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
        const changes = {};
        for (const key of keyList) {
          if (key in store) {
            const oldValue = structuredClone(store[key]);
            delete store[key];
            changes[key] = { oldValue };
          }
        }
        if (Object.keys(changes).length > 0) {
          for (const listener of [...onChangedListeners]) {
            listener(changes, areaName);
          }
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

describe('custom providers: exact-origin trust, envelope, foreign-id preservation, and entry-point hydration', () => {
  let cleanupListeners = [];

  beforeEach(() => {
    vi.clearAllMocks();
    cleanupListeners = [];
    setCustomProviderDescriptors([]);
    resetExtraProviderDescriptors();

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
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ prompts: [] }),
      })
    );
  });

  afterEach(() => {
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }
    setCustomProviderDescriptors([]);
    resetExtraProviderDescriptors();
    vi.restoreAllMocks();
    delete globalThis.fetch;
    document.body.innerHTML = '';
  });

  describe('exact-origin trust across modules/provider-open-url.js', () => {
    it('enforces exact (scheme, host, port) origin trust and rejects other port, other scheme, subdomain, and host.evil.com', () => {
      const localRecord = makeCustomRecord({
        id: 'custom-0123456789',
        url: 'http://localhost:3000/workspace',
        frameRuleId: 10000,
      });
      const httpsRecord = makeCustomRecord({
        id: 'custom-abcdef0123',
        name: 'Hosted Chat',
        url: 'https://chat.example.com:8443/app',
        frameRuleId: 10001,
      });
      setCustomProviderDescriptors([
        toCustomProviderDescriptor(localRecord),
        toCustomProviderDescriptor(httpsRecord),
      ]);

      const localProvider = getProviderById('custom-0123456789');
      const httpsProvider = getProviderById('custom-abcdef0123');

      // Fallback URLs allow http: for custom and preserve exact configured URLs
      expect(getProviderFallbackUrl(localProvider)).toBe('http://localhost:3000/workspace');
      expect(getProviderFallbackUrl(httpsProvider)).toBe('https://chat.example.com:8443/app');
      expect(getProviderFrameOrigins('custom-0123456789')).toEqual(['http://localhost:3000']);
      expect(getProviderFrameOrigins('custom-abcdef0123')).toEqual(['https://chat.example.com:8443']);

      // Positive exact-origin URLs (including deep conversation routes)
      for (const goodLocalUrl of [
        'http://localhost:3000/',
        'http://localhost:3000/c/conv-42?tab=1#bottom',
      ]) {
        expect(isProviderAllowedUrl('custom-0123456789', goodLocalUrl), goodLocalUrl).toBe(true);
        expect(isProviderCurrentUrl('custom-0123456789', goodLocalUrl), goodLocalUrl).toBe(true);
        expect(getProviderOpenUrl(localProvider, goodLocalUrl)).toBe(new URL(goodLocalUrl).toString());
      }

      for (const goodHttpsUrl of [
        'https://chat.example.com:8443/',
        'https://chat.example.com:8443/c/session-99?lang=en',
      ]) {
        expect(isProviderAllowedUrl('custom-abcdef0123', goodHttpsUrl), goodHttpsUrl).toBe(true);
        expect(isProviderCurrentUrl('custom-abcdef0123', goodHttpsUrl), goodHttpsUrl).toBe(true);
        expect(getProviderOpenUrl(httpsProvider, goodHttpsUrl)).toBe(new URL(goodHttpsUrl).toString());
      }

      // Negatives for http://localhost:3000: other port, default port, other scheme, subdomain, host.evil.com, credentials
      for (const badLocalUrl of [
        'http://localhost:3001/c/conv-42',
        'http://localhost/c/conv-42',
        'https://localhost:3000/c/conv-42',
        'http://sub.localhost:3000/c/conv-42',
        'http://localhost.evil.com:3000/c/conv-42',
        'http://127.0.0.1:3000/c/conv-42',
        'http://admin:pass@localhost:3000/c/conv-42',
        'javascript:alert(1)',
      ]) {
        expect(isProviderAllowedUrl('custom-0123456789', badLocalUrl), badLocalUrl).toBe(false);
        expect(isProviderCurrentUrl('custom-0123456789', badLocalUrl), badLocalUrl).toBe(false);
        expect(getProviderOpenUrl(localProvider, badLocalUrl), badLocalUrl).toBe(
          'http://localhost:3000/workspace'
        );
      }

      // Negatives for https://chat.example.com:8443: other port, default 443 port, other scheme, subdomain, host.evil.com
      for (const badHttpsUrl of [
        'https://chat.example.com:9443/c/session-99',
        'https://chat.example.com/c/session-99',
        'http://chat.example.com:8443/c/session-99',
        'https://sub.chat.example.com:8443/c/session-99',
        'https://chat.example.com.evil.com:8443/c/session-99',
        'https://chat.example.com.evil.com/c/session-99',
      ]) {
        expect(isProviderAllowedUrl('custom-abcdef0123', badHttpsUrl), badHttpsUrl).toBe(false);
        expect(isProviderCurrentUrl('custom-abcdef0123', badHttpsUrl), badHttpsUrl).toBe(false);
        expect(getProviderOpenUrl(httpsProvider, badHttpsUrl), badHttpsUrl).toBe(
          'https://chat.example.com:8443/app'
        );
      }

      // Frame origin and message source trust reject other port, scheme, subdomain, and host.evil.com
      const frameWindow = {};
      const panels = [
        { id: 'panel-1', providerId: 'custom-abcdef0123', iframe: { contentWindow: frameWindow } },
      ];
      expect(isProviderFrameOrigin('custom-abcdef0123', 'https://chat.example.com:8443')).toBe(true);
      expect(
        findMessageSourcePanel(panels, {
          source: frameWindow,
          origin: 'https://chat.example.com:8443',
        })
      ).toBe(panels[0]);

      for (const badOrigin of [
        'https://chat.example.com:9443',
        'https://chat.example.com',
        'http://chat.example.com:8443',
        'https://sub.chat.example.com:8443',
        'https://chat.example.com.evil.com:8443',
        'https://chat.example.com.evil.com',
      ]) {
        expect(isProviderFrameOrigin('custom-abcdef0123', badOrigin), badOrigin).toBe(false);
        expect(
          findMessageSourcePanel(panels, { source: frameWindow, origin: badOrigin }),
          badOrigin
        ).toBeNull();
      }

      // Built-in provider behaviour stays completely unchanged
      expect(isProviderAllowedUrl('chatgpt', 'https://chatgpt.com:8443/c/123')).toBe(true);
      expect(isProviderCurrentUrl('chatgpt', 'https://chatgpt.com/')).toBe(false);
      expect(isProviderCurrentUrl('chatgpt', 'https://chatgpt.com/c/abc')).toBe(true);
    });
  });

  describe('preserveForeignCustomIds helper and A-3.3 write-back sites', () => {
    it('re-inserts unknown custom ids at relative positions while dropping unknown non-custom ids and removed local custom ids', () => {
      const knownIds = new Set(['chatgpt', 'claude', 'gemini', 'custom-1111111111']);
      const isKnown = (id) => knownIds.has(id);

      // Leading, middle, consecutive, and trailing foreign custom IDs preserved; unknown non-custom dropped
      const previous = [
        'custom-aaaaaaaaaa',
        'custom-bbbbbbbbbb',
        'chatgpt',
        'stale-non-custom',
        'custom-cccccccccc',
        'custom-1111111111', // known locally -> user removed it from next, must NOT be re-inserted!
        'claude',
        'custom-dddddddddd',
      ];
      const next = ['chatgpt', 'claude', 'gemini'];

      expect(preserveForeignCustomIds(next, previous, isKnown)).toEqual([
        'custom-aaaaaaaaaa',
        'custom-bbbbbbbbbb',
        'chatgpt',
        'custom-cccccccccc',
        'claude',
        'custom-dddddddddd',
        'gemini',
      ]);
    });

    it('preserves foreign custom ids in providerOrder during migrateEnabledProvidersOnUpdate while dropping unknown non-custom ids', () => {
      const migrated = migrateEnabledProvidersOnUpdate(LEGACY_DEFAULT_PROVIDER_IDS, [
        'custom-aaaaaaaaaa',
        'grok',
        'unknown-slug',
        'custom-bbbbbbbbbb',
        'claude',
      ]);

      expect(migrated).toEqual({
        enabledProviders: [
          'grok',
          'claude',
          'chatgpt',
          'gemini',
          'deepseek',
          'kimi',
          'google',
          'doubao',
        ],
        providerOrder: [
          'custom-aaaaaaaaaa',
          'grok',
          'custom-bbbbbbbbbb',
          'claude',
          'chatgpt',
          'gemini',
          'deepseek',
          'kimi',
          'google',
          'doubao',
        ],
      });
    });

    it('hydrates custom providers in reconcileOptionalProviderAccess', async () => {
      installStatefulChromeStorage({
        localInitial: {
          [CUSTOM_PROVIDERS_STORAGE_KEY]: [
            makeCustomRecord({ id: 'custom-fedcba9876', url: 'http://localhost:3123/' }),
          ],
        },
        syncInitial: {
          enabledProviders: ['chatgpt', 'custom-fedcba9876'],
        },
      });
      chrome.scripting = {
        getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
        registerContentScripts: vi.fn(() => Promise.resolve()),
        unregisterContentScripts: vi.fn(() => Promise.resolve()),
      };
      chrome.declarativeNetRequest = {
        getDynamicRules: vi.fn(() => Promise.resolve([])),
        updateDynamicRules: vi.fn(() => Promise.resolve()),
      };

      expect(hasProviderDescriptor('custom-fedcba9876')).toBe(false);
      await reconcileOptionalProviderAccess();
      expect(hasProviderDescriptor('custom-fedcba9876')).toBe(true);
    });

    it('hydrates on options init, re-hydrates on local change, and preserves foreign custom ids in saveProviderOrder and toggleProvider', async () => {
      vi.resetModules();
      document.body.innerHTML = OPTIONS_BODY_HTML;

      const localCustom = makeCustomRecord({
        id: 'custom-1111111111',
        name: 'Local WebUI',
        url: 'http://localhost:3000/',
        frameRuleId: 10000,
      });

      const { areas } = installStatefulChromeStorage({
        localInitial: {
          [CUSTOM_PROVIDERS_STORAGE_KEY]: [localCustom],
        },
        syncInitial: {
          theme: 'light',
          language: 'en',
          enabledProviders: [
            'custom-aaaaaaaaaa',
            'chatgpt',
            'custom-1111111111',
            'claude',
            'custom-bbbbbbbbbb',
          ],
          providerOrder: [
            'custom-aaaaaaaaaa',
            'chatgpt',
            'stale-unknown',
            'custom-1111111111',
            'claude',
            'custom-bbbbbbbbbb',
          ],
        },
      });

      const optionsMod = await import('../options/options.js');

      // Wait for init() -> renderProviderList() to populate #provider-list including localCustom
      await vi.waitFor(() => {
        const renderedIds = Array.from(
          document.querySelectorAll('#provider-list .provider-item')
        ).map((el) => el.dataset.providerId);
        expect(renderedIds).toContain('custom-1111111111');
      });

      // Site 1: saveProviderOrder preserves foreign custom IDs in both providerOrder & enabledProviders
      const listContainer = document.getElementById('provider-list');
      const items = Array.from(listContainer.querySelectorAll('.provider-item'));
      const chatgptEl = items.find((el) => el.dataset.providerId === 'chatgpt');
      const claudeEl = items.find((el) => el.dataset.providerId === 'claude');
      // Swap claude before chatgpt in DOM
      listContainer.insertBefore(claudeEl, chatgptEl);

      await optionsMod.saveProviderOrder(listContainer);

      expect(areas.sync.providerOrder).toContain('custom-aaaaaaaaaa');
      expect(areas.sync.providerOrder).toContain('custom-bbbbbbbbbb');
      expect(areas.sync.providerOrder).not.toContain('stale-unknown');
      expect(areas.sync.enabledProviders).toEqual([
        'custom-aaaaaaaaaa',
        'claude',
        'chatgpt',
        'custom-1111111111',
        'custom-bbbbbbbbbb',
      ]);

      // Site 2: toggleProvider disables claude and local custom-1111111111 while keeping foreign custom IDs
      await optionsMod.toggleProvider('claude');
      expect(areas.sync.enabledProviders).toEqual([
        'custom-aaaaaaaaaa',
        'chatgpt',
        'custom-1111111111',
        'custom-bbbbbbbbbb',
      ]);
      expect(areas.sync.providerOrder).toContain('custom-aaaaaaaaaa');
      expect(areas.sync.providerOrder).toContain('custom-bbbbbbbbbb');

      await optionsMod.toggleProvider('custom-1111111111');
      expect(areas.sync.enabledProviders).toEqual([
        'custom-aaaaaaaaaa',
        'chatgpt',
        'custom-bbbbbbbbbb',
      ]);

      // Last locally known provider ('chatgpt') cannot be disabled even though foreign custom IDs remain
      await optionsMod.toggleProvider('chatgpt');
      expect(areas.sync.enabledProviders).toEqual([
        'custom-aaaaaaaaaa',
        'chatgpt',
        'custom-bbbbbbbbbb',
      ]);

      // Re-hydration on chrome.storage.local change renders newly added custom provider
      const secondCustom = makeCustomRecord({
        id: 'custom-2222222222',
        name: 'Local Gradio',
        url: 'http://127.0.0.1:7860/',
        frameRuleId: 10001,
      });
      await chrome.storage.local.set({
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [localCustom, secondCustom],
      });

      await vi.waitFor(() => {
        const renderedIds = Array.from(
          document.querySelectorAll('#provider-list .provider-item')
        ).map((el) => el.dataset.providerId);
        expect(renderedIds).toContain('custom-2222222222');
      });
    });

    it('hydrates on multi-panel init, preserves foreign custom ids across initializePanels/saveProviderConfiguration/restoreStateIfNeeded, and scopes providerId envelope to custom panels only', async () => {
      vi.resetModules();
      document.body.innerHTML = MULTI_PANEL_BODY_HTML;

      const localCustom = makeCustomRecord({
        id: 'custom-1111111111',
        name: 'Local WebUI',
        url: 'http://localhost:3000/',
        frameRuleId: 10000,
      });

      const { areas } = installStatefulChromeStorage({
        localInitial: {
          [CUSTOM_PROVIDERS_STORAGE_KEY]: [localCustom],
        },
        syncInitial: {
          theme: 'light',
          language: 'en',
          multiPanelLayout: '1x3',
          enabledProviders: [
            'custom-aaaaaaaaaa',
            'chatgpt',
            'custom-1111111111',
            'custom-bbbbbbbbbb',
          ],
          providerOrder: [
            'custom-aaaaaaaaaa',
            'chatgpt',
            'custom-1111111111',
            'custom-bbbbbbbbbb',
          ],
          multiPanelProviders: [
            'custom-aaaaaaaaaa',
            'chatgpt',
            'custom-1111111111',
            'custom-bbbbbbbbbb',
          ],
        },
        sessionInitial: {
          preservedState: {
            inputText: 'Restored prompt',
            uploadedImages: [],
            currentLayout: '1x3',
            panels: [{ providerId: 'chatgpt' }, { providerId: 'custom-1111111111' }],
          },
        },
      });

      const mpMod = await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        const panelEls = document.querySelectorAll('#panel-grid .panel-item');
        expect(panelEls).toHaveLength(2);
      });

      // Both restoreStateIfNeeded and initializePanels -> saveProviderConfiguration preserved leading & trailing foreign custom IDs!
      expect(areas.sync.multiPanelProviders).toEqual([
        'custom-aaaaaaaaaa',
        'chatgpt',
        'custom-1111111111',
        'custom-bbbbbbbbbb',
      ]);

      // Verify custom panel iframe loaded http://localhost:3000/
      const panelEls = Array.from(document.querySelectorAll('#panel-grid .panel-item'));
      expect(panelEls[0].querySelector('iframe').getAttribute('src')).toBe('https://chatgpt.com');
      expect(panelEls[1].querySelector('iframe').getAttribute('src')).toBe('http://localhost:3000/');

      // Envelope check: built-in payload has NO providerId; custom payload includes providerId
      const chatgptPost = vi.fn();
      const customPost = vi.fn();

      await mpMod.sendToPanel(
        {
          id: panelEls[0].id,
          providerId: 'chatgpt',
          iframe: { contentWindow: { postMessage: chatgptPost } },
        },
        'Compare this',
        [],
        true,
        'req-env-1',
        false,
        8000,
        { isFillAction: false, waitForActionResult: false }
      );

      await mpMod.sendToPanel(
        {
          id: panelEls[1].id,
          providerId: 'custom-1111111111',
          iframe: { contentWindow: { postMessage: customPost } },
        },
        'Compare this',
        [],
        true,
        'req-env-1',
        false,
        8000,
        { isFillAction: false, waitForActionResult: false }
      );

      expect(chatgptPost.mock.calls).toEqual([
        [
          {
            type: 'INJECT_TEXT',
            text: 'Compare this',
            images: [],
            autoSubmit: true,
            requestId: 'req-env-1',
            action: undefined,
            retry: undefined,
            providerMode: null,
            context: 'multi-panel',
          },
          'https://chatgpt.com',
        ],
        [
          {
            type: 'INJECT_TEXT',
            text: 'Compare this',
            images: [],
            autoSubmit: true,
            requestId: 'req-env-1',
            action: undefined,
            retry: undefined,
            providerMode: null,
            context: 'multi-panel',
          },
          'https://chat.openai.com',
        ],
      ]);
      expect('providerId' in chatgptPost.mock.calls[0][0]).toBe(false);

      expect(customPost.mock.calls).toEqual([
        [
          {
            type: 'INJECT_TEXT',
            text: 'Compare this',
            images: [],
            autoSubmit: true,
            requestId: 'req-env-1',
            action: undefined,
            retry: undefined,
            providerMode: null,
            context: 'multi-panel',
            providerId: 'custom-1111111111',
          },
          'http://localhost:3000',
        ],
      ]);

      // Frame -> host PANELIZE_PROVIDER_LOCATION requires data.provider === panel.providerId and exact origin
      const customIframe = panelEls[1].querySelector('iframe');
      const fakeCustomWindow = { postMessage: vi.fn() };
      Object.defineProperty(customIframe, 'contentWindow', {
        configurable: true,
        value: fakeCustomWindow,
      });
      chrome.tabs.create.mockClear();

      // Wrong port -> ignored, "Open in new tab" uses fallback URL
      window.dispatchEvent(
        new MessageEvent('message', {
          source: fakeCustomWindow,
          origin: 'http://localhost:3001',
          data: {
            context: 'multi-panel-provider-status',
            type: 'PANELIZE_PROVIDER_LOCATION',
            provider: 'custom-1111111111',
            url: 'http://localhost:3001/c/evil',
          },
        })
      );
      panelEls[1].querySelector('.open-provider-top-level-btn').click();
      await vi.waitFor(() => {
        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000/' });
      });

      // Wrong data.provider -> ignored
      chrome.tabs.create.mockClear();
      window.dispatchEvent(
        new MessageEvent('message', {
          source: fakeCustomWindow,
          origin: 'http://localhost:3000',
          data: {
            context: 'multi-panel-provider-status',
            type: 'PANELIZE_PROVIDER_LOCATION',
            provider: 'chatgpt',
            url: 'http://localhost:3000/c/spoofed',
          },
        })
      );
      panelEls[1].querySelector('.open-provider-top-level-btn').click();
      await vi.waitFor(() => {
        expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000/' });
      });

      // Exact origin + matching data.provider -> accepted and opened!
      chrome.tabs.create.mockClear();
      window.dispatchEvent(
        new MessageEvent('message', {
          source: fakeCustomWindow,
          origin: 'http://localhost:3000',
          data: {
            context: 'multi-panel-provider-status',
            type: 'PANELIZE_PROVIDER_LOCATION',
            provider: 'custom-1111111111',
            url: 'http://localhost:3000/c/deep-thread-77',
          },
        })
      );
      panelEls[1].querySelector('.open-provider-top-level-btn').click();
      await vi.waitFor(() => {
        expect(chrome.tabs.create).toHaveBeenCalledWith({
          url: 'http://localhost:3000/c/deep-thread-77',
        });
      });
    });
  });
});
