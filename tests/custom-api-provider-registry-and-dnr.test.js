import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_API_PANEL_PATH,
  CUSTOM_PROVIDERS_STORAGE_KEY,
  addCustomProvider,
  allocateCustomFrameRuleId,
  getCustomProviderOrigin,
  loadCustomProviders,
  removeCustomProvider,
  toCustomProviderDescriptor,
  updateCustomProvider,
  validateCustomApiEndpointUrl,
} from '../modules/custom-providers.js';
import { STATIC_FRAME_RULESET_ID } from '../modules/frame-header-rules.js';
import {
  reconcileOptionalProviderAccess,
  syncOptionalProviderAccess,
} from '../modules/optional-provider-access.js';
import {
  getProviderFallbackUrl,
  isProviderAllowedUrl,
  isProviderCurrentUrl,
  isProviderFrameOrigin,
} from '../modules/provider-open-url.js';
import {
  listProviderDescriptors,
  setCustomProviderDescriptors,
  validateProviderDescriptor,
} from '../modules/provider-registry.js';

const STATIC_RULES = JSON.parse(
  readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8')
);
const EXTENSION_ID = 'panelizecustomapitestextid';
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

const API_RECORD_OLLAMA_A = {
  id: 'custom-a1a2a3a4a5',
  kind: 'api',
  name: 'Ollama Llama 3.3',
  endpointUrl: 'http://localhost:11434/v1/chat/completions',
  model: 'llama3.3:70b',
  hasApiKey: false,
  frameRuleId: 10000,
  createdAt: 1700000000000,
};

const API_RECORD_OLLAMA_B = {
  id: 'custom-b1b2b3b4b5',
  kind: 'api',
  name: 'Ollama Qwen Coder',
  endpointUrl: 'http://localhost:11434',
  model: 'qwen2.5-coder:32b',
  hasApiKey: false,
  frameRuleId: 10001,
  createdAt: 1700000001000,
};

const WEB_RECORD_C = {
  id: 'custom-c1c2c3c4c5',
  name: 'Hosted Open WebUI',
  url: 'https://webui.example.com/chat',
  frameRuleId: 10002,
  createdAt: 1700000002000,
};

function expectedApiOriginDnrRule(id, apiOrigin) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Origin', operation: 'remove' }],
    },
    condition: {
      urlFilter: `|${apiOrigin}/`,
      initiatorDomains: [EXTENSION_ID],
      resourceTypes: ['xmlhttprequest'],
    },
  };
}

function installStatefulChromeEnv({
  topDomainsSupported = true,
  dynamicRules = [],
  registeredScripts = [],
  staticEnabled = true,
  grantedOrigins = [],
  localRecords = [],
  enabledProviders = [],
} = {}) {
  const state = {
    dynamicRules: structuredClone(dynamicRules),
    registeredScripts: structuredClone(registeredScripts),
    staticEnabled,
    grantedOrigins: new Set(grantedOrigins),
    localRecords: structuredClone(localRecords),
    enabledProviders: [...enabledProviders],
    dnrCalls: [],
    scriptingCalls: [],
  };

  chrome.runtime.id = EXTENSION_ID;
  chrome.runtime.getURL = vi.fn(
    (path = '') => `${EXTENSION_ORIGIN}/${String(path).replace(/^\/+/, '')}`
  );

  chrome.permissions = {
    contains: vi.fn(({ origins = [] } = {}) =>
      Promise.resolve(
        origins.length > 0 && origins.every((origin) => state.grantedOrigins.has(origin))
      )
    ),
    request: vi.fn(({ origins = [] } = {}) => {
      for (const origin of origins) {
        state.grantedOrigins.add(origin);
      }
      return Promise.resolve(true);
    }),
    remove: vi.fn(({ origins = [] } = {}) => {
      for (const origin of origins) {
        state.grantedOrigins.delete(origin);
      }
      return Promise.resolve(true);
    }),
  };

  chrome.scripting = {
    getRegisteredContentScripts: vi.fn(() =>
      Promise.resolve(structuredClone(state.registeredScripts))
    ),
    registerContentScripts: vi.fn((scripts) => {
      state.scriptingCalls.push({
        type: 'register',
        ids: scripts.map(({ id }) => id),
        scripts: structuredClone(scripts),
      });
      state.registeredScripts.push(...structuredClone(scripts));
      return Promise.resolve();
    }),
    unregisterContentScripts: vi.fn(({ ids = [] } = {}) => {
      state.scriptingCalls.push({
        type: 'unregister',
        ids: [...ids],
      });
      const removeSet = new Set(ids);
      state.registeredScripts = state.registeredScripts.filter(({ id }) => !removeSet.has(id));
      return Promise.resolve();
    }),
  };

  chrome.declarativeNetRequest = {
    ...(topDomainsSupported ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } } : {}),
    getDynamicRules: vi.fn(() => Promise.resolve(structuredClone(state.dynamicRules))),
    updateDynamicRules: vi.fn(({ removeRuleIds = [], addRules = [] }) => {
      state.dnrCalls.push({
        type: 'updateDynamicRules',
        removeRuleIds: [...removeRuleIds],
        addRules: structuredClone(addRules),
      });
      const removeSet = new Set(removeRuleIds);
      state.dynamicRules = [
        ...state.dynamicRules.filter(({ id }) => !removeSet.has(id)),
        ...structuredClone(addRules),
      ];
      return Promise.resolve();
    }),
    getEnabledRulesets: vi.fn(() =>
      Promise.resolve(state.staticEnabled ? [STATIC_FRAME_RULESET_ID] : [])
    ),
    updateEnabledRulesets: vi.fn(({ enableRulesetIds = [], disableRulesetIds = [] }) => {
      if (enableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) {
        state.staticEnabled = true;
      }
      if (disableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) {
        state.staticEnabled = false;
      }
      return Promise.resolve();
    }),
  };

  chrome.storage.local.get.mockImplementation((defaults) => {
    const base = typeof defaults === 'object' && defaults !== null ? { ...defaults } : {};
    return Promise.resolve({
      ...base,
      [CUSTOM_PROVIDERS_STORAGE_KEY]: structuredClone(state.localRecords),
    });
  });
  chrome.storage.local.set.mockImplementation((items) => {
    if (CUSTOM_PROVIDERS_STORAGE_KEY in items) {
      state.localRecords = structuredClone(items[CUSTOM_PROVIDERS_STORAGE_KEY]);
    }
    return Promise.resolve();
  });

  chrome.storage.sync.get.mockImplementation((defaults) => {
    const base = typeof defaults === 'object' && defaults !== null ? { ...defaults } : {};
    return Promise.resolve({
      ...base,
      enabledProviders: [...state.enabledProviders],
    });
  });
  chrome.storage.sync.set.mockResolvedValue();

  globalThis.fetch = vi.fn((url) => {
    expect(url).toBe(`${EXTENSION_ORIGIN}/rules/bypass-headers.json`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(structuredClone(STATIC_RULES)),
    });
  });

  return state;
}

describe('Custom API provider descriptors, validation, storage, and DNR Origin-strip rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCustomProviderDescriptors([]);
  });

  afterEach(() => {
    setCustomProviderDescriptors([]);
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it('transforms kind="api" records into frozen descriptors with built-in panel URL and zero raw secrets', () => {
    installStatefulChromeEnv();
    const descriptor = toCustomProviderDescriptor(API_RECORD_OLLAMA_B);

    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.apiConfig)).toBe(true);
    expect(Object.isFrozen(descriptor.apiOriginRule)).toBe(true);
    expect(descriptor).toEqual({
      id: 'custom-b1b2b3b4b5',
      name: 'Ollama Qwen Coder',
      url: `${EXTENSION_ORIGIN}/${CUSTOM_API_PANEL_PATH}?providerId=custom-b1b2b3b4b5`,
      topLevelUrl: null,
      icon: '/icons/providers/custom.svg',
      iconDark: '/icons/providers/dark/custom.svg',
      enabled: true,
      access: 'custom',
      customKind: 'api',
      frameOrigins: [EXTENSION_ORIGIN],
      allowedHosts: [],
      permissionOrigins: ['http://localhost:11434/*'],
      contentScript: null,
      frameRule: null,
      apiOriginRule: {
        id: 10001,
        urlFilter: '|http://localhost:11434/',
      },
      apiConfig: {
        endpointUrl: 'http://localhost:11434/v1/chat/completions',
        apiOrigin: 'http://localhost:11434',
        model: 'qwen2.5-coder:32b',
        hasApiKey: false,
      },
      tempChat: null,
      capabilities: {
        imageUpload: true,
        inPageNewChat: true,
        snapshotStitch: true,
      },
    });
    expect('apiKey' in descriptor).toBe(false);
    expect('apiKey' in descriptor.apiConfig).toBe(false);
    expect(validateProviderDescriptor(descriptor)).toEqual([]);

    expect(() =>
      toCustomProviderDescriptor({ ...API_RECORD_OLLAMA_A, apiKey: 'sk-leaked' })
    ).toThrow(/apiKey/i);
  });

  it('enforces strict validateProviderDescriptor invariants and rule ID uniqueness across Web and API custom descriptors', () => {
    installStatefulChromeEnv();
    const validApi = toCustomProviderDescriptor(API_RECORD_OLLAMA_A);

    expect(
      validateProviderDescriptor({
        ...validApi,
        apiKey: 'sk-123',
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/apiKey/i)]));

    expect(
      validateProviderDescriptor({
        ...validApi,
        apiConfig: { ...validApi.apiConfig, apiKey: 'sk-123' },
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/apiKey/i)]));

    expect(
      validateProviderDescriptor({
        ...validApi,
        topLevelUrl: 'http://localhost:11434',
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/topLevelUrl/i)]));

    expect(
      validateProviderDescriptor({
        ...validApi,
        contentScript: { matches: ['http://localhost:11434/*'], js: ['foo.js'] },
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/contentScript/i)]));

    expect(
      validateProviderDescriptor({
        ...validApi,
        frameRule: { id: 10000, urlFilter: '|http://localhost:11434/' },
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/frameRule/i)]));

    expect(
      validateProviderDescriptor({
        ...validApi,
        frameOrigins: ['http://localhost:11434'],
      })
    ).toEqual(expect.arrayContaining([expect.stringMatching(/extension frame origin/i)]));

    const webWithSameRuleId = toCustomProviderDescriptor({
      ...WEB_RECORD_C,
      frameRuleId: 10000,
    });
    expect(() => setCustomProviderDescriptors([validApi, webWithSameRuleId])).toThrow(
      /Duplicate frameRule[.\s]id/i
    );
  });

  it('allows multiple API models on the same origin while rejecting built-in origins, insecure remote HTTP, credentials, and raw apiKey', async () => {
    const state = installStatefulChromeEnv();

    expect(validateCustomApiEndpointUrl('https://chatgpt.com/v1')).toMatchObject({
      ok: false,
      reason: 'builtin_origin',
    });
    expect(validateCustomApiEndpointUrl('http://api.example.com/v1')).toMatchObject({
      ok: false,
      reason: 'insecure_http',
    });
    expect(validateCustomApiEndpointUrl('https://user:secret@api.example.com/v1')).toMatchObject({
      ok: false,
      reason: 'credentials_not_allowed',
    });
    expect(validateCustomApiEndpointUrl('https://openrouter.ai/api/v1')).toEqual({
      ok: true,
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      origin: 'https://openrouter.ai',
      reason: null,
    });

    await expect(
      addCustomProvider({
        ...API_RECORD_OLLAMA_A,
        apiKey: 'sk-should-fail',
      })
    ).rejects.toThrow(/apiKey/i);

    const savedA = await addCustomProvider(API_RECORD_OLLAMA_A);
    const nextRuleId = allocateCustomFrameRuleId();
    expect(nextRuleId).toBe(10001);

    const savedB = await addCustomProvider({
      ...API_RECORD_OLLAMA_B,
      frameRuleId: nextRuleId,
    });

    expect(savedA.endpointUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(savedB.endpointUrl).toBe('http://localhost:11434/v1/chat/completions');
    expect(state.localRecords).toHaveLength(2);
    expect(JSON.stringify(state.localRecords)).not.toContain('apiKey');

    expect(getCustomProviderOrigin(savedA.id)).toBe('http://localhost:11434');
    expect(getCustomProviderOrigin(savedB.id)).toBe('http://localhost:11434');

    // Inject a tampered record containing apiKey into storage.local and confirm loadCustomProviders drops it
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    state.localRecords.push({
      id: 'custom-d1d2d3d4d5',
      kind: 'api',
      name: 'Tampered',
      endpointUrl: 'https://api.example.com/v1/chat/completions',
      model: 'gpt-4o',
      apiKey: 'sk-tampered',
      frameRuleId: 10005,
      createdAt: 1700000005000,
    });

    const loadResult = await loadCustomProviders();
    expect(loadResult).toEqual({ ok: true });
    expect(
      listProviderDescriptors()
        .filter((d) => d.access === 'custom')
        .map((d) => d.id)
    ).toEqual([savedA.id, savedB.id]);
    expect(warnSpy).toHaveBeenCalled();

    expect(await removeCustomProvider(savedA.id)).toBe(true);
    expect(state.localRecords.map((r) => r.id)).toEqual([savedB.id]);
  });

  it('installs Origin-removal DNR rules and zero content scripts for enabled+permitted API providers on Chrome >= 145', async () => {
    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      grantedOrigins: ['http://localhost:11434/*', 'https://webui.example.com/*'],
      localRecords: [API_RECORD_OLLAMA_A, API_RECORD_OLLAMA_B, WEB_RECORD_C],
      enabledProviders: [API_RECORD_OLLAMA_A.id, API_RECORD_OLLAMA_B.id, WEB_RECORD_C.id],
    });

    await reconcileOptionalProviderAccess();

    const customDynamicRules = state.dynamicRules
      .filter((rule) => rule.id >= 10000)
      .sort((a, b) => a.id - b.id);
    expect(customDynamicRules).toEqual([
      expectedApiOriginDnrRule(10000, 'http://localhost:11434'),
      expectedApiOriginDnrRule(10001, 'http://localhost:11434'),
      {
        id: 10002,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'X-Frame-Options', operation: 'remove' },
            { header: 'Content-Security-Policy', operation: 'remove' },
          ],
        },
        condition: {
          urlFilter: '|https://webui.example.com/',
          resourceTypes: ['sub_frame'],
          topDomains: [EXTENSION_ID],
        },
      },
    ]);

    // Only the Web UI custom provider gets content scripts; API providers register zero scripts!
    expect(state.registeredScripts.map((s) => s.id)).toEqual([
      `${WEB_RECORD_C.id}-scripts`,
      `${WEB_RECORD_C.id}-cookie-scripts`,
    ]);

    // Revoking localhost permission removes both API DNR rules while keeping Web UI rule
    state.grantedOrigins.delete('http://localhost:11434/*');
    await syncOptionalProviderAccess([
      API_RECORD_OLLAMA_A.id,
      API_RECORD_OLLAMA_B.id,
      WEB_RECORD_C.id,
    ]);
    expect(state.dynamicRules.filter((rule) => rule.id >= 10000).map((r) => r.id)).toEqual([
      10002,
    ]);
  });

  it('omits custom API Origin-removal DNR rules when supportsScopedFrameRules() is false (Chrome < 145)', async () => {
    const state = installStatefulChromeEnv({
      topDomainsSupported: false,
      grantedOrigins: ['http://localhost:11434/*'],
      localRecords: [API_RECORD_OLLAMA_A],
      enabledProviders: [API_RECORD_OLLAMA_A.id],
    });

    await reconcileOptionalProviderAccess();

    expect(state.dynamicRules.filter((rule) => rule.id >= 10000)).toEqual([]);
    expect(state.registeredScripts).toEqual([]);
  });

  it('enforces provider-open-url guards for customKind === "api" including explicit "null" origin rejection', () => {
    installStatefulChromeEnv();
    const apiDescriptor = toCustomProviderDescriptor(API_RECORD_OLLAMA_A);
    setCustomProviderDescriptors([apiDescriptor]);

    expect(isProviderFrameOrigin(apiDescriptor.id, 'null')).toBe(false);
    expect(isProviderFrameOrigin(apiDescriptor.id, 'http://localhost:11434')).toBe(false);
    expect(isProviderFrameOrigin(apiDescriptor.id, EXTENSION_ORIGIN)).toBe(true);

    expect(getProviderFallbackUrl(apiDescriptor.id)).toBe('');
    expect(isProviderCurrentUrl(apiDescriptor.id, apiDescriptor.url)).toBe(false);
    expect(isProviderCurrentUrl(apiDescriptor.id, 'https://evil.example/phish')).toBe(false);

    expect(isProviderAllowedUrl(apiDescriptor.id, apiDescriptor.url)).toBe(true);
    expect(isProviderAllowedUrl(apiDescriptor.id, 'https://docs.example.com/guide')).toBe(false);
    expect(isProviderAllowedUrl(apiDescriptor.id, 'javascript:alert(1)')).toBe(false);
    expect(isProviderAllowedUrl(apiDescriptor.id, `${EXTENSION_ORIGIN}/options/options.html`)).toBe(
      false
    );
  });

  it('updates custom Web and API providers in place while preserving id, frameRuleId, createdAt, and kind invariants', async () => {
    const state = installStatefulChromeEnv();
    await addCustomProvider(API_RECORD_OLLAMA_A);
    await addCustomProvider(WEB_RECORD_C);
    await addCustomProvider({
      id: 'custom-e1e2e3e4e5',
      name: 'Other WebUI',
      url: 'https://otherweb.example.com/chat',
      frameRuleId: 10003,
      createdAt: 1700000003000,
    });

    const updatedApi = await updateCustomProvider(API_RECORD_OLLAMA_A.id, {
      name: 'OpenRouter DeepSeek',
      endpointUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4.1-flash',
      hasApiKey: true,
    });
    expect(updatedApi).toEqual({
      id: API_RECORD_OLLAMA_A.id,
      kind: 'api',
      name: 'OpenRouter DeepSeek',
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'deepseek/deepseek-v4.1-flash',
      hasApiKey: true,
      frameRuleId: API_RECORD_OLLAMA_A.frameRuleId,
      createdAt: API_RECORD_OLLAMA_A.createdAt,
    });
    expect(getCustomProviderOrigin(API_RECORD_OLLAMA_A.id)).toBe('https://openrouter.ai');
    expect(state.localRecords.find((r) => r.id === API_RECORD_OLLAMA_A.id)).toEqual(updatedApi);

    // Self-origin edit on Web custom provider succeeds while colliding with another Web origin fails
    const updatedWeb = await updateCustomProvider(WEB_RECORD_C.id, {
      name: 'Self-Hosted WebUI v2',
      url: 'https://webui.example.com/v2/chat',
    });
    expect(updatedWeb).toEqual({
      id: WEB_RECORD_C.id,
      name: 'Self-Hosted WebUI v2',
      url: 'https://webui.example.com/v2/chat',
      frameRuleId: WEB_RECORD_C.frameRuleId,
      createdAt: WEB_RECORD_C.createdAt,
    });

    await expect(
      updateCustomProvider(WEB_RECORD_C.id, {
        name: 'Collision Attempt',
        url: 'https://otherweb.example.com/app',
      })
    ).rejects.toMatchObject({ reason: 'duplicate_custom_origin' });

    // Kind switching, raw apiKey, and unknown IDs are strictly rejected
    await expect(
      updateCustomProvider(API_RECORD_OLLAMA_A.id, {
        kind: 'web',
        name: 'Kind Tamper',
        url: 'https://kindtamper.example.com/',
      })
    ).rejects.toThrow(/Cannot change custom provider kind/i);

    await expect(
      updateCustomProvider(API_RECORD_OLLAMA_A.id, {
        name: 'Key Leak Attempt',
        endpointUrl: 'https://openrouter.ai/api/v1',
        model: 'deepseek/deepseek-v4.1-flash',
        apiKey: 'sk-should-reject',
      })
    ).rejects.toThrow(/apiKey/i);

    await expect(
      updateCustomProvider('custom-9999999999', {
        name: 'Ghost',
        url: 'https://ghost.example.com/',
      })
    ).rejects.toThrow(/not found/i);
  });
});
