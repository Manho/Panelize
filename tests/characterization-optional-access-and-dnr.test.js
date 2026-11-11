import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPTIONAL_PROVIDER_CONFIGS,
  filterProvidersWithGrantedAccess,
  getOptionalProviderConfig,
  hasOptionalProviderPermission,
  reconcileOptionalProviderAccess,
  requestOptionalProviderPermission,
  syncOptionalProviderAccess,
} from '../modules/optional-provider-access.js';
import {
  SCOPED_RULE_ID_OFFSET,
  STATIC_FRAME_RULESET_ID,
  STATIC_FRAME_RULES_PATH,
  isSameRule,
  isScopedStaticRuleId,
  restrictRuleToTopDomains,
  syncFrameHeaderRules,
} from '../modules/frame-header-rules.js';

const STATIC_RULES = JSON.parse(
  readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8')
);

const EXTENSION_ID = 'panelize-characterization-ext-id';

const EXPECTED_REMOVE_HEADERS_ACTION = {
  type: 'modifyHeaders',
  responseHeaders: [
    { header: 'X-Frame-Options', operation: 'remove' },
    { header: 'Content-Security-Policy', operation: 'remove' },
  ],
};

function expectedContentScript(providerId, matchPattern) {
  return {
    id: `${providerId}-scripts`,
    matches: [matchPattern],
    js: [
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-utils.js',
      `content-scripts/enter-behavior-${providerId}.js`,
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js',
    ],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true,
  };
}

function expectedFrameRule(id, urlFilter) {
  return {
    id,
    priority: 1,
    action: EXPECTED_REMOVE_HEADERS_ACTION,
    condition: {
      urlFilter,
      resourceTypes: ['sub_frame'],
    },
  };
}

const EXPECTED_OPTIONAL_CONFIGS = {
  'qwen-cn': {
    origins: ['https://www.qianwen.com/*'],
    contentScript: expectedContentScript('qwen-cn', 'https://www.qianwen.com/*'),
    frameRule: expectedFrameRule(1001, 'https://www.qianwen.com/*'),
  },
  'qwen-global': {
    origins: ['https://chat.qwen.ai/*', 'https://auth.qwen.ai/*'],
    contentScript: expectedContentScript('qwen-global', 'https://chat.qwen.ai/*'),
    frameRule: expectedFrameRule(1002, 'https://chat.qwen.ai/*'),
  },
  chatglm: {
    origins: ['https://chatglm.cn/*'],
    contentScript: expectedContentScript('chatglm', 'https://chatglm.cn/*'),
    frameRule: expectedFrameRule(1003, 'https://chatglm.cn/*'),
  },
  'zai-global': {
    origins: ['https://chat.z.ai/*'],
    contentScript: expectedContentScript('zai-global', 'https://chat.z.ai/*'),
    frameRule: expectedFrameRule(1004, 'https://chat.z.ai/*'),
  },
  yuanbao: {
    origins: ['https://yuanbao.tencent.com/*'],
    contentScript: expectedContentScript('yuanbao', 'https://yuanbao.tencent.com/*'),
  },
  aistudio: {
    origins: [
      'https://aistudio.google.com/*',
      'https://alkalimakersuite-pa.clients6.google.com/*',
    ],
    contentScript: expectedContentScript('aistudio', 'https://aistudio.google.com/*'),
    frameRule: expectedFrameRule(1005, 'https://aistudio.google.com/*'),
  },
};

function installStatefulDnr({ topDomainsSupported, dynamicRules = [], staticEnabled = true } = {}) {
  const state = {
    dynamicRules: structuredClone(dynamicRules),
    staticEnabled,
    calls: [],
  };

  chrome.declarativeNetRequest = {
    ...(topDomainsSupported ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } } : {}),
    getDynamicRules: vi.fn(() => Promise.resolve(structuredClone(state.dynamicRules))),
    updateDynamicRules: vi.fn(({ removeRuleIds = [], addRules = [] }) => {
      state.calls.push({
        type: 'updateDynamicRules',
        removeRuleIds: [...removeRuleIds],
        addRuleIds: addRules.map(({ id }) => id),
      });
      if (!topDomainsSupported && addRules.some(({ condition }) => 'topDomains' in condition)) {
        return Promise.reject(new Error("Unexpected property: 'topDomains'."));
      }
      state.dynamicRules = [
        ...state.dynamicRules.filter(({ id }) => !removeRuleIds.includes(id)),
        ...structuredClone(addRules),
      ];
      return Promise.resolve();
    }),
    getEnabledRulesets: vi.fn(() =>
      Promise.resolve(state.staticEnabled ? [STATIC_FRAME_RULESET_ID] : [])
    ),
    updateEnabledRulesets: vi.fn(({ enableRulesetIds = [], disableRulesetIds = [] }) => {
      state.calls.push({
        type: 'updateEnabledRulesets',
        enableRulesetIds: [...enableRulesetIds],
        disableRulesetIds: [...disableRulesetIds],
      });
      if (enableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) state.staticEnabled = true;
      if (disableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) state.staticEnabled = false;
      return Promise.resolve();
    }),
  };

  return state;
}

describe('characterization: optional provider configs, scripting registrations, and DNR rules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chrome.runtime.id = EXTENSION_ID;
    chrome.runtime.getURL = vi.fn((path = '') =>
      `chrome-extension://${EXTENSION_ID}/${String(path).replace(/^\/+/, '')}`
    );
    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.scripting = {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.sync.get.mockImplementation((defaults) => Promise.resolve(defaults));
    chrome.storage.sync.set.mockResolvedValue();
    globalThis.fetch = vi.fn((url) => {
      expect(url).toBe(`chrome-extension://${EXTENSION_ID}/rules/bypass-headers.json`);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(structuredClone(STATIC_RULES)),
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  describe('OPTIONAL_PROVIDER_CONFIGS exact structure', () => {
    it('matches the exact frozen configuration map for all 6 optional providers', () => {
      expect(Object.keys(OPTIONAL_PROVIDER_CONFIGS)).toEqual([
        'qwen-cn',
        'qwen-global',
        'chatglm',
        'zai-global',
        'yuanbao',
        'aistudio',
      ]);
      expect(OPTIONAL_PROVIDER_CONFIGS).toEqual(EXPECTED_OPTIONAL_CONFIGS);
      expect(Object.isFrozen(OPTIONAL_PROVIDER_CONFIGS)).toBe(true);
    });

    it('pins exact contentScript keys (no world property) and exact presence/absence of frameRule', () => {
      for (const [providerId, config] of Object.entries(OPTIONAL_PROVIDER_CONFIGS)) {
        expect(Object.isFrozen(config)).toBe(true);
        expect(Object.isFrozen(config.origins)).toBe(true);
        expect(Object.isFrozen(config.contentScript)).toBe(true);
        expect(Object.keys(config.contentScript)).toEqual([
          'id',
          'matches',
          'js',
          'runAt',
          'allFrames',
          'persistAcrossSessions',
        ]);
        expect('world' in config.contentScript).toBe(false);

        if (providerId === 'yuanbao') {
          expect('frameRule' in config).toBe(false);
          expect(config.frameRule).toBeUndefined();
        } else {
          expect('frameRule' in config).toBe(true);
          expect(Object.isFrozen(config.frameRule)).toBe(true);
        }
      }
    });

    it('returns config for optional providers and null for built-in or unknown providers', () => {
      for (const id of Object.keys(EXPECTED_OPTIONAL_CONFIGS)) {
        expect(getOptionalProviderConfig(id)).toEqual(EXPECTED_OPTIONAL_CONFIGS[id]);
      }
      for (const nonOptional of ['chatgpt', 'claude', 'doubao', 'unknown', '']) {
        expect(getOptionalProviderConfig(nonOptional)).toBeNull();
      }
    });
  });

  describe('permission helpers', () => {
    it('treats built-in and unknown providers as implicitly permitted without calling chrome.permissions', async () => {
      await expect(hasOptionalProviderPermission('chatgpt')).resolves.toBe(true);
      await expect(hasOptionalProviderPermission('unknown')).resolves.toBe(true);
      await expect(requestOptionalProviderPermission('chatgpt')).resolves.toBe(true);
      await expect(requestOptionalProviderPermission('unknown')).resolves.toBe(true);

      expect(chrome.permissions.contains).not.toHaveBeenCalled();
      expect(chrome.permissions.request).not.toHaveBeenCalled();
    });

    it('queries and requests exact origin copies for every optional provider', async () => {
      chrome.permissions.contains.mockResolvedValue(true);

      for (const [providerId, expected] of Object.entries(EXPECTED_OPTIONAL_CONFIGS)) {
        await expect(hasOptionalProviderPermission(providerId)).resolves.toBe(true);
        expect(chrome.permissions.contains).toHaveBeenLastCalledWith({
          origins: expected.origins,
        });

        await expect(requestOptionalProviderPermission(providerId)).resolves.toBe(true);
        expect(chrome.permissions.request).toHaveBeenLastCalledWith({
          origins: expected.origins,
        });
      }
    });

    it('returns an empty array when filterProvidersWithGrantedAccess receives a non-array', async () => {
      await expect(filterProvidersWithGrantedAccess(null)).resolves.toEqual([]);
      await expect(filterProvidersWithGrantedAccess(undefined)).resolves.toEqual([]);
      await expect(filterProvidersWithGrantedAccess('chatgpt')).resolves.toEqual([]);
    });
  });

  describe('syncOptionalProviderAccess and reconcileOptionalProviderAccess + syncFrameHeaderRules integration', () => {
    it('installs exact content scripts and scoped dynamic rules (3000+ static + optional) when topDomains is supported', async () => {
      const state = installStatefulDnr({
        topDomainsSupported: true,
        dynamicRules: [{ id: 2001, priority: 1, action: { type: 'modifyHeaders' }, condition: {} }],
      });

      const granted = new Set(['qwen-cn', 'yuanbao', 'aistudio']);
      chrome.permissions.contains.mockImplementation(({ origins }) =>
        Promise.resolve(
          origins.includes('https://www.qianwen.com/*') ||
            origins.includes('https://yuanbao.tencent.com/*') ||
            origins.includes('https://aistudio.google.com/*')
        )
      );

      chrome.storage.sync.get.mockResolvedValue({
        enabledProviders: ['chatgpt', ...granted, 'qwen-global'],
      });

      await reconcileOptionalProviderAccess();

      expect(chrome.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
      expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
        EXPECTED_OPTIONAL_CONFIGS['qwen-cn'].contentScript,
        EXPECTED_OPTIONAL_CONFIGS.yuanbao.contentScript,
        EXPECTED_OPTIONAL_CONFIGS.aistudio.contentScript,
      ]);

      // Dynamic rules: Grok rule 2001 untouched + 7 scoped static rules + 1001 & 1005 (yuanbao has no frameRule).
      expect(state.dynamicRules.map(({ id }) => id)).toEqual([
        2001,
        3001,
        3007,
        3002,
        3003,
        3004,
        3005,
        3008,
        1001,
        1005,
      ]);
      expect(state.staticEnabled).toBe(false);

      const expectedScopedRules = [
        ...STATIC_RULES.map((rule) =>
          restrictRuleToTopDomains({ ...rule, id: SCOPED_RULE_ID_OFFSET + rule.id }, [EXTENSION_ID])
        ),
        restrictRuleToTopDomains(EXPECTED_OPTIONAL_CONFIGS['qwen-cn'].frameRule, [EXTENSION_ID]),
        restrictRuleToTopDomains(EXPECTED_OPTIONAL_CONFIGS.aistudio.frameRule, [EXTENSION_ID]),
      ];
      expect(state.dynamicRules.slice(1)).toEqual(expectedScopedRules);
    });

    it('installs exact dynamic rule ids when all 6 optional providers are enabled and granted (scoped vs unscoped)', async () => {
      chrome.permissions.contains.mockResolvedValue(true);
      const allSixIds = Object.keys(EXPECTED_OPTIONAL_CONFIGS);

      // 1) Scoped (topDomains supported)
      const scopedState = installStatefulDnr({ topDomainsSupported: true });
      await syncOptionalProviderAccess(allSixIds);

      expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith(
        allSixIds.map((id) => EXPECTED_OPTIONAL_CONFIGS[id].contentScript)
      );
      expect(scopedState.dynamicRules.map(({ id }) => id)).toEqual([
        3001,
        3007,
        3002,
        3003,
        3004,
        3005,
        3008,
        1001,
        1002,
        1003,
        1004,
        1005,
      ]);
      expect(scopedState.staticEnabled).toBe(false);

      // 2) Unscoped fallback (topDomains unsupported)
      chrome.scripting.getRegisteredContentScripts.mockResolvedValue(
        allSixIds.map((id) => ({ id: `${id}-scripts` }))
      );
      const unscopedState = installStatefulDnr({
        topDomainsSupported: false,
        staticEnabled: false,
        dynamicRules: scopedState.dynamicRules,
      });

      await syncOptionalProviderAccess(['qwen-global', 'zai-global', 'yuanbao']);

      expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
        ids: ['qwen-cn-scripts', 'chatglm-scripts', 'aistudio-scripts'],
      });
      expect(unscopedState.staticEnabled).toBe(true);
      expect(unscopedState.dynamicRules).toEqual([
        EXPECTED_OPTIONAL_CONFIGS['qwen-global'].frameRule,
        EXPECTED_OPTIONAL_CONFIGS['zai-global'].frameRule,
      ]);
      expect(unscopedState.dynamicRules.map(({ id }) => id)).toEqual([1002, 1004]);
    });
  });

  describe('frame-header-rules exported constants and helpers', () => {
    it('exports exact static ruleset constants and scoped rule id bounds', () => {
      expect(STATIC_FRAME_RULESET_ID).toBe('bypass_headers');
      expect(STATIC_FRAME_RULES_PATH).toBe('rules/bypass-headers.json');
      expect(SCOPED_RULE_ID_OFFSET).toBe(3000);

      expect(isScopedStaticRuleId(3000)).toBe(false);
      expect(isScopedStaticRuleId(3001)).toBe(true);
      expect(isScopedStaticRuleId(3999)).toBe(true);
      expect(isScopedStaticRuleId(4000)).toBe(false);
      expect(isScopedStaticRuleId(1001)).toBe(false);
      expect(isScopedStaticRuleId('3001')).toBe(false);
    });

    it('compares rule signatures canonically in isSameRule regardless of property order', () => {
      const ruleA = expectedFrameRule(1001, 'https://www.qianwen.com/*');
      const ruleB = {
        condition: {
          resourceTypes: ['sub_frame'],
          urlFilter: 'https://www.qianwen.com/*',
        },
        action: {
          responseHeaders: [
            { operation: 'remove', header: 'X-Frame-Options' },
            { operation: 'remove', header: 'Content-Security-Policy' },
          ],
          type: 'modifyHeaders',
        },
        id: 1001,
      };
      expect(isSameRule(ruleA, ruleB)).toBe(true);
      expect(isSameRule(ruleA, { ...ruleB, id: 1002 })).toBe(false);
      expect(isSameRule(ruleA, restrictRuleToTopDomains(ruleB, [EXTENSION_ID]))).toBe(false);
    });

    it('installs only scoped static rules [3001, 3007, 3002, 3003, 3004, 3005, 3008] when no optional rules are active', async () => {
      const state = installStatefulDnr({ topDomainsSupported: true });

      await syncFrameHeaderRules({
        optionalRules: [],
        optionalRuleIds: [1001, 1002, 1003, 1004, 1005],
      });

      expect(state.dynamicRules.map(({ id }) => id)).toEqual([
        3001,
        3007,
        3002,
        3003,
        3004,
        3005,
        3008,
      ]);
      expect(state.staticEnabled).toBe(false);
    });
  });
});
