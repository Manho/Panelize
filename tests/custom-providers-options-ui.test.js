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
        origins: ['https://rollback.example.com/*'],
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

    // 2) importSettings preserves custom IDs in enabledProviders, providerOrder, and multiPanelProviders,
    //    while skipping customProviders definitions in M2
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
    expect(areas.sync.multiPanelProviders).toEqual(['custom-0123456789', 'chatgpt']);
    expect(areas.local[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([customRecord]);
  });
});
