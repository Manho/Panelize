import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initApiPanel } from '../api-panel/api-panel.js';
import {
  API_PANEL_CONTEXT,
  API_PANEL_MESSAGES,
  createCustomApiHostBridge,
} from '../modules/custom-api-bridge.js';
import {
  getCustomApiKey,
  resetCustomApiSecretsDbForTests,
  saveCustomApiKey,
} from '../modules/custom-api-secrets.js';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import {
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';
import { exportSettings } from '../modules/settings.js';
import { createMockIndexedDB } from './helpers/mock-indexeddb.js';

const ROOT = process.cwd();
const LOCALES_DIR = resolve(ROOT, '_locales');
const EN_MESSAGES = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en/messages.json'), 'utf8'));
const EXTENSION_ID = 'panelizeapitestextensionid';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

function extractBodyInnerHtml(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error(`Could not extract <body> from ${filePath}`);
  }
  return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

const OPTIONS_BODY_HTML = extractBodyInnerHtml(resolve(ROOT, 'options/options.html'));
const API_PANEL_BODY_HTML = extractBodyInnerHtml(resolve(ROOT, 'api-panel/api-panel.html'));

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function installOptionsChromeEnv({
  localInitial = {},
  syncInitial = {},
  scopedFrameRules = true,
  grantedOrigins = [],
} = {}) {
  const areas = {
    local: cloneValue(localInitial),
    sync: cloneValue(syncInitial),
  };
  const storageListeners = [];
  const permissionAddedListeners = [];
  const permissionRemovedListeners = [];
  const grantedSet = new Set(grantedOrigins);

  const makeArea = (areaName) => ({
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
  });

  chrome.runtime.id = EXTENSION_ID;
  chrome.runtime.getURL = vi.fn(
    (path = '') => `${EXTENSION_ORIGIN}/${String(path).replace(/^\/+/, '')}`
  );
  chrome.runtime.getManifest = vi.fn(() => ({ version: '2.1.0' }));
  chrome.declarativeNetRequest = scopedFrameRules
    ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } }
    : {};

  chrome.storage.local = makeArea('local');
  chrome.storage.sync = makeArea('sync');
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
    onAdded: {
      addListener: vi.fn((fn) => permissionAddedListeners.push(fn)),
    },
    onRemoved: {
      addListener: vi.fn((fn) => permissionRemovedListeners.push(fn)),
    },
  };

  chrome.management = {
    getSelf: vi.fn(() => Promise.resolve({ installType: 'normal' })),
  };

  chrome.i18n = {
    getUILanguage: vi.fn(() => 'en'),
    getMessage: vi.fn((key, substitutions = null) => {
      const entry = EN_MESSAGES[key];
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
    if (str.includes('_locales/en/messages.json')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(EN_MESSAGES),
      });
    }
    if (str.includes('version-info.json')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: '2.1.0' }),
      });
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve([]),
    });
  });

  return { areas, grantedSet };
}

describe('M3 Custom API Options UI, secret isolation, and built-in API comparison panel', () => {
  const originalIndexedDB = globalThis.indexedDB;

  beforeEach(() => {
    vi.restoreAllMocks();
    resetExtraProviderDescriptors();
    setCustomProviderDescriptors([]);
    resetCustomApiSecretsDbForTests();
    globalThis.indexedDB = createMockIndexedDB();
    document.documentElement.setAttribute('data-theme', 'light');
    document.body.innerHTML = '';
  });

  afterEach(() => {
    resetCustomApiSecretsDbForTests();
    globalThis.indexedDB = originalIndexedDB;
    resetExtraProviderDescriptors();
    setCustomProviderDescriptors([]);
    delete globalThis.fetch;
  });

  it('ships all 28 Custom API, Custom AI Edit, and Model Picker locale strings across all 10 locales', () => {
    const locales = readdirSync(LOCALES_DIR).sort();
    expect(locales).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'zh_CN', 'zh_TW']);

    const API_KEYS = [
      'labelCustomProviderKind',
      'optionCustomProviderKindWeb',
      'optionCustomProviderKindApi',
      'labelCustomApiEndpointUrl',
      'placeholderCustomApiEndpointUrl',
      'labelCustomProviderModel',
      'placeholderCustomProviderModel',
      'labelCustomProviderApiKey',
      'placeholderCustomProviderApiKey',
      'btnShowApiKey',
      'btnHideApiKey',
      'noteCustomApiLocalOnly',
      'msgCustomApiEndpointPreview',
      'errCustomModelRequired',
      'errCustomModelTooLong',
      'errCustomApiKeyTooLong',
      'ariaEditCustomProvider',
      'headingEditCustomProvider',
      'btnSaveCustomProvider',
      'placeholderCustomProviderApiKeyKeepExisting',
      'labelClearSavedApiKey',
      'msgCustomProviderUpdated',
      'btnLoadModels',
      'btnRefreshModels',
      'msgModelsLoading',
      'msgModelsLoadedCount',
      'msgModelsNoMatch',
      'errModelsLoadFailed',
    ];

    for (const locale of locales) {
      const dict = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
      for (const key of API_KEYS) {
        expect(dict[key]?.message?.trim(), `${locale}.${key}`).toBeTruthy();
      }
      expect(dict.msgCustomApiEndpointPreview.message, `${locale}.msgCustomApiEndpointPreview`).toContain('$1');
      expect(dict.msgCustomApiEndpointPreview.message, `${locale}.msgCustomApiEndpointPreview`).toContain('$2');
      expect(dict.ariaEditCustomProvider.message, `${locale}.ariaEditCustomProvider`).toContain('$1');
      expect(dict.msgCustomProviderUpdated.message, `${locale}.msgCustomProviderUpdated`).toContain('$1');
      expect(dict.msgModelsLoadedCount.message, `${locale}.msgModelsLoadedCount`).toContain('$1');
      expect(dict.errModelsLoadFailed.message, `${locale}.errModelsLoadFailed`).toContain('$1');
    }
  });

  it('toggles API form fields & password visibility, requests permission synchronously, isolates API keys in IndexedDB, and retains shared-origin permissions on partial delete', async () => {
    vi.resetModules();
    globalThis.indexedDB = createMockIndexedDB();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas, grantedSet } = installOptionsChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
        providerOrder: ['chatgpt'],
      },
    });

    await import('../options/options.js');
    const secretsMod = await import('../modules/custom-api-secrets.js');

    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.getElementById('version')?.textContent).toContain('2.1.0');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    const kindWeb = document.getElementById('custom-provider-kind-web');
    const kindApi = document.getElementById('custom-provider-kind-api');
    const apiFields = document.getElementById('custom-provider-api-fields');
    const apiNote = document.getElementById('custom-provider-api-note');
    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const modelInput = document.getElementById('custom-provider-model');
    const apiKeyInput = document.getElementById('custom-provider-api-key');
    const apiKeyToggle = document.getElementById('custom-provider-api-key-toggle');
    const preview = document.getElementById('custom-provider-origin-preview');
    const form = document.getElementById('custom-provider-form');

    expect(kindWeb.checked).toBe(true);
    expect(apiFields.hidden).toBe(true);
    expect(apiNote.hidden).toBe(true);

    // Switch to OpenAI-compatible API
    kindApi.checked = true;
    kindApi.dispatchEvent(new Event('change', { bubbles: true }));
    expect(apiFields.hidden).toBe(false);
    expect(apiNote.hidden).toBe(false);

    // Password reveal toggle updates aria-pressed and input type
    expect(apiKeyInput.type).toBe('password');
    expect(apiKeyToggle.getAttribute('aria-pressed')).toBe('false');
    apiKeyToggle.click();
    expect(apiKeyInput.type).toBe('text');
    expect(apiKeyToggle.getAttribute('aria-pressed')).toBe('true');
    apiKeyToggle.click();
    expect(apiKeyInput.type).toBe('password');
    expect(apiKeyToggle.getAttribute('aria-pressed')).toBe('false');

    // Fill first API model on localhost:11434 with an API key
    nameInput.value = 'Ollama Alpha';
    urlInput.value = 'http://localhost:11434';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(preview.hidden).toBe(false);
    expect(preview.textContent).toContain('http://localhost:11434');
    expect(preview.textContent).toContain('http://localhost:11434/v1/chat/completions');

    modelInput.value = 'llama3.3:70b';
    apiKeyInput.value = 'sk-secret-alpha-only-local';

    let microtaskTicked = false;
    let calledSync = false;
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      calledSync = !microtaskTicked;
      origins.forEach((o) => grantedSet.add(o));
      return Promise.resolve(true);
    });
    Promise.resolve().then(() => {
      microtaskTicked = true;
    });

    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(calledSync).toBe(true);

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
    });

    const alphaRecord = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0];
    expect(alphaRecord).toMatchObject({
      kind: 'api',
      name: 'Ollama Alpha',
      endpointUrl: 'http://localhost:11434/v1/chat/completions',
      model: 'llama3.3:70b',
      hasApiKey: true,
    });
    expect('apiKey' in alphaRecord).toBe(false);

    // Secret isolation checks: NEVER in storage.local, storage.sync, or exported backup JSON!
    expect(JSON.stringify(areas.local)).not.toContain('sk-secret-alpha-only-local');
    expect(JSON.stringify(areas.sync)).not.toContain('sk-secret-alpha-only-local');
    const exported = await exportSettings();
    expect(JSON.stringify(exported)).not.toContain('sk-secret-alpha-only-local');
    expect(await secretsMod.getCustomApiKey(alphaRecord.id)).toBe('sk-secret-alpha-only-local');

    // Verify rendered row has both origin badge and model badge
    await vi.waitFor(() => {
      const row = document.querySelector(
        `#provider-list .provider-item[data-provider-id="${alphaRecord.id}"]`
      );
      expect(row).not.toBeNull();
      expect(row.querySelector('.provider-origin-badge')?.textContent).toBe(
        'http://localhost:11434'
      );
      expect(row.querySelector('.provider-model-badge')?.textContent).toBe('llama3.3:70b');
    });

    // Add second API model on the SAME origin without an API key
    nameInput.value = 'Ollama Beta';
    urlInput.value = 'http://localhost:11434/v1';
    modelInput.value = 'qwen2.5-coder:32b';
    apiKeyInput.value = '';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(2);
    });
    const betaRecord = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][1];
    expect(betaRecord.hasApiKey).toBe(false);
    expect(await secretsMod.getCustomApiKey(betaRecord.id)).toBeNull();

    // Deleting Ollama Alpha removes its IndexedDB key, but RETAINS localhost:11434/* permission for Ollama Beta!
    chrome.permissions.remove.mockClear();
    const alphaRow = document.querySelector(
      `#provider-list .provider-item[data-provider-id="${alphaRecord.id}"]`
    );
    alphaRow.querySelector('[data-action="delete-custom-provider"]').click();
    alphaRow.querySelector('[data-action="confirm-delete-custom-provider"]').click();

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
      expect(
        document.querySelector(`#provider-list .provider-item[data-provider-id="${alphaRecord.id}"]`)
      ).toBeNull();
    });
    expect(await secretsMod.getCustomApiKey(alphaRecord.id)).toBeNull();
    expect(chrome.permissions.remove).not.toHaveBeenCalled();
    expect(grantedSet.has('http://localhost:11434/*')).toBe(true);

    // Deleting Ollama Beta now revokes localhost:11434/* because no provider uses that origin anymore
    await vi.waitFor(() => {
      const betaRow = document.querySelector(
        `#provider-list .provider-item[data-provider-id="${betaRecord.id}"]`
      );
      expect(betaRow).not.toBeNull();
    });
    const betaRow = document.querySelector(
      `#provider-list .provider-item[data-provider-id="${betaRecord.id}"]`
    );
    betaRow.querySelector('[data-action="delete-custom-provider"]').click();
    betaRow.querySelector('[data-action="confirm-delete-custom-provider"]').click();

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(0);
      expect(chrome.permissions.remove).toHaveBeenCalledWith({
        origins: ['http://localhost:11434/*'],
      });
    });
  });

  it('rolls back IndexedDB API key, local customProviders record, and unused permission if sync.set fails during add', async () => {
    vi.resetModules();
    globalThis.indexedDB = createMockIndexedDB();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas, grantedSet } = installOptionsChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
        providerOrder: ['chatgpt'],
      },
    });

    await import('../options/options.js');
    const secretsMod = await import('../modules/custom-api-secrets.js');

    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.getElementById('version')?.textContent).toContain('2.1.0');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    const kindApi = document.getElementById('custom-provider-kind-api');
    kindApi.checked = true;
    kindApi.dispatchEvent(new Event('change', { bubbles: true }));

    document.getElementById('custom-provider-name').value = 'Broken Sync API';
    document.getElementById('custom-provider-url').value = 'https://api.example.com/v1';
    document.getElementById('custom-provider-model').value = 'gpt-4o-mini';
    document.getElementById('custom-provider-api-key').value = 'sk-rollback-secret';

    // Make sync.set fail on the add submission
    chrome.storage.sync.set.mockRejectedValueOnce(new Error('Sync quota exceeded'));

    document
      .getElementById('custom-provider-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      const errEl = document.getElementById('custom-provider-error');
      expect(errEl?.hidden).toBe(false);
    });

    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY] || []).toEqual([]);
    expect(grantedSet.has('https://api.example.com/*')).toBe(false);

    // Ensure no orphaned secret remains in IndexedDB
    const db = await new Promise((res, rej) => {
      const req = globalThis.indexedDB.open('PanelizeCustomApiSecretsDB');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = db.transaction('apiSecrets', 'readonly');
    const getAllKeys = await new Promise((res, rej) => {
      const req = tx.objectStore('apiSecrets').getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    expect(getAllKeys).toEqual([]);
    expect(await secretsMod.getCustomApiKey('custom-0000000000')).toBeNull();
  });

  it('loads and filters /models in Add custom AI form, auto-fills empty Name on selection, falls back cleanly on 404, and revokes unused probed permissions', async () => {
    vi.resetModules();
    globalThis.indexedDB = createMockIndexedDB();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas, grantedSet } = installOptionsChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
        providerOrder: ['chatgpt'],
      },
    });

    const modelsPayloads = new Map([
      [
        'https://openrouter.ai/api/v1/models',
        {
          status: 200,
          body: {
            data: [
              { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o Mini' },
              { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek: DeepSeek V3.2' },
              { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek: R1 (free)' },
              { id: 'qwen/qwen2.5-coder-32b', name: 'Qwen: Qwen2.5 Coder 32B' },
            ],
          },
        },
      ],
      [
        'https://nomodels.example.com/v1/models',
        {
          status: 404,
          body: { error: { message: 'Route /v1/models not implemented' } },
        },
      ],
    ]);

    const seenAuthHeaders = [];
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init = {}) => {
      const str = String(url);
      if (modelsPayloads.has(str)) {
        seenAuthHeaders.push({ url: str, auth: init.headers?.Authorization || null });
        const mockEntry = modelsPayloads.get(str);
        return Promise.resolve(
          new Response(JSON.stringify(mockEntry.body), {
            status: mockEntry.status,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return baseFetch(url, init);
    });

    await import('../options/options.js');

    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.getElementById('version')?.textContent).toContain('2.1.0');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    // Quick-jump button focuses Add custom AI Name input
    document.getElementById('jump-add-custom-provider-btn').click();
    expect(document.activeElement).toBe(document.getElementById('custom-provider-name'));

    const kindApi = document.getElementById('custom-provider-kind-api');
    kindApi.checked = true;
    kindApi.dispatchEvent(new Event('change', { bubbles: true }));

    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const modelInput = document.getElementById('custom-provider-model');
    const loadModelsBtn = document.getElementById('custom-provider-load-models-btn');
    const listbox = document.getElementById('custom-provider-model-listbox');
    const countBadge = document.getElementById('custom-provider-model-count');
    const hintEl = document.getElementById('custom-provider-model-hint');
    const apiKeyInput = document.getElementById('custom-provider-api-key');
    const form = document.getElementById('custom-provider-form');

    // 1. Endpoint returning HTTP 404 shows non-blocking hint and still allows manual typing
    urlInput.value = 'https://nomodels.example.com/v1';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    loadModelsBtn.click();

    await vi.waitFor(() => {
      expect(hintEl.hidden).toBe(false);
      expect(hintEl.textContent).toContain('HTTP 404');
      expect(hintEl.textContent).toContain('manually');
    });
    expect(grantedSet.has('https://nomodels.example.com/*')).toBe(true);

    // 2. Switch URL to OpenRouter, invoke Load models synchronously with Bearer key, search & select
    urlInput.value = 'https://openrouter.ai/api/v1';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    apiKeyInput.value = 'sk-or-discover';

    let syncLoadPerm = false;
    let microtaskTick = false;
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      syncLoadPerm = !microtaskTick;
      origins.forEach((o) => grantedSet.add(o));
      return Promise.resolve(true);
    });
    Promise.resolve().then(() => {
      microtaskTick = true;
    });

    loadModelsBtn.click();
    expect(syncLoadPerm).toBe(true);

    await vi.waitFor(() => {
      expect(countBadge.hidden).toBe(false);
      expect(countBadge.textContent).toBe('4 models');
      expect(loadModelsBtn.textContent).toBe('Refresh');
      expect(listbox.hidden).toBe(false);
      expect(listbox.querySelectorAll('[role="option"]')).toHaveLength(4);
    });
    expect(seenAuthHeaders).toContainEqual({
      url: 'https://openrouter.ai/api/v1/models',
      auth: 'Bearer sk-or-discover',
    });

    // Multi-token live search ("deepseek free") narrows options to deepseek/deepseek-r1:free
    modelInput.value = 'deepseek free';
    modelInput.dispatchEvent(new Event('input', { bubbles: true }));
    const filteredOptions = listbox.querySelectorAll('[role="option"]');
    expect(filteredOptions).toHaveLength(1);
    expect(filteredOptions[0].dataset.modelId).toBe('deepseek/deepseek-r1:free');

    // Selecting with Enter fills Model ID, closes listbox without submitting form, and auto-fills empty Name!
    expect(nameInput.value).toBe('');
    modelInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(modelInput.value).toBe('deepseek/deepseek-r1:free');
    expect(listbox.hidden).toBe(true);
    expect(nameInput.value).toBe('DeepSeek: R1 (free)');
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY] || []).toHaveLength(0);

    // Submitting Add saves OpenRouter AND revokes unused probed nomodels.example.com permission!
    chrome.permissions.remove.mockClear();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
    });
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0]).toMatchObject({
      name: 'DeepSeek: R1 (free)',
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-r1:free',
      hasApiKey: true,
    });
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['https://nomodels.example.com/*'],
    });
    expect(grantedSet.has('https://openrouter.ai/*')).toBe(true);
  });

  it('edits custom API & Web providers inline inside their row with icon-only controls, auto-loaded /models combobox, secret isolation, keep/replace/remove API key, stale permission revocation, and focus restoration', async () => {
    vi.resetModules();
    globalThis.indexedDB = createMockIndexedDB();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas, grantedSet } = installOptionsChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
        providerOrder: ['chatgpt'],
      },
    });

    const seenModelsRequests = [];
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init = {}) => {
      const str = String(url);
      if (str === 'http://localhost:11434/v1/models') {
        seenModelsRequests.push({ url: str, auth: init.headers?.Authorization || null });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                { id: 'llama3.3:70b', name: 'Llama 3.3 70B' },
                { id: 'qwen2.5-coder:32b', name: 'Qwen 2.5 Coder 32B' },
                { id: 'deepseek-r1:14b', name: 'DeepSeek R1 14B' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );
      }
      return baseFetch(url, init);
    });

    await import('../options/options.js');
    const secretsMod = await import('../modules/custom-api-secrets.js');

    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.getElementById('version')?.textContent).toContain('2.1.0');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    const addForm = document.getElementById('custom-provider-form');
    const addFormTitle = document.getElementById('custom-provider-form-title');
    const kindWeb = document.getElementById('custom-provider-kind-web');
    const kindApi = document.getElementById('custom-provider-kind-api');
    const addNameInput = document.getElementById('custom-provider-name');
    const addUrlInput = document.getElementById('custom-provider-url');
    const addModelInput = document.getElementById('custom-provider-model');
    const addApiKeyInput = document.getElementById('custom-provider-api-key');
    const addSubmitBtn = document.getElementById('custom-provider-add-btn');

    // 1. Add an API custom provider with a local IndexedDB secret
    kindApi.checked = true;
    kindApi.dispatchEvent(new Event('change', { bubbles: true }));
    addNameInput.value = 'Local Alpha';
    addUrlInput.value = 'http://localhost:11434';
    addModelInput.value = 'llama3.3:70b';
    addApiKeyInput.value = 'sk-secret-never-in-dom';
    addForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
      expect(addSubmitBtn.disabled).toBe(false);
    });
    const apiRecord = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0];

    // 2. Add a Web UI custom provider
    kindWeb.checked = true;
    kindWeb.dispatchEvent(new Event('change', { bubbles: true }));
    addNameInput.value = 'Self Web';
    addUrlInput.value = 'https://selfchat.example.com/app';
    addForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(2);
      expect(addSubmitBtn.disabled).toBe(false);
      expect(
        document.querySelector(
          `#provider-list .provider-item[data-provider-id="${areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][1].id}"]`
        )
      ).not.toBeNull();
    });
    const webRecord = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][1];

    // 3. Verify compact icon-only Edit & Delete controls on custom rows
    const apiRow = document.querySelector(
      `#provider-list .provider-item[data-provider-id="${apiRecord.id}"]`
    );
    const apiEditBtn = apiRow.querySelector('[data-action="edit-custom-provider"]');
    const apiDeleteBtn = apiRow.querySelector('[data-action="delete-custom-provider"]');
    expect(apiEditBtn).not.toBeNull();
    expect(apiEditBtn.classList.contains('btn-provider-icon')).toBe(true);
    expect(apiEditBtn.textContent).toBe('');
    expect(apiEditBtn.getAttribute('aria-label')).toBe('Edit Local Alpha');
    expect(apiEditBtn.title).toBe('Edit Local Alpha');
    expect(apiEditBtn.getAttribute('aria-expanded')).toBe('false');
    expect(apiDeleteBtn.classList.contains('btn-provider-icon')).toBe(true);
    expect(apiDeleteBtn.textContent).toBe('');
    expect(apiDeleteBtn.getAttribute('aria-label')).toBe('Delete Local Alpha');
    expect(apiRow.getAttribute('draggable')).toBe('true');

    // Click Edit -> mounts inline edit form INSIDE apiRow without mutating bottom Add form!
    apiEditBtn.click();

    expect(addFormTitle.textContent).toBe('Add custom AI');
    expect(addSubmitBtn.textContent).toBe('Add');
    expect(kindWeb.disabled).toBe(false);
    expect(kindApi.disabled).toBe(false);

    expect(apiRow.dataset.editing).toBe('true');
    expect(apiRow.getAttribute('draggable')).toBe('false');
    expect(apiEditBtn.getAttribute('aria-expanded')).toBe('true');

    const inlineForm = apiRow.querySelector('form.custom-provider-inline-edit');
    expect(inlineForm).not.toBeNull();
    const inlineName = inlineForm.querySelector('input[name="customProviderName"]');
    const inlineUrl = inlineForm.querySelector('input[name="customProviderUrl"]');
    const inlineModel = inlineForm.querySelector('input[name="customProviderModel"]');
    const inlineApiKey = inlineForm.querySelector('input[name="customProviderApiKey"]');
    const inlineClearRow = inlineForm.querySelector('.custom-provider-clear-key-row');
    const inlineClearCheckbox = inlineForm.querySelector('input[name="clearCustomProviderApiKey"]');
    const inlineCancelBtn = inlineForm.querySelector('[data-action="cancel-inline-custom-provider"]');
    const inlineSaveBtn = inlineForm.querySelector('[data-action="save-inline-custom-provider"]');
    const inlineListbox = inlineForm.querySelector('[role="listbox"]');
    const inlineModelCount = inlineForm.querySelector('.custom-provider-model-count');

    expect(document.activeElement).toBe(inlineName);
    expect(inlineName.value).toBe('Local Alpha');
    expect(inlineUrl.value).toBe('http://localhost:11434/v1/chat/completions');
    expect(inlineModel.value).toBe('llama3.3:70b');
    expect(inlineSaveBtn.textContent).toBe('Save changes');

    // Stored secret MUST NEVER appear in input value or anywhere in DOM, yet auto-load /v1/models uses it in-memory!
    expect(inlineApiKey.value).toBe('');
    expect(inlineApiKey.placeholder).toBe('Leave blank to keep saved key, or enter a new key');
    expect(inlineClearRow.hidden).toBe(false);
    expect(document.body.innerHTML).not.toContain('sk-secret-never-in-dom');

    await vi.waitFor(() => {
      expect(inlineModelCount.hidden).toBe(false);
      expect(inlineModelCount.textContent).toBe('3 models');
    });
    expect(seenModelsRequests).toContainEqual({
      url: 'http://localhost:11434/v1/models',
      auth: 'Bearer sk-secret-never-in-dom',
    });

    // Focusing inline Model ID opens all 3 models with current model selected; Escape closes listbox first!
    inlineModel.focus();
    expect(inlineListbox.hidden).toBe(false);
    expect(inlineListbox.querySelectorAll('[role="option"]')).toHaveLength(3);
    expect(
      inlineListbox.querySelector('[data-model-id="llama3.3:70b"]')?.getAttribute('aria-selected')
    ).toBe('true');

    inlineModel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(inlineListbox.hidden).toBe(true);
    expect(apiRow.dataset.editing).toBe('true'); // Inline edit stays open after first Escape!

    // 4. Cancel collapses inline edit, restores row draggable="true", and returns focus to row's Edit icon button
    inlineCancelBtn.click();
    expect(apiRow.querySelector('.custom-provider-inline-edit')).toBeNull();
    expect(apiRow.dataset.editing).toBeUndefined();
    expect(apiRow.getAttribute('draggable')).toBe('true');
    expect(apiEditBtn.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(apiEditBtn);

    // 5. Re-open Inline Edit, change Name + Endpoint Origin + Model while keeping saved key
    chrome.permissions.remove.mockClear();
    apiEditBtn.click();
    const editForm2 = apiRow.querySelector('form.custom-provider-inline-edit');
    editForm2.querySelector('input[name="customProviderName"]').value = 'OpenRouter DeepSeek';
    editForm2.querySelector('input[name="customProviderUrl"]').value = 'https://openrouter.ai/api/v1';
    editForm2.querySelector('input[name="customProviderModel"]').value = 'deepseek/deepseek-v4.1-flash';

    let syncPermissionCalled = false;
    let tick = false;
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      syncPermissionCalled = !tick;
      origins.forEach((o) => grantedSet.add(o));
      return Promise.resolve(true);
    });
    Promise.resolve().then(() => {
      tick = true;
    });

    editForm2.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(syncPermissionCalled).toBe(true);

    await vi.waitFor(() => {
      const updated = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY].find((r) => r.id === apiRecord.id);
      expect(updated?.name).toBe('OpenRouter DeepSeek');
      expect(updated?.endpointUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(updated?.model).toBe('deepseek/deepseek-v4.1-flash');
      expect(updated?.hasApiKey).toBe(true);
      expect(updated?.frameRuleId).toBe(apiRecord.frameRuleId);
    });

    // Old unused origin permission (http://localhost:11434/*) was automatically revoked!
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['http://localhost:11434/*'],
    });
    expect(grantedSet.has('https://openrouter.ai/*')).toBe(true);
    expect(await secretsMod.getCustomApiKey(apiRecord.id)).toBe('sk-secret-never-in-dom');
    expect(areas.sync.enabledProviders).toContain(apiRecord.id);

    await vi.waitFor(() => {
      const refreshedRow = document.querySelector(
        `#provider-list .provider-item[data-provider-id="${apiRecord.id}"]`
      );
      expect(refreshedRow.querySelector('.custom-provider-inline-edit')).toBeNull();
      expect(refreshedRow.querySelector('.provider-name')?.textContent).toBe('OpenRouter DeepSeek');
      expect(refreshedRow.querySelector('.provider-origin-badge')?.textContent).toBe(
        'https://openrouter.ai'
      );
      expect(refreshedRow.querySelector('.provider-model-badge')?.textContent).toBe(
        'deepseek/deepseek-v4.1-flash'
      );
    });

    // 6. Edit again to test mutual exclusion between typing a key and "Remove saved API key", then remove key
    const refreshedApiRow = document.querySelector(
      `#provider-list .provider-item[data-provider-id="${apiRecord.id}"]`
    );
    refreshedApiRow.querySelector('[data-action="edit-custom-provider"]').click();
    const editForm3 = refreshedApiRow.querySelector('form.custom-provider-inline-edit');
    const clearChk3 = editForm3.querySelector('input[name="clearCustomProviderApiKey"]');
    const apiKeyIn3 = editForm3.querySelector('input[name="customProviderApiKey"]');

    clearChk3.checked = true;
    clearChk3.dispatchEvent(new Event('change', { bubbles: true }));
    apiKeyIn3.value = 'sk-temp';
    apiKeyIn3.dispatchEvent(new Event('input', { bubbles: true }));
    expect(clearChk3.checked).toBe(false);

    clearChk3.checked = true;
    clearChk3.dispatchEvent(new Event('change', { bubbles: true }));
    expect(apiKeyIn3.value).toBe('');

    editForm3.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      const updated = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY].find((r) => r.id === apiRecord.id);
      expect(updated?.hasApiKey).toBe(false);
    });
    expect(await secretsMod.getCustomApiKey(apiRecord.id)).toBeNull();

    // 7. Edit Web UI custom provider inline on its own origin without false duplicate_custom_origin error
    const webRow = document.querySelector(
      `#provider-list .provider-item[data-provider-id="${webRecord.id}"]`
    );
    webRow.querySelector('[data-action="edit-custom-provider"]').click();
    const webEditForm = webRow.querySelector('form.custom-provider-inline-edit');
    expect(webEditForm).not.toBeNull();
    expect(webEditForm.querySelector('.custom-provider-origin-preview').hidden).toBe(false);

    const webNameIn = webEditForm.querySelector('input[name="customProviderName"]');
    const webUrlIn = webEditForm.querySelector('input[name="customProviderUrl"]');
    webNameIn.value = 'Self Web v2';
    webUrlIn.value = 'https://selfchat.example.com/v2';
    webUrlIn.dispatchEvent(new Event('input', { bubbles: true }));
    webUrlIn.dispatchEvent(new Event('blur'));
    expect(webEditForm.querySelector('.custom-provider-error').hidden).toBe(true);

    webEditForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      const updatedWeb = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY].find(
        (r) => r.id === webRecord.id
      );
      expect(updatedWeb?.name).toBe('Self Web v2');
      expect(updatedWeb?.url).toBe('https://selfchat.example.com/v2');
    });
  });

  it('aborts and rejects stale first-load /models requests when endpoint URL or API key changes before completion', async () => {
    vi.resetModules();
    globalThis.indexedDB = createMockIndexedDB();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    installOptionsChromeEnv({
      grantedOrigins: [
        'https://a.example/*',
        'https://b.example/*',
      ],
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-aaaa111111',
            kind: 'api',
            name: 'Endpoint A',
            endpointUrl: 'https://a.example/v1/chat/completions',
            model: 'initial-model',
            hasApiKey: false,
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'custom-aaaa111111'],
        providerOrder: ['chatgpt', 'custom-aaaa111111'],
      },
    });

    const deferredByUrl = new Map();
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init = {}) => {
      const str = String(url);
      if (str.endsWith('/v1/models')) {
        let resolveFetch;
        const promise = new Promise((resolve) => {
          resolveFetch = resolve;
        });
        deferredByUrl.set(str, { signal: init.signal, auth: init.headers?.Authorization || null, resolveFetch });
        return promise;
      }
      return baseFetch(url, init);
    });

    await import('../options/options.js');

    await vi.waitFor(() => {
      expect(
        document.querySelector('#provider-list .provider-item[data-provider-id="custom-aaaa111111"]')
      ).not.toBeNull();
    });

    // 1. Opening inline edit starts initial auto-load for https://a.example/v1/models (loadedSourceKey is still "")
    const row = document.querySelector(
      '#provider-list .provider-item[data-provider-id="custom-aaaa111111"]'
    );
    row.querySelector('[data-action="edit-custom-provider"]').click();

    const inlineForm = row.querySelector('form.custom-provider-inline-edit');
    const inlineUrl = inlineForm.querySelector('input[name="customProviderUrl"]');
    const inlineModel = inlineForm.querySelector('input[name="customProviderModel"]');
    const inlineApiKey = inlineForm.querySelector('input[name="customProviderApiKey"]');
    const inlineListbox = inlineForm.querySelector('[role="listbox"]');
    const inlineCount = inlineForm.querySelector('.custom-provider-model-count');
    const inlineLoadBtn = inlineForm.querySelector('.btn-load-models');

    await vi.waitFor(() => {
      expect(deferredByUrl.has('https://a.example/v1/models')).toBe(true);
    });
    const reqA = deferredByUrl.get('https://a.example/v1/models');
    expect(reqA.signal.aborted).toBe(false);

    // Edit endpoint from A -> B before A's initial /models response arrives
    inlineUrl.value = 'https://b.example/v1';
    inlineUrl.dispatchEvent(new Event('input', { bubbles: true }));

    expect(reqA.signal.aborted).toBe(true);
    expect(inlineLoadBtn.disabled).toBe(false);
    expect(inlineLoadBtn.textContent).toBe('Load models');

    // Even if transport ignores abort and resolves A with model-from-A, B's editor MUST NOT accept it
    reqA.resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'model-from-A', name: 'Stale Model A' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    expect(inlineCount.hidden).toBe(true);
    expect(inlineListbox.hidden).toBe(true);
    expect(inlineListbox.querySelector('[data-model-id="model-from-A"]')).toBeNull();

    // 2. Load models for B, then change B -> invalid URL while in flight; B's signal aborts immediately
    inlineLoadBtn.click();
    await vi.waitFor(() => {
      expect(deferredByUrl.has('https://b.example/v1/models')).toBe(true);
    });
    const reqB1 = deferredByUrl.get('https://b.example/v1/models');
    expect(reqB1.signal.aborted).toBe(false);

    inlineUrl.value = 'not-a-valid-url';
    inlineUrl.dispatchEvent(new Event('input', { bubbles: true }));
    expect(reqB1.signal.aborted).toBe(true);

    // 3. Load models cleanly for B, then edit API key -> invalidates loaded catalog
    deferredByUrl.delete('https://b.example/v1/models');
    inlineUrl.value = 'https://b.example/v1';
    inlineUrl.dispatchEvent(new Event('input', { bubbles: true }));
    inlineLoadBtn.click();

    await vi.waitFor(() => {
      expect(deferredByUrl.has('https://b.example/v1/models')).toBe(true);
    });
    deferredByUrl.get('https://b.example/v1/models').resolveFetch(
      new Response(JSON.stringify({ data: [{ id: 'model-from-B', name: 'Model B' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await vi.waitFor(() => {
      expect(inlineCount.hidden).toBe(false);
      expect(inlineCount.textContent).toBe('1 models');
      expect(inlineListbox.hidden).toBe(false);
    });

    // Typing a new API key invalidates the previously loaded catalog and closes the listbox
    inlineApiKey.value = 'sk-fresh-b';
    inlineApiKey.dispatchEvent(new Event('input', { bubbles: true }));
    expect(inlineCount.hidden).toBe(true);
    expect(inlineListbox.hidden).toBe(true);
    expect(inlineLoadBtn.textContent).toBe('Load models');
    expect(inlineModel.getAttribute('aria-expanded')).toBe('false');
  });

  describe('api-panel + custom-api-bridge end-to-end JSDOM contract', () => {
    const PROVIDER_ID = 'custom-1122334455';

    function createWiredPanelAndBridge({
      hasApiKey = true,
      apiKeyValue = 'sk-bridge-key',
      permitted = true,
      streamImpl,
      framedTop = false,
    } = {}) {
      const descriptor = toCustomProviderDescriptor(
        {
          id: PROVIDER_ID,
          kind: 'api',
          name: 'DeepSeek API',
          endpointUrl: 'https://api.deepseek.com/v1/chat/completions',
          model: 'deepseek-reasoner',
          hasApiKey,
          frameRuleId: 10000,
          createdAt: 1700000000000,
        },
        { extensionOrigin: EXTENSION_ORIGIN }
      );
      setCustomProviderDescriptors([descriptor]);

      document.body.innerHTML = API_PANEL_BODY_HTML;
      const childDoc = document;
      const childListeners = new Set();
      const hostReceivedMessages = [];
      const hostListeners = new Set();

      const hostWin = {
        addEventListener(type, fn) {
          if (type === 'message') hostListeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'message') hostListeners.delete(fn);
        },
        postMessage(payload, targetOrigin) {
          if (targetOrigin !== EXTENSION_ORIGIN) {
            throw new Error(`Unexpected host targetOrigin: ${targetOrigin}`);
          }
          hostReceivedMessages.push(payload);
          const ev = {
            data: payload,
            origin: EXTENSION_ORIGIN,
            source: childWinProxy,
          };
          for (const listener of [...hostListeners]) {
            listener(ev);
          }
        },
      };
      hostWin.top = framedTop ? {} : hostWin;

      const childWinProxy = {
        location: {
          href: `${EXTENSION_ORIGIN}/api-panel/api-panel.html?providerId=${PROVIDER_ID}&theme=light`,
          search: `?providerId=${PROVIDER_ID}&theme=light`,
        },
        parent: hostWin,
        innerWidth: 600,
        innerHeight: 500,
        CSS: { supports: () => false },
        navigator: window.navigator,
        Event: window.Event,
        KeyboardEvent: window.KeyboardEvent,
        requestAnimationFrame(cb) {
          cb(0);
          return 1;
        },
        cancelAnimationFrame() {},
        addEventListener(type, fn) {
          if (type === 'message') childListeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'message') childListeners.delete(fn);
        },
        dispatchEvent(ev) {
          for (const listener of [...childListeners]) {
            listener(ev);
          }
        },
        postMessage(payload, targetOrigin) {
          if (targetOrigin !== EXTENSION_ORIGIN) {
            throw new Error(`Unexpected child targetOrigin: ${targetOrigin}`);
          }
          const ev = {
            data: payload,
            origin: EXTENSION_ORIGIN,
            source: hostWin,
          };
          for (const listener of [...childListeners]) {
            listener(ev);
          }
        },
      };

      // Give scroll container realistic non-zero geometry for snapshot stitch assertions
      const scrollEl = childDoc.getElementById('messages-scroll');
      Object.defineProperty(scrollEl, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(scrollEl, 'scrollHeight', { value: 900, configurable: true });
      scrollEl.getBoundingClientRect = () => ({
        left: 0,
        top: 40,
        right: 600,
        bottom: 440,
        width: 600,
        height: 400,
      });

      const panelRecord = {
        id: 'panel-1',
        providerId: PROVIDER_ID,
        iframe: { contentWindow: childWinProxy },
      };

      const bridge = createCustomApiHostBridge({
        getPanels: () => [panelRecord],
        getTheme: () => 'light',
        hostWindow: hostWin,
        getApiKey: vi.fn().mockResolvedValue(apiKeyValue),
        checkPermission: vi.fn().mockResolvedValue(permitted),
        streamCompletion: streamImpl,
      });

      const apiPanel = initApiPanel({
        rootWindow: childWinProxy,
        rootDocument: childDoc,
      });

      function sendHostMessage(data, { origin = EXTENSION_ORIGIN, source = hostWin } = {}) {
        childWinProxy.dispatchEvent({
          data,
          origin,
          source,
        });
      }

      return {
        childWin: childWinProxy,
        childDoc,
        hostWin,
        bridge,
        apiPanel,
        hostReceivedMessages,
        sendHostMessage,
      };
    }

    it('completes READY->INIT handshake, multimodal INJECT_TEXT_WITH_IMAGES + TRIGGER_SEND, reasoning + safe Markdown streaming, theme updates, and NEW_CHAT', async () => {
      const capturedRequests = [];
      const streamImpl = vi.fn(async (req) => {
        capturedRequests.push(req);
        req.onDelta({ contentDelta: '', reasoningDelta: 'Step 1: inspect image\n' });
        req.onDelta({
          contentDelta: 'Hello **world**!\n\n<img src=x onerror="window.__pwned=1">',
          reasoningDelta: '',
        });
        return {
          content: 'Hello **world**!\n\n<img src=x onerror="window.__pwned=1">',
          reasoning: 'Step 1: inspect image\n',
          finishReason: 'stop',
        };
      });

      const { childWin, childDoc, bridge, hostReceivedMessages, sendHostMessage, apiPanel } =
        createWiredPanelAndBridge({ streamImpl });

      // Handshake initialized badges and title
      expect(childDoc.getElementById('api-model-badge').textContent).toBe('deepseek-reasoner');
      expect(childDoc.getElementById('api-origin-badge').textContent).toBe(
        'https://api.deepseek.com'
      );

      // Theme update
      bridge.broadcastTheme('dark');
      expect(childDoc.documentElement.getAttribute('data-theme')).toBe('dark');

      // Stage text + image via INJECT_TEXT_WITH_IMAGES (Fill)
      sendHostMessage({
        context: 'multi-panel',
        type: 'INJECT_TEXT_WITH_IMAGES',
        action: 'fill',
        requestId: 'fill-req-1',
        text: 'Compare this diagram',
        autoSubmit: false,
        images: [
          {
            id: 'img-1',
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            name: 'diagram.png',
            type: 'image/png',
          },
        ],
      });

      expect(childDoc.getElementById('composer-input').value).toBe('Compare this diagram');
      expect(childDoc.querySelectorAll('#staged-images .staged-image-item')).toHaveLength(1);
      expect(hostReceivedMessages).toContainEqual({
        context: 'multi-panel-action-result',
        type: 'PANELIZE_ACTION_RESULT',
        requestId: 'fill-req-1',
        provider: PROVIDER_ID,
        action: 'fill',
        status: 'succeeded',
        reason: null,
        succeededImageIds: ['img-1'],
      });

      // Broadcast TRIGGER_SEND
      sendHostMessage({
        context: 'multi-panel',
        type: 'TRIGGER_SEND',
      });

      await vi.waitFor(() => {
        expect(streamImpl).toHaveBeenCalledTimes(1);
        expect(
          childDoc.querySelector('.turn-assistant .turn-actions')?.hidden
        ).toBe(false);
      });

      expect(capturedRequests[0]).toMatchObject({
        endpointUrl: 'https://api.deepseek.com/v1/chat/completions',
        model: 'deepseek-reasoner',
        apiKey: 'sk-bridge-key',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Compare this diagram' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      });

      // Reasoning + safe Markdown rendered without executing raw HTML
      expect(childDoc.querySelector('.thinking-block').hidden).toBe(false);
      expect(childDoc.querySelector('.thinking-content').textContent).toContain(
        'Step 1: inspect image'
      );
      expect(childDoc.querySelector('.turn-markdown strong').textContent).toBe('world');
      expect(childDoc.querySelector('.turn-markdown img')).toBeNull();
      expect(childDoc.querySelector('.turn-markdown').textContent).toContain('<img src=x');
      expect(childWin.__pwned).toBeUndefined();

      // Snapshot prepare / scroll / restore contract
      sendHostMessage({
        context: 'multi-panel',
        type: 'PANELIZE_SNAPSHOT_PREPARE',
        requestId: 'snap-1',
        sessionId: 'sess-1',
        align: true,
        stitch: true,
        hideCursor: true,
        prompt: 'Compare this diagram',
      });

      const snapPrepare = hostReceivedMessages.find(
        (m) => m.type === 'PANELIZE_SNAPSHOT_STATE' && m.requestId === 'snap-1'
      );
      expect(snapPrepare).toMatchObject({
        context: 'multi-panel-snapshot',
        type: 'PANELIZE_SNAPSHOT_STATE',
        requestId: 'snap-1',
        sessionId: 'sess-1',
        provider: PROVIDER_ID,
        alignedBy: 'prompt',
        maxScrollTop: 500,
      });
      expect(snapPrepare.clip.bottom).toBeGreaterThan(snapPrepare.clip.top);

      sendHostMessage({
        context: 'multi-panel',
        type: 'PANELIZE_SNAPSHOT_SCROLL',
        requestId: 'snap-2',
        sessionId: 'sess-1',
        scrollTop: 250,
      });
      expect(
        hostReceivedMessages.find(
          (m) => m.type === 'PANELIZE_SNAPSHOT_STATE' && m.requestId === 'snap-2'
        )?.scrollTop
      ).toBe(250);

      sendHostMessage({
        context: 'multi-panel',
        type: 'PANELIZE_SNAPSHOT_RESTORE',
        requestId: 'snap-3',
        sessionId: 'sess-1',
      });
      expect(childDoc.documentElement.classList.contains('snapshot-capture-active')).toBe(false);

      // NEW_CHAT clears turns in place
      sendHostMessage({
        context: 'multi-panel',
        type: 'NEW_CHAT',
      });
      expect(childDoc.querySelectorAll('.turn-item')).toHaveLength(0);
      expect(childDoc.getElementById('empty-state').hidden).toBe(false);

      // Live metadata sync updates empty-state title, model badge, and origin badge without reload
      const updatedDescriptor = toCustomProviderDescriptor(
        {
          id: PROVIDER_ID,
          kind: 'api',
          name: 'DeepSeek V4 Live',
          endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
          model: 'deepseek/deepseek-v4.1-flash',
          hasApiKey: true,
          frameRuleId: 10000,
          createdAt: 1700000000000,
        },
        { extensionOrigin: EXTENSION_ORIGIN }
      );
      setCustomProviderDescriptors([updatedDescriptor]);
      bridge.syncPanelsMetadata();

      expect(childDoc.getElementById('api-model-badge').textContent).toBe(
        'deepseek/deepseek-v4.1-flash'
      );
      expect(childDoc.getElementById('api-origin-badge').textContent).toBe(
        'https://openrouter.ai'
      );
      expect(childDoc.getElementById('empty-state-title').textContent).toBe(
        'DeepSeek V4 Live · deepseek/deepseek-v4.1-flash'
      );

      apiPanel.destroy();
      bridge.dispose();
    });

    it('guards IME composition on Enter, supports Stop abort & Retry after error, and rejects untrusted origins or framed top windows', async () => {
      let callCount = 0;
      let activeAbortSignal = null;
      const streamImpl = vi.fn(({ signal, onDelta }) => {
        callCount += 1;
        activeAbortSignal = signal;
        if (callCount === 1) {
          onDelta({ contentDelta: 'Partial...', reasoningDelta: '' });
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('Aborted');
              err.name = 'AbortError';
              reject(err);
            });
          });
        }
        if (callCount === 2) {
          return Promise.reject(new Error('HTTP 429 rate limited'));
        }
        onDelta({ contentDelta: 'Recovered response!', reasoningDelta: '' });
        return Promise.resolve({
          content: 'Recovered response!',
          reasoning: '',
          finishReason: 'stop',
        });
      });

      const { childWin, childDoc, bridge, sendHostMessage, apiPanel } = createWiredPanelAndBridge({
        streamImpl,
      });

      // Untrusted origins ("null" and external) must be ignored
      sendHostMessage(
        { context: 'multi-panel', type: 'INJECT_TEXT', text: 'spoofed', autoSubmit: true },
        { origin: 'null' }
      );
      sendHostMessage(
        { context: 'multi-panel', type: 'INJECT_TEXT', text: 'spoofed', autoSubmit: true },
        { origin: 'https://evil.example' }
      );
      expect(childDoc.getElementById('composer-input').value).toBe('');
      expect(streamImpl).not.toHaveBeenCalled();

      // IME composition Enter (isComposing: true and keyCode: 229) must NOT submit
      const composer = childDoc.getElementById('composer-input');
      composer.value = '日本語テスト';
      composer.dispatchEvent(new childWin.Event('input', { bubbles: true }));

      composer.dispatchEvent(
        new childWin.KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        })
      );
      const ime229Event = new childWin.KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(ime229Event, 'keyCode', { value: 229 });
      composer.dispatchEvent(ime229Event);
      expect(streamImpl).not.toHaveBeenCalled();

      // Plain Enter submits and starts streaming call #1
      composer.dispatchEvent(
        new childWin.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        })
      );

      await vi.waitFor(() => {
        expect(streamImpl).toHaveBeenCalledTimes(1);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(false);
      });

      // Clicking Stop aborts active signal cleanly
      childDoc.getElementById('stop-stream-btn').click();
      await vi.waitFor(() => {
        expect(activeAbortSignal.aborted).toBe(true);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(true);
      });

      // Second prompt fails with HTTP 429 -> displays Retry -> clicking Retry succeeds on call #3
      sendHostMessage({
        context: 'multi-panel',
        type: 'INJECT_TEXT',
        text: 'Try again',
        autoSubmit: true,
      });

      await vi.waitFor(() => {
        expect(streamImpl).toHaveBeenCalledTimes(2);
        const errorEls = childDoc.querySelectorAll('.turn-error:not([hidden])');
        expect(errorEls).toHaveLength(1);
        expect(errorEls[0].textContent).toContain('HTTP 429 rate limited');
      });

      childDoc.querySelector('.turn-error:not([hidden]) .retry-turn-btn').click();
      await vi.waitFor(() => {
        expect(streamImpl).toHaveBeenCalledTimes(3);
        const assistantMarkdowns = childDoc.querySelectorAll('.turn-assistant .turn-markdown');
        expect(assistantMarkdowns[1].textContent).toContain('Recovered response!');
      });

      apiPanel.destroy();
      bridge.dispose();

      // Framed top-window guard: bridge refuses all requests if hostWindow.top !== hostWindow
      const framedStream = vi.fn();
      const framed = createWiredPanelAndBridge({
        streamImpl: framedStream,
        framedTop: true,
      });
      framed.sendHostMessage({
        context: 'multi-panel',
        type: 'INJECT_TEXT',
        text: 'Should not run',
        autoSubmit: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(framedStream).not.toHaveBeenCalled();
      framed.apiPanel.destroy();
      framed.bridge.dispose();
    });

    it('invalidates pending permission/key requests and active streams when provider config or credentials change, never sending B credentials to A', async () => {
      // --- Part 1: Edit between checkPermission and key lookup (R3 credential-routing guard) ---
      await saveCustomApiKey(PROVIDER_ID, 'key-for-A', {
        endpointUrl: 'https://a.example/v1/chat/completions',
      });

      const descriptorA = toCustomProviderDescriptor(
        {
          id: PROVIDER_ID,
          kind: 'api',
          name: 'Gateway A',
          endpointUrl: 'https://a.example/v1/chat/completions',
          model: 'model-a',
          hasApiKey: true,
          frameRuleId: 10000,
          createdAt: 1700000000000,
        },
        { extensionOrigin: EXTENSION_ORIGIN }
      );
      setCustomProviderDescriptors([descriptorA]);

      document.body.innerHTML = API_PANEL_BODY_HTML;
      const childDoc = document;
      const childListeners = new Set();
      const hostListeners = new Set();

      const hostWin = {
        addEventListener(type, fn) {
          if (type === 'message') hostListeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'message') hostListeners.delete(fn);
        },
        postMessage(payload, targetOrigin) {
          if (targetOrigin !== EXTENSION_ORIGIN) {
            throw new Error(`Unexpected host targetOrigin: ${targetOrigin}`);
          }
          const ev = { data: payload, origin: EXTENSION_ORIGIN, source: childWinProxy };
          for (const listener of [...hostListeners]) {
            listener(ev);
          }
        },
      };
      hostWin.top = hostWin;

      const childWinProxy = {
        location: {
          href: `${EXTENSION_ORIGIN}/api-panel/api-panel.html?providerId=${PROVIDER_ID}&theme=light`,
          search: `?providerId=${PROVIDER_ID}&theme=light`,
        },
        parent: hostWin,
        innerWidth: 600,
        innerHeight: 500,
        CSS: { supports: () => false },
        navigator: window.navigator,
        Event: window.Event,
        KeyboardEvent: window.KeyboardEvent,
        requestAnimationFrame(cb) {
          cb(0);
          return 1;
        },
        cancelAnimationFrame() {},
        addEventListener(type, fn) {
          if (type === 'message') childListeners.add(fn);
        },
        removeEventListener(type, fn) {
          if (type === 'message') childListeners.delete(fn);
        },
        dispatchEvent(ev) {
          for (const listener of [...childListeners]) {
            listener(ev);
          }
        },
        postMessage(payload, targetOrigin) {
          if (targetOrigin !== EXTENSION_ORIGIN) {
            throw new Error(`Unexpected child targetOrigin: ${targetOrigin}`);
          }
          const ev = { data: payload, origin: EXTENSION_ORIGIN, source: hostWin };
          for (const listener of [...childListeners]) {
            listener(ev);
          }
        },
      };

      let resolveFirstPerm = null;
      let checkPermCalls = 0;
      const checkPermission = vi.fn(() => {
        checkPermCalls += 1;
        if (checkPermCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstPerm = resolve;
          });
        }
        return Promise.resolve(true);
      });

      const seenStreamCalls = [];
      let activeStreamSignal = null;
      const streamImpl = vi.fn((params) => {
        seenStreamCalls.push({
          endpointUrl: params.endpointUrl,
          model: params.model,
          apiKey: params.apiKey,
        });
        activeStreamSignal = params.signal;
        params.onDelta({ contentDelta: 'Streaming from B...', reasoningDelta: '' });
        return new Promise((_resolve, reject) => {
          params.signal.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      // Omit getApiKey override so bridge uses the real IndexedDB secret store + endpoint binding!
      const bridge = createCustomApiHostBridge({
        getPanels: () => [
          {
            id: 'panel-1',
            providerId: PROVIDER_ID,
            iframe: { contentWindow: childWinProxy },
          },
        ],
        getTheme: () => 'light',
        hostWindow: hostWin,
        checkPermission,
        streamCompletion: streamImpl,
      });

      const apiPanel = initApiPanel({
        rootWindow: childWinProxy,
        rootDocument: childDoc,
      });

      // Begin request r1 for endpoint A; r1 pauses inside checkPermission
      childWinProxy.dispatchEvent({
        data: {
          context: 'multi-panel',
          type: 'INJECT_TEXT',
          text: 'Hello Gateway A',
          autoSubmit: true,
        },
        origin: EXTENSION_ORIGIN,
        source: hostWin,
      });

      await vi.waitFor(() => {
        expect(checkPermCalls).toBe(1);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(false);
      });

      // User starts typing a new unsent draft in composer while editing provider A -> B
      const composer = childDoc.getElementById('composer-input');
      composer.value = 'Unsent draft for B';
      composer.dispatchEvent(new childWinProxy.Event('input', { bubbles: true }));

      // Edit provider A -> B: save key-for-B bound to B, update descriptor to B, and syncPanelsMetadata
      await saveCustomApiKey(PROVIDER_ID, 'key-for-B', {
        endpointUrl: 'https://b.example/v1/chat/completions',
      });
      const descriptorB = toCustomProviderDescriptor(
        {
          id: PROVIDER_ID,
          kind: 'api',
          name: 'Gateway B',
          endpointUrl: 'https://b.example/v1/chat/completions',
          model: 'model-b',
          hasApiKey: true,
          frameRuleId: 10000,
          createdAt: 1700000000000,
        },
        { extensionOrigin: EXTENSION_ORIGIN }
      );
      setCustomProviderDescriptors([descriptorB]);
      bridge.syncPanelsMetadata();

      // Release delayed permission for r1 -> streamCompletion MUST NOT be called!
      resolveFirstPerm(true);
      await new Promise((r) => setTimeout(r, 25));

      expect(seenStreamCalls).toEqual([]);
      expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(true);
      expect(childDoc.getElementById('api-origin-badge').textContent).toBe('https://b.example');
      expect(childDoc.getElementById('api-model-badge').textContent).toBe('model-b');
      expect(childDoc.querySelectorAll('.turn-item')).toHaveLength(0);
      expect(childDoc.getElementById('empty-state').hidden).toBe(false);
      expect(composer.value).toBe('Unsent draft for B');

      // --- Part 2: Active established stream on B is aborted & reset when edited to C ---
      childWinProxy.dispatchEvent({
        data: {
          context: 'multi-panel',
          type: 'TRIGGER_SEND',
        },
        origin: EXTENSION_ORIGIN,
        source: hostWin,
      });

      await vi.waitFor(() => {
        expect(seenStreamCalls).toHaveLength(1);
        expect(childDoc.querySelector('.turn-markdown')?.textContent).toContain(
          'Streaming from B...'
        );
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(false);
      });
      expect(seenStreamCalls[0]).toEqual({
        endpointUrl: 'https://b.example/v1/chat/completions',
        model: 'model-b',
        apiKey: 'key-for-B',
      });
      const signalOnB = activeStreamSignal;
      expect(signalOnB.aborted).toBe(false);

      // Edit B -> C while B is actively streaming
      await saveCustomApiKey(PROVIDER_ID, 'key-for-C', {
        endpointUrl: 'https://c.example/v1/chat/completions',
      });
      const descriptorC = toCustomProviderDescriptor(
        {
          id: PROVIDER_ID,
          kind: 'api',
          name: 'Gateway C',
          endpointUrl: 'https://c.example/v1/chat/completions',
          model: 'model-c',
          hasApiKey: true,
          frameRuleId: 10000,
          createdAt: 1700000000000,
        },
        { extensionOrigin: EXTENSION_ORIGIN }
      );
      setCustomProviderDescriptors([descriptorC]);
      bridge.syncPanelsMetadata();

      await vi.waitFor(() => {
        expect(signalOnB.aborted).toBe(true);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(true);
      });
      expect(childDoc.getElementById('api-origin-badge').textContent).toBe('https://c.example');
      expect(childDoc.getElementById('api-model-badge').textContent).toBe('model-c');
      expect(childDoc.querySelectorAll('.turn-item')).toHaveLength(0);

      // --- Part 3: Rotating ONLY the credential on C immediately aborts an active stream on C ---
      childWinProxy.dispatchEvent({
        data: {
          context: 'multi-panel',
          type: 'INJECT_TEXT',
          text: 'Ping C',
          autoSubmit: true,
        },
        origin: EXTENSION_ORIGIN,
        source: hostWin,
      });

      await vi.waitFor(() => {
        expect(seenStreamCalls).toHaveLength(2);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(false);
      });
      const signalOnC = activeStreamSignal;
      expect(signalOnC.aborted).toBe(false);

      await saveCustomApiKey(PROVIDER_ID, 'key-for-C-rotated', {
        endpointUrl: 'https://c.example/v1/chat/completions',
      });

      await vi.waitFor(() => {
        expect(signalOnC.aborted).toBe(true);
        expect(childDoc.getElementById('stop-stream-btn').hidden).toBe(true);
      });

      apiPanel.destroy();
      bridge.dispose();
    });
  });
});
