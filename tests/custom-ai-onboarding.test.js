import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import { resetCustomApiSecretsDbForTests } from '../modules/custom-api-secrets.js';
import {
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';
import { createMockIndexedDB } from './helpers/mock-indexeddb.js';

const ROOT = process.cwd();
const LOCALES_DIR = resolve(ROOT, '_locales');
const LOCALES = readdirSync(LOCALES_DIR).sort();

function readMessages(locale) {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
}

const EN_MESSAGES = readMessages('en');
const ZH_CN_MESSAGES = readMessages('zh_CN');
const ZH_TW_MESSAGES = readMessages('zh_TW');

function extractBodyInnerHtml(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error(`Could not extract <body> from ${filePath}`);
  }
  return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

const OPTIONS_BODY_HTML = extractBodyInnerHtml(resolve(ROOT, 'options/options.html'));
const MULTI_PANEL_BODY_HTML = extractBodyInnerHtml(resolve(ROOT, 'multi-panel/multi-panel.html'));

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function makeStorageArea(areas, areaName, storageListeners) {
  return {
    get: vi.fn((keys) => {
      const store = areas[areaName];
      if (keys === null || keys === undefined) {
        return Promise.resolve(cloneValue(store));
      }
      if (typeof keys === 'string') {
        return Promise.resolve(keys in store ? { [keys]: cloneValue(store[keys]) } : {});
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) {
          if (key in store) out[key] = cloneValue(store[key]);
        }
        return Promise.resolve(out);
      }
      if (typeof keys === 'object') {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = key in store ? cloneValue(store[key]) : cloneValue(fallback);
        }
        return Promise.resolve(out);
      }
      return Promise.resolve({});
    }),
    set: vi.fn((items) => {
      const store = areas[areaName];
      const changes = {};
      for (const [key, nextVal] of Object.entries(items)) {
        const oldVal = store[key];
        store[key] = cloneValue(nextVal);
        changes[key] = {
          oldValue: cloneValue(oldVal),
          newValue: cloneValue(nextVal),
        };
      }
      for (const listener of [...storageListeners]) {
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
          changes[key] = { oldValue: cloneValue(store[key]), newValue: undefined };
          delete store[key];
        }
      }
      if (Object.keys(changes).length > 0) {
        for (const listener of [...storageListeners]) {
          listener(changes, areaName);
        }
      }
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      areas[areaName] = {};
      return Promise.resolve();
    }),
  };
}

function installOptionsChromeEnv({
  localInitial = {},
  syncInitial = {},
  scopedFrameRules = true,
  grantedOrigins = [],
  uiLanguage = 'en',
} = {}) {
  const areas = {
    local: cloneValue(localInitial),
    sync: cloneValue(syncInitial),
  };
  const storageListeners = [];
  const permissionAddedListeners = [];
  const permissionRemovedListeners = [];
  const grantedSet = new Set(grantedOrigins);
  const localeMap = {
    en: EN_MESSAGES,
    zh_CN: ZH_CN_MESSAGES,
    zh_TW: ZH_TW_MESSAGES,
  };
  const activeMessages = localeMap[uiLanguage] || EN_MESSAGES;

  chrome.runtime.id = 'panelize-test-extension-id';
  chrome.runtime.getManifest = vi.fn(() => ({ version: '2.2.0' }));
  chrome.runtime.sendMessage = vi.fn(() => Promise.resolve({ success: true }));
  chrome.declarativeNetRequest = scopedFrameRules
    ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } }
    : {};

  chrome.storage.local = makeStorageArea(areas, 'local', storageListeners);
  chrome.storage.sync = makeStorageArea(areas, 'sync', storageListeners);
  chrome.storage.onChanged = {
    addListener: vi.fn((fn) => storageListeners.push(fn)),
    removeListener: vi.fn((fn) => {
      const idx = storageListeners.indexOf(fn);
      if (idx !== -1) storageListeners.splice(idx, 1);
    }),
  };

  chrome.permissions = {
    contains: vi.fn(({ origins = [] } = {}) =>
      Promise.resolve(origins.every((origin) => grantedSet.has(origin)))
    ),
    request: vi.fn(({ origins = [] } = {}) => {
      origins.forEach((origin) => grantedSet.add(origin));
      permissionAddedListeners.forEach((fn) => fn({ origins }));
      return Promise.resolve(true);
    }),
    remove: vi.fn(({ origins = [] } = {}) => {
      origins.forEach((origin) => grantedSet.delete(origin));
      permissionRemovedListeners.forEach((fn) => fn({ origins }));
      return Promise.resolve(true);
    }),
    onAdded: { addListener: vi.fn((fn) => permissionAddedListeners.push(fn)) },
    onRemoved: { addListener: vi.fn((fn) => permissionRemovedListeners.push(fn)) },
  };

  chrome.management = {
    getSelf: vi.fn(() => Promise.resolve({ installType: 'normal' })),
  };

  chrome.i18n = {
    getUILanguage: vi.fn(() => uiLanguage),
    getMessage: vi.fn((key, substitutions = null) => {
      const entry = activeMessages[key];
      if (!entry) return '';
      let msg = entry.message;
      if (substitutions !== null && substitutions !== undefined) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        subs.forEach((sub, idx) => {
          msg = msg.replace(new RegExp(`\\$${idx + 1}`, 'g'), String(sub));
        });
      }
      return msg;
    }),
  };

  globalThis.fetch = vi.fn((url) => {
    const str = String(url);
    for (const [loc, messages] of Object.entries(localeMap)) {
      if (str.includes(`_locales/${loc}/messages.json`)) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(messages),
        });
      }
    }
    if (str.includes('version-info.json')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: '2.2.0' }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  return { areas, grantedSet };
}

describe('Custom AI onboarding locales, Settings UI, and Multi-Panel menu actions', () => {
  const ONBOARDING_LOCALE_KEYS = [
    'descEnabledProviders',
    'descAddCustomProviderIntro',
    'linkCustomProviderGuide',
    'optionCustomProviderKindWebSite',
    'optionCustomProviderKindWebLocal',
    'optionCustomProviderKindApi',
    'placeholderCustomProviderNameWebSite',
    'placeholderCustomProviderNameWebLocal',
    'placeholderCustomProviderNameApi',
    'labelCustomProviderUrlWebSite',
    'labelCustomProviderUrlWebLocal',
    'placeholderCustomProviderUrlWebSite',
    'placeholderCustomProviderUrlWebLocal',
    'placeholderCustomApiEndpointUrl',
    'hintCustomProviderModeWebSite',
    'hintCustomProviderModeWebLocal',
    'hintCustomProviderModeApi',
    'labelCustomProviderExamples',
    'chipCustomExampleOllamaLocal',
    'menuAddCustomProvider',
    'menuAddCustomProviderHint',
    'menuAllEnabledProvidersOpen',
  ];

  describe('10-locale custom AI onboarding copy & typography', () => {
    it('defines non-empty translations for every custom AI onboarding key across all 10 locales', () => {
      expect(LOCALES).toHaveLength(10);
      for (const locale of LOCALES) {
        const messages = readMessages(locale);
        for (const key of ONBOARDING_LOCALE_KEYS) {
          expect(messages[key]?.message?.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
        }
      }
    });

    it('keeps zh_CN, zh_TW, and README.zh-CN.md free of spaces between CJK and Latin/numbers/code and softens absolute custom website wording', () => {
      const cjkSpaceRe = /([\u4e00-\u9fff][ \t]+[A-Za-z0-9`]|[A-Za-z0-9`][ \t]+[\u4e00-\u9fff])/;
      for (const locale of ['zh_CN', 'zh_TW']) {
        const messages = readMessages(locale);
        expect(messages.extensionDescription.message, `${locale}.extensionDescription`).not.toMatch(cjkSpaceRe);
        expect(messages.errCustomUrlInsecureHttp.message, `${locale}.errCustomUrlInsecureHttp`).not.toMatch(
          cjkSpaceRe
        );
        for (const key of ONBOARDING_LOCALE_KEYS) {
          expect(messages[key].message, `${locale}.${key}`).not.toMatch(cjkSpaceRe);
        }
        expect(messages.descEnabledProviders.message).toMatch(/几乎任意|幾乎任意|绝大多数|絕大多數/);
        expect(messages.hintCustomProviderModeWebSite.message).toMatch(/几乎任意|幾乎任意|绝大多数|絕大多數/);
      }

      for (const locale of LOCALES) {
        const messages = readMessages(locale);
        expect(messages.hintCustomProviderModeWebLocal.message, `${locale}.hintCustomProviderModeWebLocal`).toContain(
          '192.168'
        );
        expect(messages.hintCustomProviderModeWebLocal.message, `${locale}.hintCustomProviderModeWebLocal`).toContain(
          'https://'
        );
        expect(messages.errCustomUrlInsecureHttp.message, `${locale}.errCustomUrlInsecureHttp`).toContain('192.168');
      }

      const zhReadme = readFileSync(resolve(ROOT, 'README.zh-CN.md'), 'utf8');
      expect(zhReadme).not.toMatch(cjkSpaceRe);
      expect(zhReadme).not.toContain('**任意AI网站');
    });
  });

  describe('Settings 3-mode Custom AI form, quick-fill chips, guide link, and hash highlight', () => {
    const originalIndexedDB = globalThis.indexedDB;

    beforeEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
      resetExtraProviderDescriptors();
      setCustomProviderDescriptors([]);
      resetCustomApiSecretsDbForTests();
      globalThis.indexedDB = createMockIndexedDB();
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.innerHTML = OPTIONS_BODY_HTML;
      window.history.replaceState(null, '', '/options/options.html');
    });

    afterEach(() => {
      vi.useRealTimers();
      resetCustomApiSecretsDbForTests();
      globalThis.indexedDB = originalIndexedDB;
      window.history.replaceState(null, '', '/options/options.html');
    });

    it('renders 3 connection modes, maps both web and web-local to customKind="web", and updates placeholders/hints/chips', async () => {
      const { areas } = installOptionsChromeEnv();
      const optionsMod = await import('../options/options.js');
      const { getProviderDescriptor } = await import('../modules/provider-registry.js');
      await vi.waitFor(() => {
        expect(document.getElementById('version')?.textContent).toContain('2.2.0');
        expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
        expect(document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip').length).toBe(4);
      });

      const guideLink = document.getElementById('custom-provider-guide-link');
      expect(guideLink.getAttribute('href')).toBe('https://panelize.dev/guides/add-custom-ai-and-api/');
      expect(guideLink.getAttribute('target')).toBe('_blank');
      expect(guideLink.getAttribute('rel')).toBe('noopener noreferrer');

      const nameInput = document.getElementById('custom-provider-name');
      const urlLabel = document.getElementById('custom-provider-url-label');
      const urlInput = document.getElementById('custom-provider-url');
      const modeHint = document.getElementById('custom-provider-mode-hint');
      const apiNote = document.getElementById('custom-provider-api-note');

      // Mode 1: AI Website (default)
      expect(optionsMod.getSelectedCustomProviderMode()).toBe('web');
      expect(optionsMod.getSelectedCustomProviderKind()).toBe('web');
      expect(nameInput.placeholder).toBe('Perplexity');
      expect(urlLabel.textContent).toBe('AI Website URL');
      expect(urlInput.placeholder).toBe('https://www.perplexity.ai');
      expect(modeHint.textContent).toContain('https://www.perplexity.ai');
      expect(apiNote.hidden).toBe(true);
      expect(
        Array.from(document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')).map(
          (el) => el.textContent
        )
      ).toEqual(['Perplexity', 'Mistral Le Chat', 'Poe', 'HuggingChat']);

      // Mode 2: Local / Self-hosted Web -> underlying customKind remains 'web'
      const webLocalRadio = document.getElementById('custom-provider-kind-web-local');
      webLocalRadio.checked = true;
      webLocalRadio.dispatchEvent(new Event('change', { bubbles: true }));

      expect(optionsMod.getSelectedCustomProviderMode()).toBe('web-local');
      expect(optionsMod.getSelectedCustomProviderKind()).toBe('web');
      expect(nameInput.placeholder).toBe('Open WebUI');
      expect(urlLabel.textContent).toBe('Local or Self-hosted URL');
      expect(urlInput.placeholder).toBe('http://localhost:3000 or http://127.0.0.1:8080');
      expect(modeHint.textContent).toContain('Open WebUI');
      expect(apiNote.hidden).toBe(true);
      const localChips = Array.from(
        document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')
      );
      expect(localChips.map((el) => el.textContent)).toEqual(['Open WebUI', 'LobeChat']);

      // Quick-fill Open WebUI in web-local mode and submit -> persisted as customKind: 'web'
      localChips[0].click();
      expect(nameInput.value).toBe('Open WebUI');
      expect(urlInput.value).toBe('http://localhost:3000');
      expect(document.getElementById('custom-provider-origin-preview').textContent).toContain(
        'http://localhost:3000'
      );

      document.getElementById('custom-provider-form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })
      );
      await vi.waitFor(() => {
        expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
      });
      const savedLocalRecord = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0];
      expect(savedLocalRecord).toMatchObject({
        name: 'Open WebUI',
        url: 'http://localhost:3000/',
      });
      expect(savedLocalRecord.kind).toBeUndefined();
      const registeredWebLocalDescriptor = getProviderDescriptor(savedLocalRecord.id);
      expect(registeredWebLocalDescriptor).toMatchObject({
        access: 'custom',
        name: 'Open WebUI',
        url: 'http://localhost:3000/',
        frameOrigins: ['http://localhost:3000'],
      });
      expect(registeredWebLocalDescriptor.customKind).toBeUndefined();

      // Mode 3: OpenAI-compatible API
      const apiRadio = document.getElementById('custom-provider-kind-api');
      apiRadio.checked = true;
      apiRadio.dispatchEvent(new Event('change', { bubbles: true }));

      expect(optionsMod.getSelectedCustomProviderMode()).toBe('api');
      expect(optionsMod.getSelectedCustomProviderKind()).toBe('api');
      expect(nameInput.placeholder).toBe('Ollama / OpenRouter');
      expect(urlLabel.textContent).toBe('Base URL or Chat Completions URL');
      expect(urlInput.placeholder).toBe('https://openrouter.ai/api/v1 or http://localhost:11434/v1');
      expect(modeHint.textContent).toContain('Ollama works with no CORS setup');
      expect(apiNote.hidden).toBe(false);
      const apiChips = Array.from(
        document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')
      );
      expect(apiChips.map((el) => el.textContent)).toEqual([
        'Magpie',
        'Ollama (local)',
        'LM Studio',
        'OpenRouter',
        'DeepSeek API',
      ]);

      // Clicking first API chip (Magpie) populates fields, clears errors, updates endpoint preview, and focuses model input
      document.getElementById('custom-provider-error').hidden = false;
      document.getElementById('custom-provider-error').textContent = 'Previous error';
      apiChips[0].click();
      expect(nameInput.value).toBe('Magpie');
      expect(urlInput.value).toBe('http://127.0.0.1:3425/v1');
      expect(document.getElementById('custom-provider-origin-preview').textContent).toContain(
        'http://127.0.0.1:3425/v1/chat/completions'
      );
      expect(document.getElementById('custom-provider-error').hidden).toBe(true);
      expect(document.activeElement).toBe(document.getElementById('custom-provider-model'));

      // Clicking Ollama chip also populates fields cleanly
      apiChips[1].click();
      expect(nameInput.value).toBe('Ollama');
      expect(urlInput.value).toBe('http://localhost:11434/v1');
      expect(document.getElementById('custom-provider-origin-preview').textContent).toContain(
        'http://localhost:11434/v1/chat/completions'
      );
    });

    it('uses the Chinese setup guide URL and localized zh_CN quick-fill presets when UI language is zh_CN', async () => {
      installOptionsChromeEnv({
        syncInitial: { language: 'zh_CN' },
        uiLanguage: 'zh_CN',
      });
      await import('../options/options.js');
      await vi.waitFor(() => {
        expect(document.getElementById('version')?.textContent).toContain('2.2.0');
        expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
        expect(document.getElementById('custom-provider-guide-link').getAttribute('href')).toBe(
          'https://panelize.dev/zh/guides/add-custom-ai-and-api/'
        );
      });

      const webChips = Array.from(
        document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')
      );
      expect(webChips.map((el) => el.textContent)).toEqual([
        'Perplexity',
        '秘塔AI搜索',
        'Poe',
        'Mistral Le Chat',
      ]);
      webChips[1].click();
      expect(document.getElementById('custom-provider-name').value).toBe('秘塔AI搜索');
      expect(document.getElementById('custom-provider-url').value).toBe('https://metaso.cn');

      // Switching connection mode clears chip-applied name/url so previous mode's URL doesn't stick
      const apiRadio = document.getElementById('custom-provider-kind-api');
      apiRadio.checked = true;
      apiRadio.dispatchEvent(new Event('change', { bubbles: true }));
      expect(document.getElementById('custom-provider-name').value).toBe('');
      expect(document.getElementById('custom-provider-url').value).toBe('');

      const apiChips = Array.from(
        document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')
      );
      expect(apiChips.map((el) => el.textContent)).toEqual([
        'Magpie',
        'Ollama（本地）',
        '硅基流动',
        'DeepSeek API',
        'OpenRouter',
      ]);
      apiChips[0].click();
      expect(document.getElementById('custom-provider-name').value).toBe('Magpie');
      expect(document.getElementById('custom-provider-url').value).toBe('http://127.0.0.1:3425/v1');
      apiChips[2].click();
      expect(document.getElementById('custom-provider-name').value).toBe('硅基流动');
      expect(document.getElementById('custom-provider-url').value).toBe('https://api.siliconflow.cn/v1');

      // User-typed custom values are preserved when switching connection modes
      document.getElementById('custom-provider-name').value = 'My Custom Gateway';
      document.getElementById('custom-provider-url').value = 'https://gateway.example.com/v1';
      const webLocalRadio = document.getElementById('custom-provider-kind-web-local');
      webLocalRadio.checked = true;
      webLocalRadio.dispatchEvent(new Event('change', { bubbles: true }));
      expect(document.getElementById('custom-provider-name').value).toBe('My Custom Gateway');
      expect(document.getElementById('custom-provider-url').value).toBe('https://gateway.example.com/v1');
    });

    it('wires accessible group label on #custom-provider-examples and mode-hint description on #custom-provider-url', async () => {
      installOptionsChromeEnv();
      await import('../options/options.js');
      await vi.waitFor(() => {
        expect(document.getElementById('version')?.textContent).toContain('2.2.0');
      });

      const examplesGroup = document.getElementById('custom-provider-examples');
      expect(examplesGroup.getAttribute('role')).toBe('group');
      expect(examplesGroup.getAttribute('aria-labelledby')).toBe('custom-provider-examples-label');
      expect(document.getElementById('custom-provider-examples-label')?.textContent).toBe('Quick fill:');

      const urlInput = document.getElementById('custom-provider-url');
      expect(urlInput.getAttribute('aria-describedby')?.split(/\s+/)).toContain(
        'custom-provider-mode-hint'
      );
    });

    it('disables quick-fill chips when scoped frame rules are unsupported', async () => {
      installOptionsChromeEnv({ scopedFrameRules: false });
      await import('../options/options.js');
      await vi.waitFor(() => {
        expect(document.getElementById('version')?.textContent).toContain('2.2.0');
        expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
        const chips = Array.from(
          document.querySelectorAll('#custom-provider-examples .custom-provider-example-chip')
        );
        expect(chips.length).toBeGreaterThan(0);
        expect(chips.every((chip) => chip.disabled)).toBe(true);
      });
    });

    it('scrolls, focuses #custom-provider-name, highlights #custom-provider-card, strips #custom-provider-card via history.replaceState, and respects prefers-reduced-motion', async () => {
      window.history.replaceState(null, '', '/options/options.html?tab=providers#custom-provider-card');
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
      installOptionsChromeEnv();

      const card = document.getElementById('custom-provider-card');
      card.scrollIntoView = vi.fn();

      await import('../options/options.js');
      await vi.waitFor(() => {
        expect(document.getElementById('version')?.textContent).toContain('2.2.0');
        expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
        expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
      });

      expect(card.classList.contains('custom-provider-card--highlight')).toBe(true);
      expect(document.activeElement).toBe(document.getElementById('custom-provider-name'));
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/options/options.html?tab=providers');
      expect(window.location.hash).toBe('');

      vi.useFakeTimers();
      // Clicking jump button re-applies highlight, scrolls, focuses name input, and clears highlight after timer
      document.getElementById('jump-add-custom-provider-btn').focus();
      document.getElementById('jump-add-custom-provider-btn').click();
      expect(card.classList.contains('custom-provider-card--highlight')).toBe(true);
      expect(document.activeElement).toBe(document.getElementById('custom-provider-name'));

      vi.advanceTimersByTime(2500);
      expect(card.classList.contains('custom-provider-card--highlight')).toBe(false);

      // Re-navigating to #custom-provider-card (simulating chrome.tabs.update reusing Options tab)
      // fires hashchange, respects prefers-reduced-motion, and strips #custom-provider-card again
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn((query) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      try {
        replaceStateSpy.mockClear();
        card.scrollIntoView.mockClear();
        document.getElementById('jump-add-custom-provider-btn').focus();
        window.location.hash = '#custom-provider-card';
        window.dispatchEvent(new Event('hashchange'));
        expect(card.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'auto' });
        expect(card.classList.contains('custom-provider-card--highlight')).toBe(true);
        expect(document.activeElement).toBe(document.getElementById('custom-provider-name'));
        expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/options/options.html?tab=providers');
        expect(window.location.hash).toBe('');
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  describe('Multi-Panel + and ⇄ menu Custom AI footer & openCustomProviderSettings()', () => {
    function installMultiPanelChrome({
      localInitial = {},
      syncInitial = {},
      tabsQueryResult = [],
    } = {}) {
      const storageListeners = [];
      const areas = {
        local: cloneValue(localInitial),
        sync: cloneValue(syncInitial),
      };

      chrome.runtime.id = 'panelize-test-extension-id';
      chrome.runtime.getURL = vi.fn(
        (path) => `chrome-extension://panelize-test-extension-id/${String(path).replace(/^\//, '')}`
      );
      chrome.runtime.sendMessage = vi.fn(() => Promise.resolve({ success: true }));
      chrome.runtime.openOptionsPage = vi.fn(() => Promise.resolve());
      chrome.runtime.onMessage = {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      };

      chrome.storage.local = makeStorageArea(areas, 'local', storageListeners);
      chrome.storage.sync = makeStorageArea(areas, 'sync', storageListeners);
      chrome.storage.session = {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      };
      chrome.storage.onChanged = {
        addListener: vi.fn((fn) => storageListeners.push(fn)),
        removeListener: vi.fn(),
      };

      chrome.permissions = {
        contains: vi.fn(() => Promise.resolve(true)),
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      };

      chrome.tabs = {
        query: vi.fn(() => Promise.resolve(tabsQueryResult)),
        update: vi.fn(() => Promise.resolve({})),
        create: vi.fn(() => Promise.resolve({})),
      };
      chrome.windows = {
        getCurrent: vi.fn(() => Promise.resolve({ id: 1, type: 'normal' })),
        update: vi.fn(() => Promise.resolve({})),
      };
      chrome.i18n = {
        getUILanguage: vi.fn(() => 'en'),
        getMessage: vi.fn((key) => EN_MESSAGES[key]?.message || ''),
      };

      globalThis.fetch = vi.fn((url) => {
        if (String(url).includes('_locales/en/messages.json')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(EN_MESSAGES),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      });
    }

    beforeEach(() => {
      vi.resetModules();
      vi.restoreAllMocks();
      if (window.happyDOM?.settings?.navigation) {
        window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
      }
      resetExtraProviderDescriptors();
      setCustomProviderDescriptors([]);
      document.documentElement.setAttribute('data-theme', 'light');
      document.body.innerHTML = MULTI_PANEL_BODY_HTML;
    });

    it('opens .add-panel-menu with muted status row + Custom AI action when all enabled providers are already open, and creates a deep-linked Options tab', async () => {
      installMultiPanelChrome({
        syncInitial: {
          enabledProviders: ['chatgpt'],
          defaultLayout: '1x1',
        },
        localInitial: {
          multiPanelProviders: ['chatgpt'],
          currentLayout: '1x1',
        },
        tabsQueryResult: [],
      });

      await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.panel-item')).toHaveLength(1);
      });

      document.getElementById('add-panel-btn').click();
      await vi.waitFor(() => {
        expect(document.querySelector('.add-panel-menu')).not.toBeNull();
      });

      // No toast saying 'All providers are already in use'
      expect(document.querySelector('.panelize-toast')).toBeNull();

      const addMenu = document.querySelector('.add-panel-menu');
      expect(addMenu.getAttribute('role')).toBe('menu');
      expect(addMenu.querySelectorAll('.add-panel-item')).toHaveLength(0);
      const emptyNote = addMenu.querySelector('.menu-all-providers-open');
      expect(emptyNote?.textContent).toBe('All enabled AIs are already open');
      expect(emptyNote?.getAttribute('role')).toBeNull();
      expect(emptyNote?.getAttribute('aria-disabled')).toBe('true');

      const actionBtn = addMenu.querySelector('.menu-custom-ai-action');
      expect(actionBtn).not.toBeNull();
      expect(actionBtn.getAttribute('role')).toBe('menuitem');
      expect(actionBtn.getAttribute('tabindex')).toBe('-1');
      expect(document.activeElement).toBe(actionBtn);
      expect(actionBtn.classList.contains('add-panel-item')).toBe(false);
      expect(actionBtn.querySelector('.menu-custom-ai-label')?.textContent).toBe(
        'Add custom AI / More providers…'
      );
      expect(actionBtn.querySelector('.menu-custom-ai-hint')?.textContent).toBe(
        'Perplexity, Poe, Ollama, API…'
      );

      chrome.tabs.create.mockResolvedValueOnce({ id: 99, windowId: 5 });
      actionBtn.click();
      expect(document.querySelector('.add-panel-menu')).toBeNull();
      await vi.waitFor(() => {
        expect(chrome.tabs.create).toHaveBeenCalledWith({
          url: 'chrome-extension://panelize-test-extension-id/options/options.html#custom-provider-card',
        });
        expect(chrome.windows.update).toHaveBeenCalledWith(5, { focused: true });
      });
    });

    it('supports full keyboard navigation (ArrowDown, ArrowUp, Home, End, Escape, Enter) on + and ⇄ menus', async () => {
      installMultiPanelChrome({
        syncInitial: {
          enabledProviders: ['chatgpt', 'claude', 'gemini'],
          multiPanelLayout: '1x1',
        },
        localInitial: {
          multiPanelProviders: ['chatgpt'],
          currentLayout: '1x1',
        },
        tabsQueryResult: [],
      });

      await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('.panel-item')).toHaveLength(1);
      });

      // 1. Add-panel menu (+) keyboard navigation + Escape restores focus to #add-panel-btn
      const addBtn = document.getElementById('add-panel-btn');
      addBtn.focus();
      addBtn.click();
      await vi.waitFor(() => {
        expect(document.querySelector('.add-panel-menu')).not.toBeNull();
      });

      const addMenu = document.querySelector('.add-panel-menu');
      expect(addMenu.getAttribute('role')).toBe('menu');
      const addItems = Array.from(addMenu.querySelectorAll('[role="menuitem"]'));
      // Available providers ('claude', 'gemini') + footer Custom AI button = 3 menuitems
      expect(addItems).toHaveLength(3);
      expect(addItems.every((el) => el.getAttribute('tabindex') === '-1')).toBe(true);
      expect(document.activeElement).toBe(addItems[0]);

      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(addItems[1]);

      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(addItems[2]);
      expect(document.activeElement.classList.contains('menu-custom-ai-action')).toBe(true);

      // Wrap around from last to first
      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(document.activeElement).toBe(addItems[0]);

      // Wrap around backwards from first to last
      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(document.activeElement).toBe(addItems[2]);

      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      expect(document.activeElement).toBe(addItems[0]);

      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      expect(document.activeElement).toBe(addItems[2]);

      addMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(document.querySelector('.add-panel-menu')).toBeNull();
      expect(document.activeElement).toBe(addBtn);
      expect(addBtn.getAttribute('aria-expanded')).toBe('false');

      // 2. Provider switcher menu (⇄) keyboard navigation + Enter activates footer Custom AI item
      const switchBtn = document.querySelector('.panel-item .switch-provider-btn');
      switchBtn.focus();
      switchBtn.click();
      await vi.waitFor(() => {
        expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
      });

      const switchMenu = document.querySelector('.provider-switcher-menu');
      expect(switchMenu.getAttribute('role')).toBe('menu');
      const switchItems = Array.from(switchMenu.querySelectorAll('[role="menuitem"]'));
      // 3 enabled providers + footer Custom AI button = 4 menuitems
      expect(switchItems).toHaveLength(4);
      expect(document.activeElement).toBe(switchItems[0]);

      switchMenu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      expect(document.activeElement).toBe(switchItems[3]);
      expect(document.activeElement.classList.contains('menu-custom-ai-action')).toBe(true);

      chrome.tabs.create.mockClear();
      switchItems[3].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      expect(document.querySelector('.provider-switcher-menu')).toBeNull();
      await vi.waitFor(() => {
        expect(chrome.tabs.create).toHaveBeenCalledWith({
          url: 'chrome-extension://panelize-test-extension-id/options/options.html#custom-provider-card',
        });
      });
    });

    it('renders .menu-custom-ai-action in showProviderSwitcher (⇄) and reuses an existing Options tab when present', async () => {
      installMultiPanelChrome({
        syncInitial: {
          enabledProviders: ['chatgpt', 'claude'],
          defaultLayout: '1x1',
        },
        localInitial: {
          multiPanelProviders: ['chatgpt'],
          currentLayout: '1x1',
        },
        tabsQueryResult: [{ id: 42, windowId: 7, url: 'chrome-extension://panelize-test-extension-id/options/options.html' }],
      });

      const mpMod = await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelector('.panel-item .switch-provider-btn')).not.toBeNull();
      });

      document.querySelector('.panel-item .switch-provider-btn').click();
      await vi.waitFor(() => {
        expect(document.querySelector('.provider-switcher-menu')).not.toBeNull();
      });

      const switchMenu = document.querySelector('.provider-switcher-menu');
      expect(switchMenu.querySelectorAll('.provider-switcher-item')).toHaveLength(2);
      const footerAction = switchMenu.querySelector('.menu-custom-ai-action');
      expect(footerAction).not.toBeNull();
      expect(footerAction.classList.contains('provider-switcher-item')).toBe(false);

      footerAction.click();
      expect(document.querySelector('.provider-switcher-menu')).toBeNull();
      await vi.waitFor(() => {
        expect(chrome.tabs.update).toHaveBeenCalledWith(42, {
          url: 'chrome-extension://panelize-test-extension-id/options/options.html#custom-provider-card',
          active: true,
        });
      });
      expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
      expect(chrome.tabs.create).not.toHaveBeenCalled();

      // Primary MV3 path without "tabs" permission: chrome.runtime.getContexts
      chrome.tabs.query = vi.fn(() => Promise.resolve([]));
      chrome.tabs.update.mockClear();
      chrome.windows.update.mockClear();
      chrome.runtime.getContexts = vi.fn(() =>
        Promise.resolve([
          {
            contextType: 'TAB',
            frameId: 0,
            tabId: 88,
            windowId: 9,
            documentUrl: 'chrome-extension://panelize-test-extension-id/options/options.html',
          },
        ])
      );
      await mpMod.openCustomProviderSettings();
      expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'] });
      expect(chrome.tabs.update).toHaveBeenCalledWith(88, {
        url: 'chrome-extension://panelize-test-extension-id/options/options.html#custom-provider-card',
        active: true,
      });
      expect(chrome.windows.update).toHaveBeenCalledWith(9, { focused: true });

      // Fallback when chrome.tabs is unavailable
      delete chrome.tabs;
      await mpMod.openCustomProviderSettings();
      expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    });
  });
});
