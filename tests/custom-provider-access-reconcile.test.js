import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import {
  SCOPED_RULE_ID_OFFSET,
  STATIC_FRAME_RULESET_ID,
  restrictRuleToTopDomains,
  supportsScopedFrameRules as supportsScopedFromRules,
} from '../modules/frame-header-rules.js';
import {
  OPTIONAL_PROVIDER_CONFIGS,
  filterProvidersWithGrantedAccess,
  hasOptionalProviderPermission,
  reconcileOptionalProviderAccess,
  requestOptionalProviderPermission,
  supportsScopedFrameRules,
  syncOptionalProviderAccess,
} from '../modules/optional-provider-access.js';
import { setCustomProviderDescriptors } from '../modules/provider-registry.js';
import { getEnabledProviders } from '../modules/providers.js';

const STATIC_RULES = JSON.parse(
  readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8')
);
const EXTENSION_ID = 'panelize-b2-test-ext-id';

const CUSTOM_RECORD_A = {
  id: 'custom-0123456789',
  name: 'Local Open WebUI',
  url: 'http://127.0.0.1:3000/chat',
  frameRuleId: 10000,
  createdAt: 1700000000000,
};

const CUSTOM_RECORD_B = {
  id: 'custom-abcdef0123',
  name: 'Hosted Chat',
  url: 'https://chat.example.com/app',
  frameRuleId: 10001,
  createdAt: 1700000001000,
};

function expectedScopedCustomRule(id, origin) {
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'X-Frame-Options', operation: 'remove' },
        { header: 'Content-Security-Policy', operation: 'remove' },
      ],
    },
    condition: {
      urlFilter: `|${origin}/`,
      resourceTypes: ['sub_frame'],
      topDomains: [EXTENSION_ID],
    },
  };
}

function expectedCustomContentScript(providerId, origin) {
  return {
    id: `${providerId}-scripts`,
    matches: [`${origin}/*`],
    js: ['content-scripts/custom-provider-driver.js'],
    allFrames: true,
    persistAcrossSessions: true,
    world: 'ISOLATED',
    runAt: 'document_start',
  };
}

function expectedCustomCookieConsentScript(providerId, origin) {
  return {
    id: `${providerId}-cookie-scripts`,
    matches: [`${origin}/*`],
    js: ['content-scripts/custom-provider-cookie-consent.js'],
    allFrames: true,
    persistAcrossSessions: true,
    world: 'MAIN',
    runAt: 'document_start',
  };
}

/**
 * Evaluates Chrome declarativeNetRequest `urlFilter` matching for left-anchored
 * `|<prefix>` filters (where `|` anchors to the start of the URL and literal
 * characters match exact code units).
 */
function matchesLeftAnchoredDnrUrlFilter(urlFilter, candidateUrl) {
  expect(urlFilter.startsWith('|')).toBe(true);
  expect(urlFilter.slice(1)).not.toMatch(/[|^]/);
  const anchoredPrefix = urlFilter.slice(1);
  // Escape regex metacharacters except `*` (DNR wildcard).
  const pattern =
    '^' +
    anchoredPrefix
      .replace(/[.+?${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
  return new RegExp(pattern).test(candidateUrl);
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
    (path = '') => `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\/+/, '')}`
  );

  chrome.permissions = {
    contains: vi.fn(({ origins = [] } = {}) =>
      Promise.resolve(origins.length > 0 && origins.every((origin) => state.grantedOrigins.has(origin)))
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
      if (!topDomainsSupported && addRules.some(({ condition }) => 'topDomains' in condition)) {
        return Promise.reject(new Error("Unexpected property: 'topDomains'."));
      }
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
      state.dnrCalls.push({
        type: 'updateEnabledRulesets',
        enableRulesetIds: [...enableRulesetIds],
        disableRulesetIds: [...disableRulesetIds],
      });
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

  chrome.storage.sync.get.mockImplementation((defaults) => {
    const base = typeof defaults === 'object' && defaults !== null ? { ...defaults } : {};
    return Promise.resolve({
      ...base,
      enabledProviders: [...state.enabledProviders],
    });
  });
  chrome.storage.sync.set.mockResolvedValue();

  globalThis.fetch = vi.fn((url) => {
    expect(url).toBe(`chrome-extension://${EXTENSION_ID}/rules/bypass-headers.json`);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(structuredClone(STATIC_RULES)),
    });
  });

  return state;
}

describe('custom provider access permissions, scoped DNR rules, and content-script reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCustomProviderDescriptors([]);
  });

  afterEach(() => {
    setCustomProviderDescriptors([]);
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  it('exports neutral supportsScopedFrameRules() from both frame-header-rules and optional-provider-access', () => {
    expect(supportsScopedFrameRules).toBe(supportsScopedFromRules);

    installStatefulChromeEnv({ topDomainsSupported: true });
    expect(supportsScopedFrameRules()).toBe(true);

    installStatefulChromeEnv({ topDomainsSupported: false });
    expect(supportsScopedFrameRules()).toBe(false);
  });

  it('requires granted origin permission for custom providers while keeping built-in and optional behaviour unchanged', async () => {
    const state = installStatefulChromeEnv({
      localRecords: [CUSTOM_RECORD_A, CUSTOM_RECORD_B],
      grantedOrigins: ['http://127.0.0.1:3000/*', 'https://aistudio.google.com/*', 'https://alkalimakersuite-pa.clients6.google.com/*'],
      enabledProviders: [CUSTOM_RECORD_A.id, CUSTOM_RECORD_B.id, 'chatgpt', 'aistudio', 'qwen-cn'],
    });
    setCustomProviderDescriptors([
      toCustomProviderDescriptor(CUSTOM_RECORD_A),
      toCustomProviderDescriptor(CUSTOM_RECORD_B),
    ]);

    // Granted custom vs ungranted custom vs missing/deleted custom
    await expect(hasOptionalProviderPermission(CUSTOM_RECORD_A.id)).resolves.toBe(true);
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({
      origins: ['http://127.0.0.1:3000/*'],
    });

    await expect(hasOptionalProviderPermission(CUSTOM_RECORD_B.id)).resolves.toBe(false);
    expect(chrome.permissions.contains).toHaveBeenLastCalledWith({
      origins: ['https://chat.example.com/*'],
    });

    await expect(hasOptionalProviderPermission('custom-deadbeef00')).resolves.toBe(false);
    await expect(requestOptionalProviderPermission('custom-deadbeef00')).resolves.toBe(false);

    // Built-in and non-custom unknown stay implicitly granted
    await expect(hasOptionalProviderPermission('chatgpt')).resolves.toBe(true);
    await expect(hasOptionalProviderPermission('unknown-provider')).resolves.toBe(true);

    // filterProvidersWithGrantedAccess & getEnabledProviders exclude ungranted/missing custom panels
    await expect(
      filterProvidersWithGrantedAccess([
        CUSTOM_RECORD_A.id,
        CUSTOM_RECORD_B.id,
        'custom-deadbeef00',
        'chatgpt',
        'aistudio',
        'qwen-cn',
      ])
    ).resolves.toEqual([CUSTOM_RECORD_A.id, 'chatgpt', 'aistudio']);

    const enabled = await getEnabledProviders();
    expect(enabled.map((p) => p.id)).toEqual(['chatgpt', 'aistudio', CUSTOM_RECORD_A.id]);

    // requestOptionalProviderPermission requests exact custom permissionOrigins
    await expect(requestOptionalProviderPermission(CUSTOM_RECORD_B.id)).resolves.toBe(true);
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://chat.example.com/*'],
    });
    await expect(hasOptionalProviderPermission(CUSTOM_RECORD_B.id)).resolves.toBe(true);

    // Revoking custom permission immediately hides custom panel from granted filter
    state.grantedOrigins.delete('http://127.0.0.1:3000/*');
    await expect(hasOptionalProviderPermission(CUSTOM_RECORD_A.id)).resolves.toBe(false);

    // Missing chrome.permissions fails closed for custom
    chrome.permissions = undefined;
    await expect(hasOptionalProviderPermission(CUSTOM_RECORD_B.id)).resolves.toBe(false);
    await expect(requestOptionalProviderPermission(CUSTOM_RECORD_B.id)).resolves.toBe(false);
  });

  it('reconciles active -> inactive -> revoked -> deleted transitions accurately without touching synced preferences', async () => {
    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      localRecords: [CUSTOM_RECORD_A, CUSTOM_RECORD_B],
      grantedOrigins: ['http://127.0.0.1:3000/*', 'https://chat.example.com/*'],
      enabledProviders: [CUSTOM_RECORD_A.id, CUSTOM_RECORD_B.id, 'chatgpt'],
    });

    // 1. Active: both custom entries enabled and granted
    await reconcileOptionalProviderAccess();

    expect(state.registeredScripts).toEqual([
      expectedCustomContentScript(CUSTOM_RECORD_A.id, 'http://127.0.0.1:3000'),
      expectedCustomContentScript(CUSTOM_RECORD_B.id, 'https://chat.example.com'),
      expectedCustomCookieConsentScript(CUSTOM_RECORD_B.id, 'https://chat.example.com'),
    ]);
    expect(state.dynamicRules).toContainEqual(
      expectedScopedCustomRule(10000, 'http://127.0.0.1:3000')
    );
    expect(state.dynamicRules).toContainEqual(
      expectedScopedCustomRule(10001, 'https://chat.example.com')
    );
    expect(state.staticEnabled).toBe(false);

    // 2. Inactive: disable CUSTOM_RECORD_B in enabledProviders (permission remains granted)
    state.enabledProviders = [CUSTOM_RECORD_A.id, 'chatgpt'];
    await reconcileOptionalProviderAccess();

    expect(state.registeredScripts).toEqual([
      expectedCustomContentScript(CUSTOM_RECORD_A.id, 'http://127.0.0.1:3000'),
    ]);
    expect(state.dynamicRules.some(({ id }) => id === 10001)).toBe(false);
    expect(state.dynamicRules).toContainEqual(
      expectedScopedCustomRule(10000, 'http://127.0.0.1:3000')
    );

    // 3. Revoked: revoke CUSTOM_RECORD_A origin while still in enabledProviders
    state.grantedOrigins.delete('http://127.0.0.1:3000/*');
    await reconcileOptionalProviderAccess();

    expect(state.registeredScripts).toEqual([]);
    expect(state.dynamicRules.some(({ id }) => id >= 10000 && id <= 19999)).toBe(false);
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();

    // 4. Re-grant CUSTOM_RECORD_A, then delete its record from storage.local
    state.grantedOrigins.add('http://127.0.0.1:3000/*');
    await reconcileOptionalProviderAccess();
    expect(state.registeredScripts).toHaveLength(1);
    expect(state.dynamicRules.some(({ id }) => id === 10000)).toBe(true);

    state.localRecords = [];
    await reconcileOptionalProviderAccess();

    expect(state.registeredScripts).toEqual([]);
    expect(state.dynamicRules.some(({ id }) => id === 10000)).toBe(false);
  });

  it('cleans up orphan custom scripts and orphan 10xxx rules while leaving non-managed ids untouched', async () => {
    const nonManagedRules = [
      { id: 2001, priority: 1, action: { type: 'modifyHeaders' }, condition: { urlFilter: 'wss://grok.com/*' } },
      { id: 9999, priority: 1, action: { type: 'allow' }, condition: { urlFilter: 'https://keep-low.example/*' } },
      { id: 20000, priority: 1, action: { type: 'allow' }, condition: { urlFilter: 'https://keep-high.example/*' } },
    ];
    const orphanRule = expectedScopedCustomRule(10042, 'https://orphan.example.com');

    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      dynamicRules: [...nonManagedRules, orphanRule],
      registeredScripts: [
        { id: 'custom-deadbeef00-scripts', matches: ['https://orphan.example.com/*'] },
        { id: 'unrelated-script', matches: ['https://unrelated.example.com/*'] },
        { id: 'custom-not10hex-scripts', matches: ['https://unrelated2.example.com/*'] },
      ],
      localRecords: [CUSTOM_RECORD_A],
      grantedOrigins: ['http://127.0.0.1:3000/*'],
      enabledProviders: [CUSTOM_RECORD_A.id],
    });

    await reconcileOptionalProviderAccess();

    // Orphan custom-deadbeef00-scripts removed; non-managed scripts kept; active custom registered
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['custom-deadbeef00-scripts'],
    });
    expect(state.registeredScripts.map(({ id }) => id)).toEqual([
      'unrelated-script',
      'custom-not10hex-scripts',
      'custom-0123456789-scripts',
    ]);

    // Orphan rule 10042 removed; non-managed rules 2001, 9999, 20000 kept; active rule 10000 installed
    expect(state.dynamicRules.some(({ id }) => id === 10042)).toBe(false);
    expect(state.dynamicRules).toContainEqual(nonManagedRules[0]);
    expect(state.dynamicRules).toContainEqual(nonManagedRules[1]);
    expect(state.dynamicRules).toContainEqual(nonManagedRules[2]);
    expect(state.dynamicRules).toContainEqual(
      expectedScopedCustomRule(10000, 'http://127.0.0.1:3000')
    );
  });

  it('skips all custom add and remove work when loadCustomProviders() returns ok: false while still reconciling built-ins', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const existingCustomRule = expectedScopedCustomRule(10000, 'http://127.0.0.1:3000');
    const existingOrphanRule = expectedScopedCustomRule(10099, 'https://keep-on-error.example.com');
    const existingCustomScript = expectedCustomContentScript(
      CUSTOM_RECORD_A.id,
      'http://127.0.0.1:3000'
    );

    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      dynamicRules: [existingCustomRule, existingOrphanRule],
      registeredScripts: [
        existingCustomScript,
        { id: 'custom-deadbeef00-scripts', matches: ['https://keep-on-error.example.com/*'] },
        { id: 'qwen-cn-scripts', matches: ['https://www.qianwen.com/*'] },
      ],
      grantedOrigins: [
        'http://127.0.0.1:3000/*',
        'https://chat.example.com/*',
        'https://aistudio.google.com/*',
        'https://alkalimakersuite-pa.clients6.google.com/*',
      ],
      enabledProviders: [CUSTOM_RECORD_A.id, CUSTOM_RECORD_B.id, 'aistudio'],
    });

    // Pre-populate registry with CUSTOM_RECORD_B to prove even in-memory custom entries are not added when hydration fails
    setCustomProviderDescriptors([toCustomProviderDescriptor(CUSTOM_RECORD_B)]);
    chrome.storage.local.get.mockRejectedValueOnce(new Error('Storage backend read failure'));

    await reconcileOptionalProviderAccess();

    expect(warnSpy).toHaveBeenCalled();

    // Built-in optional reconcile ran: qwen-cn unregistered, aistudio registered + scoped rule 1005 added
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['qwen-cn-scripts'],
    });
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
      OPTIONAL_PROVIDER_CONFIGS.aistudio.contentScript,
    ]);
    expect(state.dynamicRules).toContainEqual(
      restrictRuleToTopDomains(OPTIONAL_PROVIDER_CONFIGS.aistudio.frameRule, [EXTENSION_ID])
    );

    // Custom state completely untouched: existing 10000 & 10099 kept, 10001 NOT added, custom scripts kept
    expect(state.dynamicRules).toContainEqual(existingCustomRule);
    expect(state.dynamicRules).toContainEqual(existingOrphanRule);
    expect(state.dynamicRules.some(({ id }) => id === 10001)).toBe(false);
    expect(state.registeredScripts.map(({ id }) => id)).toEqual([
      'custom-0123456789-scripts',
      'custom-deadbeef00-scripts',
      'aistudio-scripts',
    ]);
  });

  it('never installs custom rules unscoped and omits custom scripts on Chrome < 145 (topDomains unavailable)', async () => {
    const staleScopedStatic = STATIC_RULES.map((rule) =>
      restrictRuleToTopDomains({ ...rule, id: SCOPED_RULE_ID_OFFSET + rule.id }, [EXTENSION_ID])
    );
    const staleCustomRule = expectedScopedCustomRule(10000, 'http://127.0.0.1:3000');

    const state = installStatefulChromeEnv({
      topDomainsSupported: false,
      staticEnabled: false,
      dynamicRules: [...staleScopedStatic, staleCustomRule],
      registeredScripts: [
        expectedCustomContentScript(CUSTOM_RECORD_A.id, 'http://127.0.0.1:3000'),
      ],
      localRecords: [CUSTOM_RECORD_A, CUSTOM_RECORD_B],
      grantedOrigins: [
        'http://127.0.0.1:3000/*',
        'https://chat.example.com/*',
        'https://chatglm.cn/*',
      ],
      enabledProviders: [CUSTOM_RECORD_A.id, CUSTOM_RECORD_B.id, 'chatglm'],
    });

    await reconcileOptionalProviderAccess();

    // Manifest static ruleset re-enabled and built-in optional rule 1003 installed unscoped
    expect(state.staticEnabled).toBe(true);
    expect(state.dynamicRules).toEqual([OPTIONAL_PROVIDER_CONFIGS.chatglm.frameRule]);

    // Zero custom rules installed (scoped or unscoped), and custom scripts are NOT registered
    expect(state.dynamicRules.some(({ id }) => id >= 10000 && id <= 19999)).toBe(false);
    expect(state.registeredScripts.map(({ id }) => id)).toEqual(['chatglm-scripts']);
  });

  it('omits custom rules and scripts while preserving built-in fallback when scoped rule installation throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      staticEnabled: true,
      localRecords: [CUSTOM_RECORD_A],
      grantedOrigins: ['http://127.0.0.1:3000/*', 'https://chat.z.ai/*'],
      enabledProviders: [CUSTOM_RECORD_A.id, 'zai-global'],
    });

    // Fail the first updateDynamicRules (the scoped batch), then succeed on the unscoped fallback
    chrome.declarativeNetRequest.updateDynamicRules.mockRejectedValueOnce(
      new Error('Simulated DNR scoped rule failure')
    );

    await reconcileOptionalProviderAccess();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(state.staticEnabled).toBe(true);
    expect(state.dynamicRules).toEqual([OPTIONAL_PROVIDER_CONFIGS['zai-global'].frameRule]);
    expect(state.dynamicRules.some(({ id }) => id >= 10000 && id <= 19999)).toBe(false);
    expect(state.registeredScripts.map(({ id }) => id)).toEqual(['zai-global-scripts']);
  });

  it('anchors custom urlFilter with |origin/ so it cannot match host.evil.com, subdomains, other ports, or other schemes', () => {
    const httpsDescriptor = toCustomProviderDescriptor(CUSTOM_RECORD_B);
    expect(httpsDescriptor.frameRule.urlFilter).toBe('|https://chat.example.com/');

    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://chat.example.com/'
      )
    ).toBe(true);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://chat.example.com/app?x=1'
      )
    ).toBe(true);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://chat.example.com.evil.com/'
      )
    ).toBe(false);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://sub.chat.example.com/'
      )
    ).toBe(false);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://chat.example.com:8443/'
      )
    ).toBe(false);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'http://chat.example.com/'
      )
    ).toBe(false);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        httpsDescriptor.frameRule.urlFilter,
        'https://wrapper.example/?next=https://chat.example.com/'
      )
    ).toBe(false);

    const portDescriptor = toCustomProviderDescriptor(CUSTOM_RECORD_A);
    expect(portDescriptor.frameRule.urlFilter).toBe('|http://127.0.0.1:3000/');

    expect(
      matchesLeftAnchoredDnrUrlFilter(
        portDescriptor.frameRule.urlFilter,
        'http://127.0.0.1:3000/chat'
      )
    ).toBe(true);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        portDescriptor.frameRule.urlFilter,
        'http://127.0.0.1:30000/chat'
      )
    ).toBe(false);
    expect(
      matchesLeftAnchoredDnrUrlFilter(
        portDescriptor.frameRule.urlFilter,
        'http://127.0.0.1:8080/chat'
      )
    ).toBe(false);
  });

  it('hydrates custom providers before computing managed cleanup on cold service-worker wake (zero churn)', async () => {
    const preInstalledStatic = STATIC_RULES.map((rule) =>
      restrictRuleToTopDomains({ ...rule, id: SCOPED_RULE_ID_OFFSET + rule.id }, [EXTENSION_ID])
    );
    const preInstalledCustomRule = expectedScopedCustomRule(10000, 'http://127.0.0.1:3000');
    const preInstalledCustomScript = expectedCustomContentScript(
      CUSTOM_RECORD_A.id,
      'http://127.0.0.1:3000'
    );

    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      staticEnabled: false,
      dynamicRules: [...preInstalledStatic, preInstalledCustomRule],
      registeredScripts: [preInstalledCustomScript],
      localRecords: [CUSTOM_RECORD_A],
      grantedOrigins: ['http://127.0.0.1:3000/*'],
      enabledProviders: [CUSTOM_RECORD_A.id, 'chatgpt'],
    });

    // Simulate cold service-worker wake: in-memory registry has zero custom entries initially
    setCustomProviderDescriptors([]);

    await reconcileOptionalProviderAccess();

    // Because reconcile hydrates storage.local BEFORE diffing rules/scripts, nothing was removed or re-added
    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
    expect(state.registeredScripts).toEqual([preInstalledCustomScript]);
    expect(state.dynamicRules).toContainEqual(preInstalledCustomRule);
  });

  it('also supports direct syncOptionalProviderAccess calls once custom providers are hydrated', async () => {
    const state = installStatefulChromeEnv({
      topDomainsSupported: true,
      grantedOrigins: ['http://127.0.0.1:3000/*'],
    });
    setCustomProviderDescriptors([toCustomProviderDescriptor(CUSTOM_RECORD_A)]);

    await syncOptionalProviderAccess([CUSTOM_RECORD_A.id]);

    expect(state.registeredScripts).toEqual([
      expectedCustomContentScript(CUSTOM_RECORD_A.id, 'http://127.0.0.1:3000'),
    ]);
    expect(state.dynamicRules).toContainEqual(
      expectedScopedCustomRule(10000, 'http://127.0.0.1:3000')
    );
  });
});
