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

const MULTI_PANEL_CSS = readFileSync(
  resolve(process.cwd(), 'multi-panel/multi-panel.css'),
  'utf8'
);

const OPTIONS_HTML = readFileSync(
  resolve(process.cwd(), 'options/options.html'),
  'utf8'
);
const OPTIONS_BODY_HTML = OPTIONS_HTML
  .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

const XSS_NAME = '<img src=x onerror=alert(1)>"\'<svg data-xss=1>'.slice(0, 40);

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function expectNoInjectedElements(root = document) {
  expect(root.querySelectorAll('img[src="x"]')).toHaveLength(0);
  expect(root.querySelectorAll('svg[data-xss]')).toHaveLength(0);
  expect(root.querySelectorAll('[onerror], [onload]')).toHaveLength(0);
}

function expectBadgeStartTruncationDom(badgeEl, expectedOrigin) {
  expect(badgeEl).not.toBeNull();
  expect(badgeEl.textContent).toBe(expectedOrigin);
  expect(badgeEl.title).toBe(expectedOrigin);
  expect(badgeEl.children).toHaveLength(0);
  expect(badgeEl.shadowRoot).not.toBeNull();
  const bdiEl = badgeEl.shadowRoot.querySelector('bdi');
  expect(bdiEl).not.toBeNull();
  expect(bdiEl.getAttribute('dir')).toBe('ltr');
  expect(bdiEl.style.direction).toBe('ltr');
  expect(bdiEl.style.unicodeBidi).toBe('isolate');
  expect(bdiEl.querySelector('slot')).not.toBeNull();
  expectNoInjectedElements(badgeEl.shadowRoot);
}

describe('B3b origin badge start-truncation invariants, title tooltip, and literal XSS name', () => {
  let cleanupListeners = [];
  let storageChangeListeners = [];
  let areas = null;

  function installChromeMocks({ localInitial = {}, syncInitial = {}, grantedOrigins = [] } = {}) {
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
        for (const key of list) {
          delete store[key];
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
    chrome.management = {
      getSelf: vi.fn(() => Promise.resolve({ installType: 'normal' })),
    };
    chrome.runtime.id = 'test-extension-id';
    chrome.runtime.getManifest = vi.fn(() => ({ version: '2.1.0' }));
    chrome.runtime.sendMessage.mockImplementation((_msg, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
    });
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
        json: () =>
          Promise.resolve({
            tag_name: 'v2.1.0',
            html_url: 'https://github.com/Manho/Panelize/releases/tag/v2.1.0',
          }),
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

  it('sets exact origin textContent, matching title, LTR <bdi> isolation, and literal XSS name on panel and menu badges while leaving built-in panels unchanged', async () => {
    vi.resetModules();
    document.body.innerHTML = MULTI_PANEL_BODY_HTML;

    const loopbackOrigin = 'http://127.0.0.1:56901';
    const spoofOrigin = 'https://accounts.google.com.evil.tld';

    installChromeMocks({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-1111111111',
            name: XSS_NAME,
            url: `${loopbackOrigin}/chat?session=abc`,
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
          {
            id: 'custom-2222222222',
            name: 'Spoof Origin Provider',
            url: `${spoofOrigin}/oauth/login`,
            frameRuleId: 10001,
            createdAt: 1700000001000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x2',
        enabledProviders: ['custom-1111111111', 'chatgpt', 'custom-2222222222'],
        providerOrder: ['custom-1111111111', 'chatgpt', 'custom-2222222222'],
        multiPanelProviders: ['custom-1111111111', 'chatgpt'],
      },
      grantedOrigins: [`${loopbackOrigin}/*`, `${spoofOrigin}/*`],
    });

    await import('../multi-panel/multi-panel.js');
    await vi.waitFor(() => {
      expect(chrome.storage.session.get.mock.calls.map(([arg]) => arg)).toContain(
        'pendingMultiPanelAction'
      );
      expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(2);
    });

    const [customPanelEl, builtinPanelEl] = document.querySelectorAll('#panel-grid .panel-item');

    // Panel badge: exact textContent, exact title, LTR <bdi><slot> shadow isolation, literal XSS name
    const panelNameEl = customPanelEl.querySelector('.panel-header-left .panel-provider-name');
    const panelBadgeEl = customPanelEl.querySelector('.panel-header-left .panel-origin-badge');
    expect(panelNameEl.textContent).toBe(XSS_NAME);
    expect(panelNameEl.children).toHaveLength(0);
    expectBadgeStartTruncationDom(panelBadgeEl, loopbackOrigin);
    expectNoInjectedElements();

    // Built-in panel remains unchanged
    expect(builtinPanelEl.dataset.customProvider).toBeUndefined();
    expect(builtinPanelEl.querySelector('.panel-origin-badge')).toBeNull();
    expect(builtinPanelEl.querySelector('.panel-header-left span').textContent).toBe('ChatGPT');

    // Add-panel menu badge: exact textContent, exact title, LTR <bdi><slot> shadow isolation
    document.getElementById('add-panel-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.add-panel-menu')).not.toBeNull();
    });
    const addSpoofItem = document.querySelector(
      '.add-panel-menu .add-panel-item[data-provider-id="custom-2222222222"]'
    );
    expect(addSpoofItem).not.toBeNull();
    expectBadgeStartTruncationDom(addSpoofItem.querySelector('.menu-origin-badge'), spoofOrigin);
    document.querySelector('.add-panel-menu').remove();

    // Provider-switcher menu badge: both custom entries have exact textContent + title; XSS name stays literal
    builtinPanelEl.querySelector('.switch-provider-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
    });
    const switcherXssItem = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="custom-1111111111"]'
    );
    const switcherSpoofItem = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="custom-2222222222"]'
    );
    const switcherBuiltinItem = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="chatgpt"]'
    );

    expect(switcherXssItem.querySelector('.menu-provider-name').textContent).toBe(XSS_NAME);
    expectBadgeStartTruncationDom(
      switcherXssItem.querySelector('.menu-origin-badge'),
      loopbackOrigin
    );
    expectBadgeStartTruncationDom(
      switcherSpoofItem.querySelector('.menu-origin-badge'),
      spoofOrigin
    );
    expect(switcherBuiltinItem.querySelector('.menu-origin-badge')).toBeNull();
    expectNoInjectedElements();

    // Switching custom -> another custom updates both textContent and title while keeping LTR <bdi> shadow
    switcherSpoofItem.click();
    await vi.waitFor(() => {
      expect(builtinPanelEl.dataset.customProvider).toBe('true');
    });
    expectBadgeStartTruncationDom(
      builtinPanelEl.querySelector('.panel-origin-badge'),
      spoofOrigin
    );
  });

  it('also sets exact textContent, matching title, and literal XSS name on the Options provider list origin badge', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const spoofOrigin = 'https://accounts.google.com.evil.tld:8443';
    installChromeMocks({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-3333333333',
            name: XSS_NAME,
            url: `${spoofOrigin}/login`,
            frameRuleId: 10002,
            createdAt: 1700000002000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'custom-3333333333'],
        providerOrder: ['chatgpt', 'custom-3333333333'],
      },
      grantedOrigins: [`${spoofOrigin}/*`],
    });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      expect(
        document.querySelector('#provider-list .provider-item[data-provider-id="custom-3333333333"]')
      ).not.toBeNull();
    });
    await optionsMod.renderProviderList();

    const customRow = document.querySelector(
      '#provider-list .provider-item[data-provider-id="custom-3333333333"]'
    );
    expect(customRow.querySelector('.provider-name').textContent).toBe(XSS_NAME);
    expectBadgeStartTruncationDom(
      customRow.querySelector('.provider-origin-badge'),
      spoofOrigin
    );
    expectNoInjectedElements();
  });

  it('declares RTL start-ellipsis rules on .panel-origin-badge and .menu-origin-badge with name-first flex-shrink priority', () => {
    expect(MULTI_PANEL_CSS).toMatch(
      /\.panel-header-left\s+\.panel-origin-badge,\s*\.menu-origin-badge\s*\{[^}]*direction:\s*rtl;[^}]*\}/s
    );
    expect(MULTI_PANEL_CSS).toMatch(
      /\.panel-header-left\s+\.panel-origin-badge,\s*\.menu-origin-badge\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*\}/s
    );
    expect(MULTI_PANEL_CSS).toMatch(
      /\.menu-provider-name\s*\{[^}]*flex:\s*0\s+100000000\s+auto;[^}]*\}/s
    );
    expect(MULTI_PANEL_CSS).toMatch(
      /\.menu-origin-badge\s*\{[^}]*flex:\s*0\s+1\s+auto;[^}]*min-width:\s*0;[^}]*\}/s
    );
  });
});
