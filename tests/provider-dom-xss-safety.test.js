import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const XSS_NAME = '<img src=x onerror=alert(1)>"\'';

function createXssDescriptor() {
  return {
    id: 'test-xss',
    name: XSS_NAME,
    url: 'http://localhost:43199/',
    topLevelUrl: 'http://localhost:43199/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['http://localhost:43199'],
    allowedHosts: ['localhost'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
  };
}

function expectNoInjectedElements(root = document) {
  expect(root.querySelectorAll('img[src="x"]')).toHaveLength(0);
  expect(root.querySelectorAll('[onerror]')).toHaveLength(0);
}

describe('provider UI DOM construction XSS safety', () => {
  let cleanupListeners = [];
  let registryMod = null;

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

    chrome.i18n = {
      getMessage: vi.fn(() => ''),
      getUILanguage: vi.fn(() => 'en'),
    };
    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    };
    chrome.management = {
      getSelf: vi.fn(() => Promise.resolve({ installType: 'normal' })),
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
    chrome.runtime.getManifest = vi.fn(() => ({ version: '1.0.0' }));
    chrome.runtime.sendMessage.mockImplementation((_msg, callback) => {
      if (callback) callback({ success: true });
      return Promise.resolve({ success: true });
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
    registryMod?.resetExtraProviderDescriptors?.();
    registryMod = null;
    for (const cleanup of cleanupListeners.splice(0)) {
      cleanup();
    }
    vi.doUnmock('../modules/providers.js');
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete globalThis.fetch;
    document.body.innerHTML = '';
  });

  it('renders literal provider name across addPanel, updatePanelSelectors, showPanelLoadingState, iframe error, and showProviderSwitcher', async () => {
    vi.resetModules();
    registryMod = await import('../modules/provider-registry.js');
    registryMod.registerExtraProviderDescriptors([createXssDescriptor()]);

    document.body.innerHTML = MULTI_PANEL_BODY_HTML;
    chrome.storage.sync.get.mockImplementation((defaults) => {
      const base =
        typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? { ...defaults }
          : {};
      return Promise.resolve({
        ...base,
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x2',
        enabledProviders: ['test-xss', 'chatgpt'],
        providerOrder: ['test-xss', 'chatgpt'],
        multiPanelProviders: ['test-xss', 'chatgpt'],
      });
    });

    await import('../multi-panel/multi-panel.js');
    await vi.waitFor(() => {
      expect(chrome.storage.session.get.mock.calls.map(([arg]) => arg)).toContain(
        'pendingMultiPanelAction'
      );
    });

    const panelEl = document.querySelector('#panel-grid .panel-item');
    expect(panelEl).not.toBeNull();

    // 1) addPanel header + initial loading state + iframe attributes
    const headerIcon = panelEl.querySelector('.panel-header-left img.provider-icon');
    const headerSpan = panelEl.querySelector('.panel-header-left span');
    expect(headerIcon.getAttribute('alt')).toBe(XSS_NAME);
    expect(headerIcon.dataset.providerId).toBe('test-xss');
    expect(headerSpan.textContent).toBe(XSS_NAME);

    const loadingEl = panelEl.querySelector('.panel-loading');
    expect(loadingEl.querySelector('img.loading-icon').getAttribute('alt')).toBe(XSS_NAME);
    expect(loadingEl.querySelector('.loading-text').textContent).toBe(`Loading ${XSS_NAME}...`);

    const iframe = panelEl.querySelector('iframe');
    expect(iframe.getAttribute('src')).toBe('http://localhost:43199/');
    expect(iframe.getAttribute('sandbox')).toBe(
      'allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
    );
    expect(iframe.getAttribute('allow')).toBe('clipboard-read; clipboard-write');
    expectNoInjectedElements();

    // 2) updatePanelSelectors
    const selectorEl = document.querySelector('#panel-selectors .panel-selector');
    expect(selectorEl).not.toBeNull();
    expect(selectorEl.querySelector('img.provider-icon').getAttribute('alt')).toBe(XSS_NAME);
    expect(selectorEl.querySelector('span').textContent).toBe(XSS_NAME);
    expectNoInjectedElements();

    // 3) iframe error handler
    iframe.dispatchEvent(new Event('error'));
    expect(loadingEl.querySelector('img.loading-icon').getAttribute('alt')).toBe(XSS_NAME);
    expect(loadingEl.querySelector('.loading-text').textContent).toBe(
      `Failed to load ${XSS_NAME}`
    );
    expectNoInjectedElements();

    // 4) showPanelLoadingState (via refresh button -> reloadPanelIframe)
    loadingEl.classList.add('hidden');
    panelEl.querySelector('.refresh-panel-btn').click();
    expect(loadingEl.classList.contains('hidden')).toBe(false);
    expect(loadingEl.querySelector('img.loading-icon').getAttribute('alt')).toBe(XSS_NAME);
    expect(loadingEl.querySelector('.loading-text').textContent).toBe(`Loading ${XSS_NAME}...`);
    expectNoInjectedElements();

    // 5) showProviderSwitcher
    panelEl.querySelector('.switch-provider-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
    });
    const switcherItem = document.querySelector(
      '.provider-switcher-menu .provider-switcher-item[data-provider-id="test-xss"]'
    );
    expect(switcherItem).not.toBeNull();
    expect(switcherItem.querySelector('img').getAttribute('alt')).toBe(XSS_NAME);
    expect(switcherItem.querySelector('span').textContent).toBe(XSS_NAME);
    expectNoInjectedElements();
  });

  it('renders literal provider name in showAddPanelMenu when adding an unused provider', async () => {
    vi.resetModules();
    registryMod = await import('../modules/provider-registry.js');
    registryMod.registerExtraProviderDescriptors([createXssDescriptor()]);

    document.body.innerHTML = MULTI_PANEL_BODY_HTML;
    chrome.storage.sync.get.mockImplementation((defaults) => {
      const base =
        typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? { ...defaults }
          : {};
      return Promise.resolve({
        ...base,
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x1',
        enabledProviders: ['chatgpt', 'test-xss'],
        providerOrder: ['chatgpt', 'test-xss'],
        multiPanelProviders: ['chatgpt'],
      });
    });

    await import('../multi-panel/multi-panel.js');
    await vi.waitFor(() => {
      expect(chrome.storage.session.get.mock.calls.map(([arg]) => arg)).toContain(
        'pendingMultiPanelAction'
      );
    });

    document.getElementById('add-panel-btn').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.add-panel-menu')).not.toBeNull();
    });

    const addItem = document.querySelector(
      '.add-panel-menu .add-panel-item[data-provider-id="test-xss"]'
    );
    expect(addItem).not.toBeNull();
    expect(addItem.querySelector('img').getAttribute('alt')).toBe(XSS_NAME);
    expect(addItem.querySelector('span').textContent).toBe(XSS_NAME);
    expectNoInjectedElements();
  });

  it('renders literal text in options renderProviderList and showToast', async () => {
    vi.resetModules();
    registryMod = await import('../modules/provider-registry.js');
    registryMod.registerExtraProviderDescriptors([createXssDescriptor()]);

    vi.doMock('../modules/providers.js', async (importOriginal) => {
      const actual = await importOriginal();
      const xssProvider = actual.getProviderById('test-xss');
      return {
        ...actual,
        PROVIDERS: xssProvider ? [...actual.PROVIDERS, xssProvider] : actual.PROVIDERS,
      };
    });

    document.body.innerHTML = OPTIONS_BODY_HTML;
    chrome.storage.sync.get.mockImplementation((defaults) => {
      const base =
        typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? { ...defaults }
          : {};
      return Promise.resolve({
        ...base,
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'google', 'test-xss'],
        providerOrder: ['test-xss', 'google', 'chatgpt'],
      });
    });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      expect(
        document.querySelector('#provider-list .provider-item[data-provider-id="test-xss"]')
      ).not.toBeNull();
    });

    // 7) options.js renderProviderList
    const item = document.querySelector(
      '#provider-list .provider-item[data-provider-id="test-xss"]'
    );
    expect(item.classList.contains('draggable')).toBe(true);
    expect(item.getAttribute('draggable')).toBe('true');
    expect(item.dataset.enabledPreference).toBe('true');
    expect(item.dataset.hasAccess).toBe('true');
    expect(item.querySelector('.drag-handle')?.textContent).toBe('drag_indicator');
    const iconImg = item.querySelector('.provider-icon img');
    expect(iconImg.getAttribute('alt')).toBe(XSS_NAME);
    expect(iconImg.getAttribute('width')).toBe('24');
    expect(iconImg.getAttribute('height')).toBe('24');
    expect(item.querySelector('.provider-name').textContent).toBe(XSS_NAME);
    expect(item.querySelector('.toggle-switch').classList.contains('active')).toBe(true);

    // Built-in Google item retains its mode select
    const googleItem = document.querySelector(
      '#provider-list .provider-item[data-provider-id="google"]'
    );
    expect(googleItem.querySelector('select.google-mode-select')).not.toBeNull();
    expectNoInjectedElements();

    // 8) options.js showToast
    chrome.i18n.getMessage.mockImplementation((key, substitutions) => {
      if (key === 'testToastKey') {
        const sub = Array.isArray(substitutions) ? substitutions[0] : substitutions;
        return `Imported ${sub}`;
      }
      return '';
    });
    optionsMod.showToast('success', 'testToastKey', [XSS_NAME]);

    const toast = document.querySelector('#toast-container .toast.toast-success');
    expect(toast).not.toBeNull();
    expect(toast.querySelector('.toast-icon').textContent).toBe('✓');
    expect(toast.querySelector('.toast-message').textContent).toBe(`Imported ${XSS_NAME}`);
    expectNoInjectedElements();
  });
});
