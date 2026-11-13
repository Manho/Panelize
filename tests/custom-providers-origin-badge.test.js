import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_PROVIDERS_STORAGE_KEY } from '../modules/custom-providers.js';

const MULTI_PANEL_HTML = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);
const MULTI_PANEL_BODY_HTML = MULTI_PANEL_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const XSS_NAME = '<img src=x onerror=alert(1)>"\'';

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function expectNoInjectedElements(root = document) {
  expect(root.querySelectorAll('img[src="x"]')).toHaveLength(0);
  expect(root.querySelectorAll('[onerror]')).toHaveLength(0);
}

describe('B3.3 persistent origin badge and live customProviders re-hydration in Multi-Panel', () => {
  let cleanupListeners = [];
  let storageChangeListeners = [];
  let areas = null;

  function installMultiPanelChrome({ localInitial = {}, syncInitial = {}, grantedOrigins = [] } = {}) {
    storageChangeListeners = [];
    areas = {
      local: cloneValue(localInitial) || {},
      sync: cloneValue(syncInitial) || {},
    };
    const grantedSet = new Set(grantedOrigins);

    const makeArea = (areaName) => ({
      get: vi.fn((keys) => {
        const store = areas[areaName];
        if (keys === null || keys === undefined) {
          return Promise.resolve(cloneValue(store));
        }
        if (typeof keys === 'string') {
          const out = {};
          if (keys in store) out[keys] = cloneValue(store[keys]);
          return Promise.resolve(out);
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) {
            if (key in store) out[key] = cloneValue(store[key]);
          }
          return Promise.resolve(out);
        }
        const out = cloneValue(keys);
        for (const key of Object.keys(keys)) {
          if (key in store) {
            out[key] = cloneValue(store[key]);
          }
        }
        return Promise.resolve(out);
      }),
      set: vi.fn((items) => {
        const store = areas[areaName];
        const changes = {};
        for (const [key, value] of Object.entries(items)) {
          const oldValue = key in store ? cloneValue(store[key]) : undefined;
          const newValue = cloneValue(value);
          store[key] = newValue;
          changes[key] = { oldValue, newValue };
        }
        for (const listener of [...storageChangeListeners]) {
          listener(changes, areaName);
        }
        return Promise.resolve();
      }),
      remove: vi.fn((keys) => {
        const store = areas[areaName];
        const list = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const key of list) {
          if (key in store) {
            const oldValue = cloneValue(store[key]);
            delete store[key];
            changes[key] = { oldValue };
          }
        }
        if (Object.keys(changes).length > 0) {
          for (const listener of [...storageChangeListeners]) {
            listener(changes, areaName);
          }
        }
        return Promise.resolve();
      }),
    });

    chrome.storage.local = makeArea('local');
    chrome.storage.sync = makeArea('sync');
    chrome.storage.session = {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.onChanged = {
      addListener: vi.fn((fn) => {
        storageChangeListeners.push(fn);
      }),
      removeListener: vi.fn((fn) => {
        const idx = storageChangeListeners.indexOf(fn);
        if (idx !== -1) storageChangeListeners.splice(idx, 1);
      }),
    };

    chrome.i18n = {
      getMessage: vi.fn(() => ''),
      getUILanguage: vi.fn(() => 'en'),
    };
    chrome.permissions = {
      contains: vi.fn(({ origins = [] } = {}) =>
        Promise.resolve(origins.every((origin) => grantedSet.has(origin)))
      ),
      request: vi.fn(() => Promise.resolve(true)),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    };
    chrome.declarativeNetRequest = {
      RuleConditionKeys: { TOP_DOMAINS: 'topDomains' },
    };
    chrome.windows = {
      getCurrent: vi.fn(() => Promise.resolve({ type: 'normal' })),
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    };
    chrome.runtime.id = 'test-extension-id';
    chrome.runtime.getManifest = vi.fn(() => ({ version: '2.1.0' }));
    chrome.runtime.sendMessage.mockImplementation((_msg, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    });

    return { grantedSet };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    cleanupListeners = [];

    if (window.happyDOM?.settings?.navigation) {
      window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
    }

    const origWinAdd = window.addEventListener.bind(window);
    const origWinRemove = window.removeEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    const origDocRemove = document.addEventListener.bind(document);

    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origWinRemove(type, listener, options));
      return origWinAdd(type, listener, options);
    });
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origDocRemove(type, listener, options));
      return origDocAdd(type, listener, options);
    });

    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      })
    );
  });

  afterEach(() => {
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }
    vi.restoreAllMocks();
    delete globalThis.fetch;
    document.body.innerHTML = '';
  });

  it('renders origin badge via textContent with literal XSS name across addPanel, switchPanelProvider, showProviderSwitcher, and showAddPanelMenu while keeping built-in panels unchanged', async () => {
    vi.resetModules();
    document.body.innerHTML = MULTI_PANEL_BODY_HTML;

    installMultiPanelChrome({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-aaaa111111',
            name: XSS_NAME,
            url: 'http://localhost:3000/chat?room=1',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
          {
            id: 'custom-bbbb222222',
            name: 'Second Self-Hosted AI',
            url: 'http://127.0.0.1:8080/webui',
            frameRuleId: 10001,
            createdAt: 1700000001000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x2',
        enabledProviders: ['custom-aaaa111111', 'chatgpt', 'custom-bbbb222222'],
        providerOrder: ['custom-aaaa111111', 'chatgpt', 'custom-bbbb222222'],
        multiPanelProviders: ['custom-aaaa111111', 'chatgpt'],
      },
      grantedOrigins: ['http://localhost:3000/*', 'http://127.0.0.1:8080/*'],
    });

    await import('../multi-panel/multi-panel.js');
    await vi.waitFor(() => {
      expect(chrome.storage.session.get.mock.calls.map(([arg]) => arg)).toContain(
        'pendingMultiPanelAction'
      );
      expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(2);
    });

    const [customPanelEl, builtinPanelEl] = document.querySelectorAll('#panel-grid .panel-item');

    // 1. Custom panel in addPanel has data-custom-provider="true", literal XSS name, and plain-text origin badge
    expect(customPanelEl.dataset.customProvider).toBe('true');
    const customNameSpan = customPanelEl.querySelector('.panel-header-left .panel-provider-name');
    const customBadgeSpan = customPanelEl.querySelector('.panel-header-left .panel-origin-badge');
    expect(customNameSpan).not.toBeNull();
    expect(customNameSpan.textContent).toBe(XSS_NAME);
    expect(customNameSpan.children).toHaveLength(0);
    expect(customBadgeSpan).not.toBeNull();
    expect(customBadgeSpan.textContent).toBe('http://localhost:3000');
    expect(customBadgeSpan.children).toHaveLength(0);
    expectNoInjectedElements();

    // 2. Built-in panel has NO data-custom-provider and NO .panel-origin-badge
    expect(builtinPanelEl.dataset.customProvider).toBeUndefined();
    expect(builtinPanelEl.querySelector('.panel-origin-badge')).toBeNull();
    expect(builtinPanelEl.querySelector('.panel-header-left span').textContent).toBe('ChatGPT');

    // 3. showAddPanelMenu includes unused custom-bbbb222222 with .menu-origin-badge
    document.getElementById('add-panel-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.add-panel-menu')).not.toBeNull();
    });
    const addItem = document.querySelector(
      '.add-panel-menu .add-panel-item[data-provider-id="custom-bbbb222222"]'
    );
    expect(addItem).not.toBeNull();
    expect(addItem.querySelector('.menu-provider-name').textContent).toBe('Second Self-Hosted AI');
    const addBadge = addItem.querySelector('.menu-origin-badge');
    expect(addBadge).not.toBeNull();
    expect(addBadge.textContent).toBe('http://127.0.0.1:8080');
    expect(addBadge.children).toHaveLength(0);
    document.querySelector('.add-panel-menu').remove();

    // 4. showProviderSwitcher shows .menu-origin-badge on custom entries and not on built-ins
    builtinPanelEl.querySelector('.switch-provider-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
    });
    const switcherXss = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="custom-aaaa111111"]'
    );
    const switcherBuiltin = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="chatgpt"]'
    );
    expect(switcherXss.querySelector('.menu-provider-name').textContent).toBe(XSS_NAME);
    expect(switcherXss.querySelector('.menu-origin-badge').textContent).toBe(
      'http://localhost:3000'
    );
    expect(switcherBuiltin.querySelector('.menu-origin-badge')).toBeNull();
    expectNoInjectedElements();

    // 5. switchPanelProvider: built-in -> custom adds .panel-origin-badge
    const switcherSecondCustom = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="custom-bbbb222222"]'
    );
    switcherSecondCustom.click();
    await vi.waitFor(() => {
      expect(builtinPanelEl.dataset.customProvider).toBe('true');
    });
    expect(builtinPanelEl.querySelector('.panel-origin-badge').textContent).toBe(
      'http://127.0.0.1:8080'
    );

    // 6. switchPanelProvider: custom -> built-in removes .panel-origin-badge and data-custom-provider
    builtinPanelEl.querySelector('.switch-provider-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
    });
    document
      .querySelector('.provider-switcher-menu .provider-switcher-item[data-provider-id="chatgpt"]')
      .click();
    await vi.waitFor(() => {
      expect(builtinPanelEl.dataset.customProvider).toBeUndefined();
    });
    expect(builtinPanelEl.querySelector('.panel-origin-badge')).toBeNull();
    expect(builtinPanelEl.querySelector('.panel-header-left span').textContent).toBe('ChatGPT');
  });

  it('re-hydrates in both directions on storage.onChanged (customProviders): added entry appears in add-panel menu without reload, deleted entry disappears from open Multi-Panel', async () => {
    vi.resetModules();
    document.body.innerHTML = MULTI_PANEL_BODY_HTML;

    const { grantedSet } = installMultiPanelChrome({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-1111111111',
            name: 'Open Custom Panel',
            url: 'http://localhost:3000/',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x2',
        enabledProviders: ['chatgpt', 'custom-1111111111'],
        providerOrder: ['chatgpt', 'custom-1111111111'],
        multiPanelProviders: ['chatgpt', 'custom-1111111111'],
      },
      grantedOrigins: ['http://localhost:3000/*'],
    });

    await import('../multi-panel/multi-panel.js');
    const registryAfterReset = await import('../modules/provider-registry.js');
    await vi.waitFor(() => {
      expect(chrome.storage.session.get.mock.calls.map(([arg]) => arg)).toContain(
        'pendingMultiPanelAction'
      );
      expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(2);
    });
    expect(document.querySelectorAll('#panel-grid .panel-item[data-custom-provider="true"]')).toHaveLength(1);

    // Direction 1: Add a new custom entry in Options (grant + storage.local + storage.sync) without reloading Multi-Panel
    grantedSet.add('http://127.0.0.1:7860/*');
    await chrome.storage.local.set({
      [CUSTOM_PROVIDERS_STORAGE_KEY]: [
        ...areas.local[CUSTOM_PROVIDERS_STORAGE_KEY],
        {
          id: 'custom-2222222222',
          name: 'Hot-Added Gradio',
          url: 'http://127.0.0.1:7860/',
          frameRuleId: 10001,
          createdAt: 1700000002000,
        },
      ],
    });
    await chrome.storage.sync.set({
      enabledProviders: ['chatgpt', 'custom-1111111111', 'custom-2222222222'],
      providerOrder: ['chatgpt', 'custom-1111111111', 'custom-2222222222'],
    });

    // Wait for async storage.onChanged re-hydration, then open add-panel menu without reloading Multi-Panel
    await vi.waitFor(() => {
      expect(registryAfterReset.hasProviderDescriptor('custom-2222222222')).toBe(true);
    });

    document.getElementById('add-panel-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.add-panel-menu')).not.toBeNull();
    });
    const addedMenuItem = document.querySelector(
      '.add-panel-menu .add-panel-item[data-provider-id="custom-2222222222"]'
    );
    expect(addedMenuItem).not.toBeNull();
    expect(addedMenuItem.querySelector('.menu-provider-name').textContent).toBe('Hot-Added Gradio');
    expect(addedMenuItem.querySelector('.menu-origin-badge').textContent).toBe(
      'http://127.0.0.1:7860'
    );
    document.querySelectorAll('.add-panel-menu').forEach((m) => m.remove());

    // Direction 2: Delete custom-1111111111 in Options -> open panel disappears immediately from Multi-Panel
    // AND Multi-Panel does not race-reinsert custom-1111111111 into multiPanelProviders!
    await chrome.storage.local.set({
      [CUSTOM_PROVIDERS_STORAGE_KEY]: [
        {
          id: 'custom-2222222222',
          name: 'Hot-Added Gradio',
          url: 'http://127.0.0.1:7860/',
          frameRuleId: 10001,
          createdAt: 1700000002000,
        },
      ],
    });
    await chrome.storage.sync.set({
      enabledProviders: ['chatgpt', 'custom-2222222222'],
      providerOrder: ['chatgpt', 'custom-2222222222'],
      multiPanelProviders: ['chatgpt'],
    });

    await vi.waitFor(() => {
      expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(1);
    });
    expect(
      document.querySelectorAll('#panel-grid .panel-item[data-custom-provider="true"]')
    ).toHaveLength(0);
    expect(areas.sync.multiPanelProviders).toEqual(['chatgpt']);
  });
});
