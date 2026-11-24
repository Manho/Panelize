import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  CUSTOM_PROVIDER_ICON,
  CUSTOM_PROVIDER_ICON_DARK,
} from '../modules/custom-providers.js';
import {
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';
import { importSettings, resetSettings } from '../modules/settings.js';

const ROOT = process.cwd();
const LOCALES_DIR = resolve(ROOT, '_locales');
const EN_MESSAGES = JSON.parse(readFileSync(resolve(LOCALES_DIR, 'en/messages.json'), 'utf8'));

function extractBodyInnerHtml(filePath) {
  const html = readFileSync(filePath, 'utf8');
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!match) {
    throw new Error(`Could not extract <body> from ${filePath}`);
  }
  return match[1].replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

const OPTIONS_BODY_HTML = extractBodyInnerHtml(resolve(ROOT, 'options/options.html'));

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function installChromeEnv({
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
        return Promise.resolve(
          keys in store ? { [keys]: cloneValue(store[keys]) } : {}
        );
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

  chrome.runtime.id = 'panelize-test-extension-id';
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
    contains: vi.fn(({ origins = [] } = {}) => (
      Promise.resolve(origins.every((origin) => grantedSet.has(origin)))
    )),
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

  return { areas, grantedSet, storageListeners };
}

describe('B3.2 custom web providers in Options', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetExtraProviderDescriptors();
    setCustomProviderDescriptors([]);
    document.documentElement.setAttribute('data-theme', 'light');
    document.body.innerHTML = '';
  });

  describe('locales and per-reason validation messages', () => {
    const locales = readdirSync(LOCALES_DIR).sort();
    const NEW_KEYS = [
      'headingAddCustomProvider',
      'labelCustomProviderName',
      'placeholderCustomProviderName',
      'labelCustomProviderUrl',
      'placeholderCustomProviderUrl',
      'btnAddCustomProvider',
      'msgCustomProviderOriginPreview',
      'msgCustomProviderUnsupportedChrome',
      'errCustomNameRequired',
      'errCustomNameTooLong',
      'errCustomUrlInvalid',
      'errCustomUrlUnsupportedScheme',
      'errCustomUrlEmptyHost',
      'errCustomUrlCredentials',
      'errCustomUrlInsecureHttp',
      'errCustomUrlBuiltinOrigin',
      'errCustomUrlDuplicateOrigin',
      'msgCustomProviderPermissionDenied',
      'errCustomProviderSaveFailed',
      'msgCustomProviderAdded',
      'msgCustomProviderDeleted',
      'msgConfirmDeleteCustomInline',
      'btnConfirmDeleteCustom',
      'ariaDeleteCustomProvider',
    ];
    const REASON_KEYS = [
      'errCustomUrlInvalid',
      'errCustomUrlUnsupportedScheme',
      'errCustomUrlEmptyHost',
      'errCustomUrlCredentials',
      'errCustomUrlInsecureHttp',
      'errCustomUrlBuiltinOrigin',
      'errCustomUrlDuplicateOrigin',
    ];

    it('ships all custom-provider strings in all 10 locales with distinct per-reason messages', () => {
      expect(locales).toEqual(['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'ru', 'zh_CN', 'zh_TW']);

      for (const locale of locales) {
        const dict = JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, 'messages.json'), 'utf8'));
        for (const key of NEW_KEYS) {
          expect(dict[key]?.message?.trim(), `${locale}.${key}`).toBeTruthy();
        }
        for (const subKey of [
          'msgCustomProviderOriginPreview',
          'msgCustomProviderPermissionDenied',
          'msgCustomProviderAdded',
          'msgCustomProviderDeleted',
          'ariaDeleteCustomProvider',
        ]) {
          expect(dict[subKey].message, `${locale}.${subKey}`).toContain('$1');
        }

        const reasonMessages = REASON_KEYS.map((key) => dict[key].message);
        expect(new Set(reasonMessages).size, `distinct reason messages in ${locale}`).toBe(REASON_KEYS.length);
      }
    });
  });

  it('calls chrome.permissions.request synchronously with zero awaited work before it, and updates the live origin preview via textContent', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas } = installChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'custom-aaaaaaaaaa'],
        providerOrder: ['custom-aaaaaaaaaa', 'chatgpt'],
      },
    });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const preview = document.getElementById('custom-provider-origin-preview');
    const form = document.getElementById('custom-provider-form');

    nameInput.value = '  Local WebUI  ';
    urlInput.value = 'http://localhost:3000/c/123?model=llama#frag';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(preview.hidden).toBe(false);
    expect(preview.children.length).toBe(0);
    expect(preview.textContent).toBe('Panelize will ask for access to http://localhost:3000');

    let microtaskTickedBeforeRequest = false;
    let requestCalledSynchronously = false;
    let resolvePermission;
    chrome.permissions.request.mockImplementation(({ origins }) => {
      requestCalledSynchronously = !microtaskTickedBeforeRequest;
      expect(origins).toEqual(['http://localhost:3000/*']);
      return new Promise((res) => {
        resolvePermission = res;
      });
    });

    Promise.resolve().then(() => {
      microtaskTickedBeforeRequest = true;
    });
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // Assert synchronously right after dispatchEvent BEFORE any microtask runs!
    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(requestCalledSynchronously).toBe(true);

    // Grant permission and let async persistence finish
    chrome.permissions.contains.mockImplementation(({ origins = [] } = {}) => (
      Promise.resolve(origins.includes('http://localhost:3000/*'))
    ));
    resolvePermission(true);

    await vi.waitFor(() => {
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(1);
      expect(areas.sync.enabledProviders).toContain(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0].id);
    });

    const saved = areas.local[CUSTOM_PROVIDERS_STORAGE_KEY][0];
    expect(saved.name).toBe('Local WebUI');
    expect(saved.url).toBe('http://localhost:3000/c/123?model=llama');
    expect(areas.sync.enabledProviders).toEqual(['chatgpt', 'custom-aaaaaaaaaa', saved.id]);
    expect(areas.sync.providerOrder).toContain('custom-aaaaaaaaaa');
    expect(areas.sync.providerOrder.at(-1)).toBe(saved.id);

    // Form cleared and entry rendered with generic icon + textContent origin badge + delete control
    expect(nameInput.value).toBe('');
    expect(urlInput.value).toBe('');
    expect(preview.hidden).toBe(true);

    const customRow = document.querySelector(`#provider-list .provider-item[data-provider-id="${saved.id}"]`);
    expect(customRow).not.toBeNull();
    expect(customRow.querySelector('.provider-icon img').getAttribute('src')).toBe(CUSTOM_PROVIDER_ICON);
    expect(customRow.querySelector('.provider-name').textContent).toBe('Local WebUI');
    const badge = customRow.querySelector('.provider-origin-badge');
    expect(badge).not.toBeNull();
    expect(badge.children.length).toBe(0);
    expect(badge.textContent).toBe('http://localhost:3000');
    expect(customRow.querySelector('.toggle-switch').classList.contains('active')).toBe(true);
    expect(customRow.querySelector('[data-action="delete-custom-provider"]')).not.toBeNull();

    // Dark theme switches custom entry icon to dark variant
    document.documentElement.setAttribute('data-theme', 'dark');
    await optionsMod.renderProviderList();
    const darkCustomRow = document.querySelector(`#provider-list .provider-item[data-provider-id="${saved.id}"]`);
    expect(darkCustomRow.querySelector('.provider-icon img').getAttribute('src')).toBe(CUSTOM_PROVIDER_ICON_DARK);
  });

  it('maps each validateCustomProviderUrl reason to its own localized error message in the form', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-0123456789',
            name: 'Existing Local',
            url: 'http://localhost:3000/',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'custom-0123456789'],
      },
      grantedOrigins: ['http://localhost:3000/*'],
    });

    await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.querySelector('[data-provider-id="custom-0123456789"]')).not.toBeNull();
    });

    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const errorEl = document.getElementById('custom-provider-error');
    const form = document.getElementById('custom-provider-form');
    nameInput.value = 'Test AI';

    const cases = [
      ['not a valid url', EN_MESSAGES.errCustomUrlInvalid.message],
      ['ftp://files.example.com', EN_MESSAGES.errCustomUrlUnsupportedScheme.message],
      ['https://:8080/path', EN_MESSAGES.errCustomUrlEmptyHost.message],
      ['https://user:secret@chat.example.com/', EN_MESSAGES.errCustomUrlCredentials.message],
      ['http://public.example.com/', EN_MESSAGES.errCustomUrlInsecureHttp.message],
      ['https://chatgpt.com/', EN_MESSAGES.errCustomUrlBuiltinOrigin.message],
      ['http://localhost:3000/other', EN_MESSAGES.errCustomUrlDuplicateOrigin.message],
    ];

    for (const [rawUrl, expectedMessage] of cases) {
      urlInput.value = rawUrl;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      expect(errorEl.hidden, rawUrl).toBe(false);
      expect(errorEl.textContent, rawUrl).toBe(expectedMessage);
      expect(chrome.permissions.request).not.toHaveBeenCalled();
    }
  });

  it('saves nothing on permission denial, and rolls back granted permission on persist failure unless another entry uses that origin', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const { areas } = installChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
      },
    });

    await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.querySelectorAll('#provider-list .provider-item').length).toBeGreaterThan(0);
    });

    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const errorEl = document.getElementById('custom-provider-error');
    const form = document.getElementById('custom-provider-form');

    // 1) Permission denied -> save nothing
    chrome.permissions.request.mockResolvedValueOnce(false);
    nameInput.value = 'Denied AI';
    urlInput.value = 'https://denied.example.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe('Site access to https://denied.example.com was not granted.');
    });
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toBeUndefined();
    expect(areas.sync.enabledProviders).toEqual(['chatgpt']);
    expect(chrome.permissions.remove).not.toHaveBeenCalled();

    // 2) Grant followed by storage.local.set failure -> revokes permission
    chrome.permissions.request.mockResolvedValueOnce(true);
    chrome.storage.local.set.mockRejectedValueOnce(new Error('QUOTA_BYTES quota exceeded'));
    nameInput.value = 'Broken Save AI';
    urlInput.value = 'https://rollback.example.com';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(chrome.permissions.remove).toHaveBeenCalledWith({
        origins: [
          'https://rollback.example.com/*',
          'https://*.example.com/*',
          'http://*.example.com/*',
        ],
      });
    });
    expect(errorEl.textContent).toBe(EN_MESSAGES.errCustomProviderSaveFailed.message);
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toBeUndefined();

    // 3) Grant followed by persist failure when another entry already uses that origin -> keeps permission!
    chrome.permissions.remove.mockClear();
    chrome.permissions.request.mockResolvedValueOnce(true);
    // Simulate another tab having saved the same origin right before addCustomProvider reads storage.local
    areas.local[CUSTOM_PROVIDERS_STORAGE_KEY] = [
      {
        id: 'custom-9999999999',
        name: 'Concurrent Tab Entry',
        url: 'https://shared.example.com/',
        frameRuleId: 10000,
        createdAt: 1700000000000,
      },
    ];
    nameInput.value = 'Duplicate Race AI';
    urlInput.value = 'https://shared.example.com/chat';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toBe(EN_MESSAGES.errCustomUrlDuplicateOrigin.message);
    });
    expect(chrome.permissions.remove).not.toHaveBeenCalled();
  });

  it('uses inline two-step confirm (never window.confirm) on delete, cleans up local + 3 sync lists, and respects shared origins', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;
    const confirmSpy = vi.spyOn(window, 'confirm');

    const { areas } = installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-1111111111',
            name: 'Solo Origin AI',
            url: 'http://localhost:3000/',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
          {
            id: 'custom-2222222222',
            name: 'Shared Origin AI',
            url: 'https://shared-host.example.com/a',
            frameRuleId: 10001,
            createdAt: 1700000001000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: [
          'chatgpt',
          'custom-ffffffff99',
          'custom-1111111111',
          'custom-2222222222',
        ],
        providerOrder: [
          'custom-ffffffff99',
          'chatgpt',
          'custom-1111111111',
          'custom-2222222222',
        ],
        multiPanelProviders: ['chatgpt', 'custom-1111111111', 'custom-2222222222'],
      },
      grantedOrigins: ['http://localhost:3000/*', 'https://shared-host.example.com/*'],
    });

    await import('../options/options.js');
    const registryAfterReset = await import('../modules/provider-registry.js');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-provider-id="custom-1111111111"]')).not.toBeNull();
      expect(document.querySelector('[data-provider-id="custom-2222222222"]')).not.toBeNull();
    });

    const row1 = document.querySelector('[data-provider-id="custom-1111111111"]');
    const deleteBtn1 = row1.querySelector('[data-action="delete-custom-provider"]');
    const confirmBox1 = row1.querySelector('.custom-provider-delete-confirm');
    const confirmBtn1 = row1.querySelector('[data-action="confirm-delete-custom-provider"]');
    const cancelBtn1 = row1.querySelector('[data-action="cancel-delete-custom-provider"]');

    expect(confirmBox1.hidden).toBe(true);

    // Step 1: clicking Delete reveals inline confirm without deleting or calling window.confirm
    deleteBtn1.click();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(deleteBtn1.hidden).toBe(true);
    expect(confirmBox1.hidden).toBe(false);
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toHaveLength(2);

    // Cancel hides inline confirm
    cancelBtn1.click();
    expect(confirmBox1.hidden).toBe(true);
    expect(deleteBtn1.hidden).toBe(false);

    // Step 2: Delete -> Confirm removes custom-1111111111, cleans 3 sync lists, keeps foreign custom ID, and revokes solo origin
    deleteBtn1.click();
    confirmBtn1.click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-provider-id="custom-1111111111"]')).toBeNull();
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['http://localhost:3000/*'],
    });
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY].map((r) => r.id)).toEqual(['custom-2222222222']);
    expect(areas.sync.enabledProviders).toEqual([
      'chatgpt',
      'custom-ffffffff99',
      'custom-2222222222',
    ]);
    expect(areas.sync.providerOrder).toEqual([
      'custom-ffffffff99',
      'chatgpt',
      'custom-2222222222',
    ]);
    expect(areas.sync.multiPanelProviders).toEqual(['chatgpt', 'custom-2222222222']);

    // Register another provider entry sharing https://shared-host.example.com/* in the live registry:
    // deleting custom-2222222222 must NOT revoke https://shared-host.example.com/* while it is still used!
    registryAfterReset.registerExtraProviderDescriptors([
      {
        id: 'extra-shared-host',
        name: 'Extra Shared Host',
        url: 'https://other-entry.example.com/',
        topLevelUrl: 'https://other-entry.example.com/',
        icon: CUSTOM_PROVIDER_ICON,
        iconDark: CUSTOM_PROVIDER_ICON_DARK,
        enabled: true,
        access: 'optional',
        frameOrigins: ['https://other-entry.example.com', 'https://shared-host.example.com'],
        allowedHosts: ['other-entry.example.com', 'shared-host.example.com'],
        permissionOrigins: [
          'https://other-entry.example.com/*',
          'https://shared-host.example.com/*',
        ],
        contentScript: {
          matches: ['https://other-entry.example.com/*'],
          js: ['content-scripts/text-injection-all-providers.js'],
        },
        frameRule: {
          id: 999,
          urlFilter: '||other-entry.example.com',
        },
        tempChat: null,
      },
    ]);

    try {
      chrome.permissions.remove.mockClear();
      const row2 = document.querySelector('[data-provider-id="custom-2222222222"]');
      row2.querySelector('[data-action="delete-custom-provider"]').click();
      row2.querySelector('[data-action="confirm-delete-custom-provider"]').click();

      await vi.waitFor(() => {
        expect(document.querySelector('[data-provider-id="custom-2222222222"]')).toBeNull();
      });
      expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([]);
      expect(areas.sync.enabledProviders).toEqual(['chatgpt', 'custom-ffffffff99']);
      expect(areas.sync.providerOrder).toEqual(['custom-ffffffff99', 'chatgpt']);
      expect(areas.sync.multiPanelProviders).toEqual(['chatgpt']);
      expect(chrome.permissions.remove).not.toHaveBeenCalled();
    } finally {
      registryAfterReset.resetExtraProviderDescriptors();
    }
  });

  it('disables the Add form and blocks custom activation when Chrome is below 145 (!supportsScopedFrameRules)', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    installChromeEnv({
      scopedFrameRules: false,
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-0123456789',
            name: 'Preexisting Custom',
            url: 'http://localhost:3000/',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'custom-0123456789'],
      },
      grantedOrigins: ['http://localhost:3000/*'],
    });

    await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.getElementById('custom-provider-form')?.dataset.customFormBound).toBe('true');
      expect(document.querySelector('[data-provider-id="custom-0123456789"]')).not.toBeNull();
    });

    const note = document.getElementById('custom-provider-unsupported');
    const nameInput = document.getElementById('custom-provider-name');
    const urlInput = document.getElementById('custom-provider-url');
    const addBtn = document.getElementById('custom-provider-add-btn');

    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe(EN_MESSAGES.msgCustomProviderUnsupportedChrome.message);
    expect(nameInput.disabled).toBe(true);
    expect(urlInput.disabled).toBe(true);
    expect(addBtn.disabled).toBe(true);

    // Custom entry is rendered inactive and clicking its toggle shows the Chrome 145 error without requesting permission
    const customRow = document.querySelector('[data-provider-id="custom-0123456789"]');
    expect(customRow.dataset.hasAccess).toBe('false');
    expect(customRow.querySelector('.toggle-switch').classList.contains('active')).toBe(false);

    customRow.querySelector('.toggle-switch').click();
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(document.getElementById('status-error').textContent).toBe(
      EN_MESSAGES.msgCustomProviderUnsupportedChrome.message
    );
  });

  it('requests permission synchronously when toggling on an ungranted custom entry, and keeps XSS names as literal text', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;
    const xssName = '<img src=x onerror=alert(1)>"\'';

    installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          {
            id: 'custom-abcdef0123',
            name: xssName,
            url: 'http://localhost:3000/',
            frameRuleId: 10000,
            createdAt: 1700000000000,
          },
        ],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt'],
      },
      grantedOrigins: [],
    });

    await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.querySelector('[data-provider-id="custom-abcdef0123"]')).not.toBeNull();
    });

    const row = document.querySelector('[data-provider-id="custom-abcdef0123"]');
    expect(row.querySelector('.provider-name').textContent).toBe(xssName);
    expect(document.querySelectorAll('img[src="x"]')).toHaveLength(0);

    let microtaskTicked = false;
    let calledSynchronously = false;
    chrome.permissions.request.mockImplementation(({ origins }) => {
      calledSynchronously = !microtaskTicked;
      expect(origins).toEqual(['http://localhost:3000/*']);
      chrome.permissions.contains.mockResolvedValue(true);
      return Promise.resolve(true);
    });

    Promise.resolve().then(() => {
      microtaskTicked = true;
    });
    row.querySelector('.toggle-switch').click();
    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(calledSynchronously).toBe(true);
  });

  it('resetSettings leaves customProviders untouched and importSettings keeps custom IDs in synced lists', async () => {
    const customRecord = {
      id: 'custom-0123456789',
      name: 'Kept Across Reset',
      url: 'http://localhost:3000/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };

    const { areas } = installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [customRecord],
      },
      syncInitial: {
        theme: 'dark',
        enabledProviders: ['chatgpt', 'custom-0123456789'],
      },
    });

    // 1) resetSettings clears sync settings while leaving customProviders in local untouched
    await resetSettings();
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([customRecord]);
    expect(areas.sync.theme).toBe('auto');

    // Even when sync throws and resetSettings falls back to local storage, customProviders survives!
    chrome.storage.sync.clear.mockRejectedValueOnce(new Error('Sync offline'));
    await resetSettings();
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([customRecord]);

    // 2) importSettings preserves custom IDs in enabledProviders and providerOrder,
    //    while skipping customProviders definitions and keys that export does not produce
    const importResult = await importSettings({
      theme: 'dark',
      enabledProviders: ['chatgpt', 'custom-0123456789', 'custom-aaaaaaaaaa'],
      providerOrder: ['custom-aaaaaaaaaa', 'chatgpt', 'custom-0123456789'],
      multiPanelProviders: ['custom-0123456789', 'chatgpt'],
      customProviders: [{ id: 'custom-bbbbbbbbbb' }],
    });

    expect(importResult.success).toBe(true);
    expect(importResult.skipped).toContain('customProviders');
    expect(areas.sync.enabledProviders).toEqual([
      'chatgpt',
      'custom-0123456789',
      'custom-aaaaaaaaaa',
    ]);
    expect(areas.sync.providerOrder).toEqual([
      'custom-aaaaaaaaaa',
      'chatgpt',
      'custom-0123456789',
    ]);
    expect(importResult.skipped).toContain('multiPanelProviders');
    expect(areas.sync.multiPanelProviders).toBeUndefined();
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([customRecord]);
  });

  it('runs optional-access/cookie cleanup BEFORE revoking host permissions on delete and origin-changing inline edit, and preserves legacy HTTPS-only grants when companion http:// is declined', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const customRecord = {
      id: 'custom-1234567890',
      name: 'Legacy HTTPS AI',
      url: 'https://legacy-a.example.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };

    const callOrder = [];
    const grantedOrigins = new Set(['https://legacy-a.example.com/*']);

    installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [customRecord],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', customRecord.id],
      },
      grantedOrigins: [...grantedOrigins],
    });

    chrome.permissions.contains.mockImplementation(({ origins = [] } = {}) =>
      Promise.resolve(origins.length > 0 && origins.every((origin) => grantedOrigins.has(origin)))
    );
    chrome.runtime.sendMessage.mockImplementation((msg) => {
      if (msg?.action === 'syncOptionalProviderAccess') {
        callOrder.push('syncOptionalProviderAccess');
      }
      return Promise.resolve({ success: true });
    });
    chrome.permissions.remove.mockImplementation(({ origins = [] } = {}) => {
      callOrder.push(`permissions.remove:${origins.join(',')}`);
      for (const origin of origins) {
        grantedOrigins.delete(origin);
      }
      return Promise.resolve(true);
    });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.querySelector(`[data-provider-id="${customRecord.id}"]`)).not.toBeNull();
    });

    // 1) Legacy HTTPS-only user edits name on same origin and declines companion http:// request ->
    //    core https:// grant preserves the edit without error.
    const row = document.querySelector(`[data-provider-id="${customRecord.id}"]`);
    row.querySelector('[data-action="edit-custom-provider"]').click();
    await vi.waitFor(() => {
      expect(document.querySelector('.custom-provider-inline-edit')).not.toBeNull();
    });
    const inlineForm = document.querySelector('.custom-provider-inline-edit');
    inlineForm.querySelector(`#inline-edit-${customRecord.id}-name`).value = 'Legacy HTTPS AI Renamed';
    chrome.permissions.request.mockResolvedValueOnce(false);
    inlineForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(
        document.querySelector(`[data-provider-id="${customRecord.id}"] .provider-name`)?.textContent
      ).toBe('Legacy HTTPS AI Renamed');
    });
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: [
        'https://legacy-a.example.com/*',
        'https://*.example.com/*',
        'http://*.example.com/*',
      ],
    });

    // 2) Changing origin via inline edit runs syncOptionalProviderAccess BEFORE chrome.permissions.remove
    //    so mirrored cookies on the old origin are cleaned up while host permission is still held.
    //    Because migrated-b.example.com shares the *.example.com parent-domain companion origins,
    //    only https://legacy-a.example.com/* is revoked on edit.
    callOrder.length = 0;
    document
      .querySelector(`[data-provider-id="${customRecord.id}"] [data-action="edit-custom-provider"]`)
      .click();
    await vi.waitFor(() => {
      expect(document.querySelector('.custom-provider-inline-edit')).not.toBeNull();
    });
    const inlineForm2 = document.querySelector('.custom-provider-inline-edit');
    inlineForm2.querySelector(`#inline-edit-${customRecord.id}-url`).value =
      'https://migrated-b.example.com/';
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      for (const origin of origins) {
        grantedOrigins.add(origin);
      }
      return Promise.resolve(true);
    });
    inlineForm2.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => {
      expect(callOrder.some((entry) => entry.startsWith('permissions.remove:'))).toBe(true);
    });
    expect(callOrder[0]).toBe('syncOptionalProviderAccess');
    expect(callOrder[1]).toBe('permissions.remove:https://legacy-a.example.com/*');

    // 3) Deleting custom provider also runs syncOptionalProviderAccess BEFORE chrome.permissions.remove
    //    and now revokes both the origin and its unused *.example.com companion patterns.
    callOrder.length = 0;
    await optionsMod.deleteCustomProviderEntry(customRecord.id);
    expect(callOrder[0]).toBe('syncOptionalProviderAccess');
    expect(callOrder[1]).toBe(
      'permissions.remove:https://migrated-b.example.com/*,https://*.example.com/*,http://*.example.com/*'
    );
  });

  it('preserves shared parent-domain companion permissions when deleting one subdomain provider and prompts legacy subdomain toggles to opt into *.parentDomain', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const mimoStudioRecord = {
      id: 'custom-1111111111',
      name: 'MiMo Studio',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };
    const mimoChatRecord = {
      id: 'custom-2222222222',
      name: 'MiMo Chat',
      url: 'https://chat.xiaomimimo.com/',
      frameRuleId: 10001,
      createdAt: 1700000001000,
    };
    const mimoApiRecord = {
      id: 'custom-3333333333',
      kind: 'api',
      name: 'MiMo API',
      endpointUrl: 'https://api.xiaomimimo.com/v1/chat/completions',
      model: 'mimo-v1',
      hasApiKey: false,
      frameRuleId: 10002,
      createdAt: 1700000002000,
    };

    // Start with only legacy per-host origins on MiMo Studio + MiMo Chat + MiMo API
    const grantedOrigins = new Set([
      'https://aistudio.xiaomimimo.com/*',
      'http://aistudio.xiaomimimo.com/*',
      'https://chat.xiaomimimo.com/*',
      'https://api.xiaomimimo.com/*',
    ]);

    const { areas } = installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [mimoStudioRecord, mimoChatRecord, mimoApiRecord],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', mimoStudioRecord.id, mimoChatRecord.id, mimoApiRecord.id],
      },
      grantedOrigins: [...grantedOrigins],
    });

    chrome.permissions.contains.mockImplementation(({ origins = [] } = {}) =>
      Promise.resolve(origins.length > 0 && origins.every((origin) => grantedOrigins.has(origin)))
    );
    chrome.permissions.remove.mockImplementation(({ origins = [] } = {}) => {
      for (const origin of origins) {
        grantedOrigins.delete(origin);
      }
      return Promise.resolve(true);
    });
    chrome.runtime.sendMessage.mockResolvedValue({ success: true });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      const row = document.querySelector(`[data-provider-id="${mimoStudioRecord.id}"]`);
      expect(row).not.toBeNull();
      expect(row.dataset.hasAccess).toBe('true');
      expect(row.dataset.hasCompanionCookieAccess).toBe('false');
    });

    // 1) Toggle MiMo Studio OFF then ON -> synchronously prompts for *.xiaomimimo.com companion origins
    document
      .querySelector(`[data-provider-id="${mimoStudioRecord.id}"] .toggle-switch`)
      .click();
    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).not.toContain(mimoStudioRecord.id);
    });

    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      expect(origins).toEqual(['https://*.xiaomimimo.com/*', 'http://*.xiaomimimo.com/*']);
      origins.forEach((origin) => grantedOrigins.add(origin));
      return Promise.resolve(true);
    });
    document
      .querySelector(`[data-provider-id="${mimoStudioRecord.id}"] .toggle-switch`)
      .click();
    await vi.waitFor(() => {
      const row = document.querySelector(`[data-provider-id="${mimoStudioRecord.id}"]`);
      expect(row.dataset.hasCompanionCookieAccess).toBe('true');
    });

    // 2) Delete MiMo Studio while MiMo Chat (web) and MiMo API (api) still exist ->
    //    must ONLY revoke https://aistudio.xiaomimimo.com/* and keep both *.xiaomimimo.com patterns!
    chrome.permissions.remove.mockClear();
    await optionsMod.deleteCustomProviderEntry(mimoStudioRecord.id);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['https://aistudio.xiaomimimo.com/*'],
    });

    // 3) Delete MiMo Chat while MiMo API (https://api.xiaomimimo.com/*) still exists ->
    //    must revoke https://chat.xiaomimimo.com/* and http://*.xiaomimimo.com/*,
    //    but MUST NOT revoke https://*.xiaomimimo.com/* because it covers https://api.xiaomimimo.com/*!
    chrome.permissions.remove.mockClear();
    await optionsMod.deleteCustomProviderEntry(mimoChatRecord.id);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['https://chat.xiaomimimo.com/*', 'http://*.xiaomimimo.com/*'],
    });
    expect(grantedOrigins.has('https://*.xiaomimimo.com/*')).toBe(true);

    // 4) Delete MiMo API (the final sibling) -> must revoke BOTH its exact origin
    //    AND the retained https://*.xiaomimimo.com/* wildcard so nothing leaks.
    chrome.permissions.remove.mockClear();
    await optionsMod.deleteCustomProviderEntry(mimoApiRecord.id);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['https://api.xiaomimimo.com/*', 'https://*.xiaomimimo.com/*'],
    });
    expect(grantedOrigins.has('https://api.xiaomimimo.com/*')).toBe(false);
    expect(grantedOrigins.has('https://*.xiaomimimo.com/*')).toBe(false);
    expect(grantedOrigins.has('http://*.xiaomimimo.com/*')).toBe(false);
  });

  it('does not leak a web provider parent wildcard after deleting both the web provider and an exact-host API sibling', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const webRecord = {
      id: 'custom-4444444444',
      name: 'Example Studio Web',
      url: 'https://aistudio.example.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };
    const sameHostApiRecord = {
      id: 'custom-5555555555',
      kind: 'api',
      name: 'Example Studio API',
      endpointUrl: 'https://aistudio.example.com/v1/chat/completions',
      model: 'example-model',
      hasApiKey: false,
      frameRuleId: 10001,
      createdAt: 1700000001000,
    };

    const { grantedSet } = installChromeEnv({
      localInitial: {
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [webRecord, sameHostApiRecord],
      },
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', webRecord.id, sameHostApiRecord.id],
      },
      grantedOrigins: [
        'https://aistudio.example.com/*',
        'https://*.example.com/*',
        'http://*.example.com/*',
      ],
    });
    chrome.runtime.sendMessage.mockResolvedValue({ success: true });

    const optionsMod = await import('../options/options.js');
    await vi.waitFor(() => {
      expect(document.querySelector(`[data-provider-id="${webRecord.id}"]`)).not.toBeNull();
      expect(document.querySelector(`[data-provider-id="${sameHostApiRecord.id}"]`)).not.toBeNull();
    });

    // Step 1: Delete web provider while same-host API sibling remains ->
    // revokes unused http://*.example.com/* immediately while retaining exact origin and https://*.example.com/* for API sibling.
    chrome.permissions.remove.mockClear();
    await optionsMod.deleteCustomProviderEntry(webRecord.id);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['http://*.example.com/*'],
    });
    expect(grantedSet.has('https://aistudio.example.com/*')).toBe(true);
    expect(grantedSet.has('https://*.example.com/*')).toBe(true);
    expect(grantedSet.has('http://*.example.com/*')).toBe(false);

    // Step 2: Delete same-host API sibling -> revokes BOTH exact origin AND retained https://*.example.com/* wildcard.
    chrome.permissions.remove.mockClear();
    await optionsMod.deleteCustomProviderEntry(sameHostApiRecord.id);
    expect(chrome.permissions.remove).toHaveBeenCalledWith({
      origins: ['https://aistudio.example.com/*', 'https://*.example.com/*'],
    });
    expect(grantedSet.has('https://aistudio.example.com/*')).toBe(false);
    expect(grantedSet.has('https://*.example.com/*')).toBe(false);
    expect(grantedSet.has('http://*.example.com/*')).toBe(false);
  });

  it('lets legacy HTTPS-only Zhipu users opt into companion http://chatglm.cn/* from the provider toggle while keeping Zhipu enabled if declined', async () => {
    vi.resetModules();
    document.body.innerHTML = OPTIONS_BODY_HTML;

    const grantedOrigins = new Set(['https://chatglm.cn/*']);
    const { areas } = installChromeEnv({
      syncInitial: {
        theme: 'light',
        language: 'en',
        enabledProviders: ['chatgpt', 'chatglm'],
      },
      grantedOrigins: [...grantedOrigins],
    });

    chrome.permissions.contains.mockImplementation(({ origins = [] } = {}) =>
      Promise.resolve(origins.length > 0 && origins.every((origin) => grantedOrigins.has(origin)))
    );
    chrome.runtime.sendMessage.mockResolvedValue({ success: true });

    await import('../options/options.js');
    await vi.waitFor(() => {
      const row = document.querySelector('[data-provider-id="chatglm"]');
      expect(row).not.toBeNull();
      expect(row.dataset.hasAccess).toBe('true');
      expect(row.dataset.hasCompanionCookieAccess).toBe('false');
      expect(row.querySelector('.toggle-switch').classList.contains('active')).toBe(true);
    });

    // 1) Toggling OFF must NOT prompt for companion permission.
    chrome.permissions.request.mockClear();
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();
    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toEqual(['chatgpt']);
      const row = document.querySelector('[data-provider-id="chatglm"]');
      expect(row.dataset.enabledPreference).toBe('false');
      expect(row.querySelector('.toggle-switch').classList.contains('active')).toBe(false);
    });
    expect(chrome.permissions.request).not.toHaveBeenCalled();

    // 2) Toggling ON synchronously requests companion http://chatglm.cn/* in the user gesture.
    //    If declined, Zhipu still becomes enabled with legacy HTTPS-only access.
    let microtaskTicked = false;
    let calledSynchronously = false;
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      calledSynchronously = !microtaskTicked;
      expect(origins).toEqual(['http://chatglm.cn/*']);
      return Promise.resolve(false);
    });
    Promise.resolve().then(() => {
      microtaskTicked = true;
    });
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();
    expect(chrome.permissions.request).toHaveBeenCalledTimes(1);
    expect(calledSynchronously).toBe(true);

    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toContain('chatglm');
      const row = document.querySelector('[data-provider-id="chatglm"]');
      expect(row.dataset.enabledPreference).toBe('true');
      expect(row.dataset.hasAccess).toBe('true');
      expect(row.dataset.hasCompanionCookieAccess).toBe('false');
      expect(row.querySelector('.toggle-switch').classList.contains('active')).toBe(true);
    });

    // 3) Toggle OFF then ON again and APPROVE companion grant -> both origins granted,
    //    syncOptionalProviderAccess activates cookie sync, and companion flag flips to true.
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();
    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toEqual(['chatgpt']);
    });

    chrome.runtime.sendMessage.mockClear();
    chrome.permissions.request.mockClear();
    chrome.permissions.request.mockImplementationOnce(({ origins }) => {
      expect(origins).toEqual(['http://chatglm.cn/*']);
      origins.forEach((origin) => grantedOrigins.add(origin));
      return Promise.resolve(true);
    });
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();

    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toContain('chatglm');
      const row = document.querySelector('[data-provider-id="chatglm"]');
      expect(row.dataset.hasAccess).toBe('true');
      expect(row.dataset.hasCompanionCookieAccess).toBe('true');
      expect(row.querySelector('.toggle-switch').classList.contains('active')).toBe(true);
    });
    expect(grantedOrigins.has('https://chatglm.cn/*')).toBe(true);
    expect(grantedOrigins.has('http://chatglm.cn/*')).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'syncOptionalProviderAccess',
    });

    // 4) Once companion permission is granted, toggling OFF then ON does not re-prompt.
    chrome.permissions.request.mockClear();
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();
    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toEqual(['chatgpt']);
    });
    document.querySelector('[data-provider-id="chatglm"] .toggle-switch').click();
    await vi.waitFor(() => {
      expect(areas.sync.enabledProviders).toContain('chatglm');
    });
    expect(chrome.permissions.request).not.toHaveBeenCalled();
  });
});
