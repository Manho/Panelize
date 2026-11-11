import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  CUSTOM_PROVIDER_ID_PATTERN,
  getProviderDescriptor,
  hasProviderDescriptor,
  listProviderDescriptors,
  registerExtraProviderDescriptors,
  resetExtraProviderDescriptors,
  setCustomProviderDescriptors,
  validateProviderDescriptor,
} from '../modules/provider-registry.js';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  CUSTOM_PROVIDER_DRIVER_SCRIPT,
  CUSTOM_PROVIDER_ICON,
  CUSTOM_PROVIDER_ICON_DARK,
  addCustomProvider,
  allocateCustomFrameRuleId,
  generateCustomProviderId,
  isCustomProviderId,
  loadCustomProviders,
  removeCustomProvider,
  subscribeCustomProvidersChanged,
  toCustomProviderDescriptor,
  validateCustomProviderUrl,
} from '../modules/custom-providers.js';
import {
  PROVIDERS,
  getEnabledProviders,
  getProviderById,
  listProviders,
} from '../modules/providers.js';

function makeValidRecord(overrides = {}) {
  return {
    id: 'custom-0123456789',
    name: 'Local Open WebUI',
    url: 'http://localhost:3000/chat?model=llama#ignored',
    frameRuleId: 10000,
    createdAt: 1700000000000,
    ...overrides,
  };
}

function installStatefulLocalStorage(initial = {}) {
  const store = structuredClone(initial);
  const listeners = [];

  chrome.storage.local.get = vi.fn(async (keys) => {
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
  });

  chrome.storage.local.set = vi.fn(async (patch) => {
    const changes = {};
    for (const [key, newValue] of Object.entries(patch)) {
      const oldValue = key in store ? structuredClone(store[key]) : undefined;
      store[key] = structuredClone(newValue);
      changes[key] = { oldValue, newValue: structuredClone(newValue) };
    }
    for (const listener of listeners) {
      listener(changes, 'local');
    }
  });

  chrome.storage.onChanged = {
    addListener: vi.fn((fn) => {
      listeners.push(fn);
    }),
    removeListener: vi.fn((fn) => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    }),
  };

  return { store, listeners };
}

describe('custom providers: registry, id rules, URL validation, and storage hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCustomProviderDescriptors([]);
    resetExtraProviderDescriptors();
  });

  afterEach(() => {
    setCustomProviderDescriptors([]);
    resetExtraProviderDescriptors();
    vi.restoreAllMocks();
  });

  describe('leaf registry guarantees, capabilities, and custom descriptor validation', () => {
    it('keeps modules/provider-registry.js free of imports and chrome.* references', async () => {
      const source = readFileSync(
        resolve(process.cwd(), 'modules/provider-registry.js'),
        'utf8'
      );
      const codeWithoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(codeWithoutComments).not.toMatch(/^\s*import\s/m);
      expect(codeWithoutComments).not.toMatch(/\bchrome\s*\./);

      // Also verify runtime evaluation succeeds when globalThis.chrome is undefined
      const savedChrome = globalThis.chrome;
      try {
        vi.resetModules();
        globalThis.chrome = undefined;
        const freshRegistry = await import('../modules/provider-registry.js');
        expect(freshRegistry.BUILTIN_PROVIDER_DESCRIPTORS).toHaveLength(14);
      } finally {
        globalThis.chrome = savedChrome;
      }
    });

    it('populates frozen all-true capabilities on all 14 built-in descriptors', () => {
      for (const descriptor of BUILTIN_PROVIDER_DESCRIPTORS) {
        expect(descriptor.capabilities).toEqual({
          imageUpload: true,
          inPageNewChat: true,
          snapshotStitch: true,
        });
        expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
      }
    });

    it('builds an exact frozen custom descriptor via toCustomProviderDescriptor', () => {
      const descriptor = toCustomProviderDescriptor(makeValidRecord());

      expect(descriptor).toEqual({
        id: 'custom-0123456789',
        name: 'Local Open WebUI',
        url: 'http://localhost:3000/chat?model=llama',
        topLevelUrl: 'http://localhost:3000/chat?model=llama',
        icon: CUSTOM_PROVIDER_ICON,
        iconDark: CUSTOM_PROVIDER_ICON_DARK,
        enabled: true,
        access: 'custom',
        frameOrigins: ['http://localhost:3000'],
        allowedHosts: [],
        permissionOrigins: ['http://localhost:3000/*'],
        contentScript: {
          matches: ['http://localhost:3000/*'],
          js: [CUSTOM_PROVIDER_DRIVER_SCRIPT],
        },
        frameRule: {
          id: 10000,
          urlFilter: '|http://localhost:3000/',
        },
        tempChat: null,
        capabilities: {
          imageUpload: false,
          inPageNewChat: false,
          snapshotStitch: false,
        },
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.frameOrigins)).toBe(true);
      expect(Object.isFrozen(descriptor.allowedHosts)).toBe(true);
      expect(Object.isFrozen(descriptor.permissionOrigins)).toBe(true);
      expect(Object.isFrozen(descriptor.contentScript)).toBe(true);
      expect(Object.isFrozen(descriptor.frameRule)).toBe(true);
      expect(Object.isFrozen(descriptor.capabilities)).toBe(true);
      expect(validateProviderDescriptor(descriptor)).toEqual([]);
    });

    it('enforces custom id format and rejects the custom- prefix on non-custom descriptors', () => {
      const generated = generateCustomProviderId();
      expect(generated).toMatch(CUSTOM_PROVIDER_ID_PATTERN);
      expect(isCustomProviderId(generated)).toBe(true);

      for (const badCustomId of [
        'custom:550e8400-e29b-41d4-a716-446655440000',
        'custom-012345678',
        'custom-0123456789a',
        'custom-ABCDEF0123',
        'custom-012345678g',
        'open-webui',
        'custom-',
      ]) {
        expect(isCustomProviderId(badCustomId), badCustomId).toBe(false);
        const badDescriptor = {
          ...toCustomProviderDescriptor(makeValidRecord()),
          id: badCustomId,
        };
        expect(validateProviderDescriptor(badDescriptor), badCustomId).not.toEqual([]);
      }

      const builtinWithReservedPrefix = {
        id: 'custom-0123456789',
        name: 'Reserved Prefix Builtin',
        url: 'https://example.com/',
        topLevelUrl: 'https://example.com/',
        icon: CUSTOM_PROVIDER_ICON,
        iconDark: CUSTOM_PROVIDER_ICON_DARK,
        enabled: true,
        access: 'builtin',
        frameOrigins: ['https://example.com'],
        allowedHosts: ['example.com'],
        permissionOrigins: null,
        contentScript: null,
        frameRule: null,
        tempChat: null,
      };
      expect(validateProviderDescriptor(builtinWithReservedPrefix)).toContain(
        'Provider "custom-0123456789": non-custom provider id must not start with "custom-"'
      );
    });

    it('enforces trailing slash on custom frameRule.urlFilter, allowedHosts: [], and 10000..19999 rule ids', () => {
      const base = toCustomProviderDescriptor(makeValidRecord());

      // Missing trailing slash could match |http://localhost:3000.evil.com
      expect(
        validateProviderDescriptor({
          ...base,
          frameRule: { id: 10000, urlFilter: '|http://localhost:3000' },
        })
      ).not.toEqual([]);

      // Wildcard without leading pipe/slash
      expect(
        validateProviderDescriptor({
          ...base,
          frameRule: { id: 10000, urlFilter: 'http://localhost:3000/*' },
        })
      ).not.toEqual([]);

      // Out-of-range rule IDs
      expect(
        validateProviderDescriptor({
          ...base,
          frameRule: { id: CUSTOM_FRAME_RULE_ID_MIN - 1, urlFilter: '|http://localhost:3000/' },
        })
      ).not.toEqual([]);
      expect(
        validateProviderDescriptor({
          ...base,
          frameRule: { id: CUSTOM_FRAME_RULE_ID_MAX + 1, urlFilter: '|http://localhost:3000/' },
        })
      ).not.toEqual([]);

      // Non-empty allowedHosts on custom
      expect(
        validateProviderDescriptor({
          ...base,
          allowedHosts: ['localhost'],
        })
      ).not.toEqual([]);

      // Non-null tempChat on custom
      expect(
        validateProviderDescriptor({
          ...base,
          tempChat: { url: null, normalUrl: 'http://localhost:3000/', retry: false },
        })
      ).not.toEqual([]);

      // Missing capabilities on custom
      expect(
        validateProviderDescriptor({
          ...base,
          capabilities: null,
        })
      ).not.toEqual([]);

      // Non-custom descriptor colliding with custom rule ID range 10000..19999
      expect(
        validateProviderDescriptor({
          id: 'optional-test',
          name: 'Optional Test',
          url: 'https://example.com/',
          topLevelUrl: 'https://example.com/',
          icon: CUSTOM_PROVIDER_ICON,
          iconDark: CUSTOM_PROVIDER_ICON_DARK,
          enabled: true,
          access: 'optional',
          frameOrigins: ['https://example.com'],
          allowedHosts: ['example.com'],
          permissionOrigins: ['https://example.com/*'],
          contentScript: { matches: ['https://example.com/*'], js: ['content-scripts/focus-toggle.js'] },
          frameRule: { id: 10000, urlFilter: 'https://example.com/*' },
          tempChat: null,
        })
      ).not.toEqual([]);
    });

    it('replaces custom descriptors atomically via setCustomProviderDescriptors and exposes them via listProviders/getProviderById/getEnabledProviders without mutating PROVIDERS', async () => {
      const builtInSnapshot = structuredClone(PROVIDERS);
      const first = toCustomProviderDescriptor(
        makeValidRecord({ id: 'custom-aaaaaaaaaa', url: 'http://localhost:3000/', frameRuleId: 10000 })
      );
      const second = toCustomProviderDescriptor(
        makeValidRecord({ id: 'custom-bbbbbbbbbb', name: 'Gradio', url: 'http://127.0.0.1:7860/', frameRuleId: 10001 })
      );

      setCustomProviderDescriptors([first]);
      expect(hasProviderDescriptor('custom-aaaaaaaaaa')).toBe(true);
      expect(PROVIDERS).toEqual(builtInSnapshot);
      expect(listProviders().map((p) => p.id)).toEqual([
        ...builtInSnapshot.map((p) => p.id),
        'custom-aaaaaaaaaa',
      ]);
      expect(getProviderById('custom-aaaaaaaaaa')).toEqual({
        id: 'custom-aaaaaaaaaa',
        name: 'Local Open WebUI',
        url: 'http://localhost:3000/',
        topLevelUrl: 'http://localhost:3000/',
        icon: CUSTOM_PROVIDER_ICON,
        iconDark: CUSTOM_PROVIDER_ICON_DARK,
        enabled: true,
      });

      // Rejects non-custom descriptors without corrupting the active custom set
      expect(() =>
        setCustomProviderDescriptors([{ ...first, id: 'not-custom', access: 'builtin' }])
      ).toThrow(/access: "custom"/);
      expect(hasProviderDescriptor('custom-aaaaaaaaaa')).toBe(true);

      // Atomic replacement drops first and installs second
      setCustomProviderDescriptors([second]);
      expect(hasProviderDescriptor('custom-aaaaaaaaaa')).toBe(false);
      expect(hasProviderDescriptor('custom-bbbbbbbbbb')).toBe(true);

      // Composes with test-only extra descriptors
      registerExtraProviderDescriptors([
        {
          id: 'extra-test',
          name: 'Extra Test',
          url: 'https://extra.example.com/',
          topLevelUrl: 'https://extra.example.com/',
          icon: CUSTOM_PROVIDER_ICON,
          iconDark: CUSTOM_PROVIDER_ICON_DARK,
          enabled: true,
          access: 'builtin',
          frameOrigins: ['https://extra.example.com'],
          allowedHosts: ['extra.example.com'],
          permissionOrigins: null,
          contentScript: null,
          frameRule: null,
          tempChat: null,
        },
      ]);
      resetExtraProviderDescriptors();
      expect(hasProviderDescriptor('custom-bbbbbbbbbb')).toBe(true);

      // getEnabledProviders sees custom entries alongside built-ins in configured order
      chrome.storage.sync.get.mockResolvedValue({
        enabledProviders: ['custom-bbbbbbbbbb', 'chatgpt'],
        providerOrder: ['custom-bbbbbbbbbb', 'chatgpt'],
      });
      const enabled = await getEnabledProviders();
      expect(enabled.map((p) => p.id)).toEqual(['custom-bbbbbbbbbb', 'chatgpt']);
    });
  });

  describe('validateCustomProviderUrl', () => {
    it.each([
      ['https public domain with fragment stripped', 'https://chat.example.com:8443/ui?m=1#top', 'https://chat.example.com:8443/ui?m=1', 'https://chat.example.com:8443'],
      ['http localhost', 'http://localhost:3000', 'http://localhost:3000/', 'http://localhost:3000'],
      ['http 127.0.0.1 loopback', 'http://127.0.0.1:11434/', 'http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
      ['http 127.255.255.254 (/8 upper loopback)', 'http://127.255.255.254:8080/app', 'http://127.255.255.254:8080/app', 'http://127.255.255.254:8080'],
      ['http [::1] IPv6 loopback', 'http://[::1]:7860/#frag', 'http://[::1]:7860/', 'http://[::1]:7860'],
      ['http 10.0.0.0/8 private IPv4', 'http://10.42.0.15:3000/', 'http://10.42.0.15:3000/', 'http://10.42.0.15:3000'],
      ['http 172.16.0.0/12 lower boundary', 'http://172.16.0.1:8000/', 'http://172.16.0.1:8000/', 'http://172.16.0.1:8000'],
      ['http 172.16.0.0/12 upper boundary', 'http://172.31.255.254:8000/', 'http://172.31.255.254:8000/', 'http://172.31.255.254:8000'],
      ['http 192.168.0.0/16 private IPv4', 'http://192.168.1.50:8501/', 'http://192.168.1.50:8501/', 'http://192.168.1.50:8501'],
    ])('accepts %s', (_label, input, expectedUrl, expectedOrigin) => {
      expect(validateCustomProviderUrl(input)).toEqual({
        ok: true,
        url: expectedUrl,
        origin: expectedOrigin,
        reason: null,
      });
    });

    it.each([
      ['null', null, 'invalid_url'],
      ['undefined', undefined, 'invalid_url'],
      ['empty string', '   ', 'invalid_url'],
      ['unparseable string', 'not a url', 'invalid_url'],
      ['javascript scheme', 'javascript:alert(1)', 'unsupported_scheme'],
      ['data scheme', 'data:text/html,<h1>x</h1>', 'unsupported_scheme'],
      ['ftp scheme', 'ftp://example.com/', 'unsupported_scheme'],
      ['file scheme', 'file:///etc/passwd', 'unsupported_scheme'],
      ['chrome-extension scheme', 'chrome-extension://abcdef/multi-panel.html', 'unsupported_scheme'],
      ['ws scheme', 'ws://localhost:3000/ws', 'unsupported_scheme'],
      ['empty host https://', 'https://', 'empty_host'],
      ['empty host https:///path', 'https:///chat', 'empty_host'],
      ['empty host with port http://:3000/', 'http://:3000/', 'empty_host'],
      ['empty IPv6 host http://[]:3000/', 'http://[]:3000/', 'empty_host'],
      ['username + password', 'https://user:pass@example.com/chat', 'credentials_not_allowed'],
      ['username only', 'http://admin@localhost:3000/', 'credentials_not_allowed'],
      ['password only', 'https://:secret@example.com/', 'credentials_not_allowed'],
      ['bare @ in authority', 'https://@example.com/', 'credentials_not_allowed'],
      ['http on public domain', 'http://example.com/chat', 'insecure_http'],
      ['http on *.localhost subdomain', 'http://app.localhost:3000/', 'insecure_http'],
      ['http on 0.0.0.0', 'http://0.0.0.0:3000/', 'insecure_http'],
      ['http on 169.254 link-local', 'http://169.254.10.20:3000/', 'insecure_http'],
      ['http on 172.15 (below 172.16/12)', 'http://172.15.255.255:8000/', 'insecure_http'],
      ['http on 172.32 (above 172.16/12)', 'http://172.32.0.1:8000/', 'insecure_http'],
      ['http on 192.169 (outside 192.168/16)', 'http://192.169.1.1:8000/', 'insecure_http'],
      ['http on non-loopback IPv6', 'http://[::2]:3000/', 'insecure_http'],
      ['built-in frameOrigin chatgpt', 'https://chatgpt.com/g/g-123', 'builtin_origin'],
      ['built-in secondary frameOrigin chat.openai.com', 'https://chat.openai.com/', 'builtin_origin'],
      ['optional frameOrigin aistudio', 'https://aistudio.google.com/prompts/new_chat', 'builtin_origin'],
      ['optional permissionOrigin auth.qwen.ai', 'https://auth.qwen.ai/login', 'builtin_origin'],
      ['optional permissionOrigin alkalimakersuite', 'https://alkalimakersuite-pa.clients6.google.com/', 'builtin_origin'],
    ])('rejects %s with reason %s', (_label, raw, expectedReason) => {
      const res = validateCustomProviderUrl(raw);
      expect(res).toEqual({
        ok: false,
        url: null,
        origin: null,
        reason: expectedReason,
      });
    });

    it('rejects duplicate custom origins while allowing a different port on the same host', () => {
      setCustomProviderDescriptors([
        toCustomProviderDescriptor(
          makeValidRecord({ id: 'custom-1111111111', url: 'http://localhost:3000/' })
        ),
      ]);

      expect(validateCustomProviderUrl('http://localhost:3000/another-path')).toEqual({
        ok: false,
        url: null,
        origin: null,
        reason: 'duplicate_custom_origin',
      });

      expect(validateCustomProviderUrl('http://localhost:3001/')).toEqual({
        ok: true,
        url: 'http://localhost:3001/',
        origin: 'http://localhost:3001',
        reason: null,
      });
    });
  });

  describe('allocateCustomFrameRuleId, CRUD, loadCustomProviders, and storage failure handling', () => {
    it('allocates the lowest free integer in 10000..19999', () => {
      expect(allocateCustomFrameRuleId([])).toBe(10000);
      expect(
        allocateCustomFrameRuleId([
          { frameRuleId: 10000 },
          { frameRule: { id: 10002 } },
        ])
      ).toBe(10001);
    });

    it('performs storage + registry CRUD without touching permissions or declarativeNetRequest', async () => {
      const { store } = installStatefulLocalStorage();
      chrome.permissions = {
        contains: vi.fn(),
        request: vi.fn(),
        remove: vi.fn(),
      };
      chrome.declarativeNetRequest = {
        getDynamicRules: vi.fn(),
        updateDynamicRules: vi.fn(),
      };

      const first = await addCustomProvider({
        name: '  Open WebUI  ',
        url: 'http://localhost:3000/#welcome',
      });
      expect(first.id).toMatch(CUSTOM_PROVIDER_ID_PATTERN);
      expect(first.name).toBe('Open WebUI');
      expect(first.url).toBe('http://localhost:3000/');
      expect(first.frameRuleId).toBe(10000);
      expect(Number.isFinite(first.createdAt)).toBe(true);
      expect(getProviderDescriptor(first.id)?.frameOrigins).toEqual(['http://localhost:3000']);
      expect(store[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([first]);

      // Rejects >40 char names and duplicate origins
      await expect(
        addCustomProvider({ name: 'x'.repeat(41), url: 'http://localhost:3001/' })
      ).rejects.toThrow(/1\.\.40/);
      await expect(
        addCustomProvider({ name: 'Duplicate', url: 'http://localhost:3000/other' })
      ).rejects.toThrow(/duplicate_custom_origin/);

      const second = await addCustomProvider({
        name: 'Gradio',
        url: 'http://127.0.0.1:7860/',
      });
      expect(second.frameRuleId).toBe(10001);
      expect(listProviderDescriptors().filter((d) => d.access === 'custom')).toHaveLength(2);

      // Removing first frees slot 10000 and updates storage + registry
      await expect(removeCustomProvider(first.id)).resolves.toBe(true);
      expect(hasProviderDescriptor(first.id)).toBe(false);
      expect(hasProviderDescriptor(second.id)).toBe(true);
      expect(store[CUSTOM_PROVIDERS_STORAGE_KEY]).toEqual([second]);
      await expect(removeCustomProvider(first.id)).resolves.toBe(false);

      expect(chrome.permissions.request).not.toHaveBeenCalled();
      expect(chrome.permissions.remove).not.toHaveBeenCalled();
      expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    });

    it('drops invalid records with console.warn during loadCustomProviders without throwing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      installStatefulLocalStorage({
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          null,
          { id: 'bad-id', name: 'Bad ID', url: 'http://localhost:3000/', frameRuleId: 10000, createdAt: 1 },
          { id: 'custom-0000000001', name: '   ', url: 'http://localhost:3001/', frameRuleId: 10001, createdAt: 1 },
          { id: 'custom-0000000002', name: 'TooLong'.repeat(10), url: 'http://localhost:3002/', frameRuleId: 10002, createdAt: 1 },
          { id: 'custom-0000000003', name: 'Bad Scheme', url: 'ftp://example.com/', frameRuleId: 10003, createdAt: 1 },
          { id: 'custom-0000000004', name: 'Bad Rule', url: 'http://localhost:3004/', frameRuleId: 9999, createdAt: 1 },
          { id: 'custom-0000000005', name: 'Bad CreatedAt', url: 'http://localhost:3005/', frameRuleId: 10005, createdAt: 'nope' },
          makeValidRecord({ id: 'custom-0000000006', name: 'Valid One', url: 'http://localhost:3006/', frameRuleId: 10006, createdAt: 10 }),
          // Duplicate origin of Valid One -> dropped
          makeValidRecord({ id: 'custom-0000000007', name: 'Dup Origin', url: 'http://localhost:3006/chat', frameRuleId: 10007, createdAt: 11 }),
        ],
      });

      const result = await loadCustomProviders();
      expect(result).toEqual({ ok: true });
      expect(
        listProviderDescriptors()
          .filter((d) => d.access === 'custom')
          .map((d) => d.id)
      ).toEqual(['custom-0000000006']);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('returns { ok: false } and preserves existing custom descriptors when storage read fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const existing = toCustomProviderDescriptor(
        makeValidRecord({ id: 'custom-9999999999', url: 'http://localhost:3099/' })
      );
      setCustomProviderDescriptors([existing]);

      chrome.storage.local.get = vi.fn(() => Promise.reject(new Error('Storage backend offline')));

      const result = await loadCustomProviders();
      expect(result).toEqual({ ok: false });
      expect(hasProviderDescriptor('custom-9999999999')).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    });

    it('re-hydrates on local customProviders change via subscribeCustomProvidersChanged', async () => {
      installStatefulLocalStorage({ [CUSTOM_PROVIDERS_STORAGE_KEY]: [] });
      await loadCustomProviders();
      expect(hasProviderDescriptor('custom-ababababab')).toBe(false);

      const events = [];
      const unsubscribe = subscribeCustomProvidersChanged((res) => {
        events.push(res);
      });

      await chrome.storage.local.set({
        [CUSTOM_PROVIDERS_STORAGE_KEY]: [
          makeValidRecord({ id: 'custom-ababababab', url: 'http://localhost:4123/' }),
        ],
      });

      await vi.waitFor(() => {
        expect(events).toEqual([{ ok: true }]);
      });
      expect(hasProviderDescriptor('custom-ababababab')).toBe(true);

      unsubscribe();
    });
  });
});
