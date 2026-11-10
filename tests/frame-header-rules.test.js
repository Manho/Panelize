import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SCOPED_RULE_ID_OFFSET,
  STATIC_FRAME_RULESET_ID,
  syncFrameHeaderRules,
} from '../modules/frame-header-rules.js';
import { OPTIONAL_PROVIDER_CONFIGS } from '../modules/optional-provider-access.js';

const STATIC_RULES = JSON.parse(readFileSync(resolve(process.cwd(), 'rules/bypass-headers.json'), 'utf8'));
const OPTIONAL_RULES = Object.values(OPTIONAL_PROVIDER_CONFIGS).map(({ frameRule }) => frameRule).filter(Boolean);
const OPTIONAL_RULE_IDS = OPTIONAL_RULES.map(({ id }) => id);
const EXTENSION_ID = 'test-ext-id';

/**
 * A stateful declarativeNetRequest fake. Like Chrome, updateDynamicRules is
 * atomic, and before Chrome 145 (no RuleConditionKeys.TOP_DOMAINS) it rejects
 * a condition with topDomains.
 */
function installFakeDnr({ topDomainsSupported, dynamicRules = [], staticEnabled = true } = {}) {
  const state = { dynamicRules: structuredClone(dynamicRules), staticEnabled, calls: [] };
  chrome.declarativeNetRequest = {
    ...(topDomainsSupported ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } } : {}),
    getDynamicRules: vi.fn(() => Promise.resolve(structuredClone(state.dynamicRules))),
    updateDynamicRules: vi.fn(({ removeRuleIds = [], addRules = [] }) => {
      state.calls.push({ dynamic: { removeRuleIds, addIds: addRules.map(({ id }) => id) } });
      if (!topDomainsSupported && addRules.some(({ condition }) => 'topDomains' in condition)) {
        return Promise.reject(new Error("Unexpected property: 'topDomains'."));
      }
      state.dynamicRules = [
        ...state.dynamicRules.filter(({ id }) => !removeRuleIds.includes(id)),
        ...structuredClone(addRules),
      ];
      return Promise.resolve();
    }),
    getEnabledRulesets: vi.fn(() => Promise.resolve(state.staticEnabled ? [STATIC_FRAME_RULESET_ID] : [])),
    updateEnabledRulesets: vi.fn(({ enableRulesetIds = [], disableRulesetIds = [] }) => {
      state.calls.push({ rulesets: { enableRulesetIds, disableRulesetIds } });
      if (enableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) state.staticEnabled = true;
      if (disableRulesetIds.includes(STATIC_FRAME_RULESET_ID)) state.staticEnabled = false;
      return Promise.resolve();
    }),
  };
  return state;
}

function scopedStaticRules() {
  return STATIC_RULES.map((rule) => ({
    ...rule,
    id: SCOPED_RULE_ID_OFFSET + rule.id,
    condition: { ...rule.condition, topDomains: [EXTENSION_ID] },
  }));
}

function scoped(rule) {
  return { ...rule, condition: { ...rule.condition, topDomains: [EXTENSION_ID] } };
}

const sync = (optionalRules = OPTIONAL_RULES) => syncFrameHeaderRules({
  optionalRules,
  optionalRuleIds: OPTIONAL_RULE_IDS,
});

describe('frame header rule scoping', () => {
  let warn;

  beforeEach(() => {
    chrome.runtime.id = EXTENSION_ID;
    chrome.runtime.getURL = vi.fn((path) => `chrome-extension://${EXTENSION_ID}/${path}`);
    globalThis.fetch = vi.fn((url) => {
      expect(url).toBe(`chrome-extension://${EXTENSION_ID}/rules/bypass-headers.json`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(structuredClone(STATIC_RULES)) });
    });
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete globalThis.fetch;
  });

  describe('where topDomains is supported', () => {
    it('restricts every provider rule to this extension and disables the unscoped ruleset', async () => {
      const state = installFakeDnr({ topDomainsSupported: true, dynamicRules: [{ id: 9999, priority: 1 }] });

      await sync();

      expect(state.dynamicRules).toEqual([{ id: 9999, priority: 1 }, ...scopedStaticRules(), ...OPTIONAL_RULES.map(scoped)]);
      expect(state.staticEnabled).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps the action and URL filter of each manifest rule', () => {
      scopedStaticRules().forEach((rule, index) => {
        expect(rule.action).toEqual(STATIC_RULES[index].action);
        expect(rule.condition.urlFilter).toBe(STATIC_RULES[index].condition.urlFilter);
        expect(rule.condition.resourceTypes).toEqual(['sub_frame']);
      });
    });

    it('disables the unscoped ruleset only after the scoped rules are installed', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });

      await sync();

      expect(state.calls).toEqual([
        { dynamic: { removeRuleIds: [], addIds: [...scopedStaticRules(), ...OPTIONAL_RULES].map(({ id }) => id) } },
        { rulesets: { enableRulesetIds: [], disableRulesetIds: [STATIC_FRAME_RULESET_ID] } },
      ]);
    });

    it('replaces an unscoped optional rule installed by an earlier version', async () => {
      const unscopedQwen = structuredClone(OPTIONAL_RULES[0]);
      const state = installFakeDnr({ topDomainsSupported: true, dynamicRules: [unscopedQwen] });

      await sync([OPTIONAL_RULES[0]]);

      expect(state.calls[0].dynamic.removeRuleIds).toEqual([unscopedQwen.id]);
      expect(state.dynamicRules).toContainEqual(scoped(OPTIONAL_RULES[0]));
      expect(state.dynamicRules).not.toContainEqual(unscopedQwen);
    });

    it('makes no change once the rules are in place', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });
      await sync();
      state.calls.length = 0;

      await sync();

      expect(state.calls).toEqual([]);
    });

    it('scopes again after an update re-enabled the manifest ruleset', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });
      await sync();
      // Chrome restores the manifest default on every extension update;
      // dynamic rules persist.
      state.staticEnabled = true;
      state.calls.length = 0;

      await sync();

      expect(state.calls).toEqual([{ rulesets: { enableRulesetIds: [], disableRulesetIds: [STATIC_FRAME_RULESET_ID] } }]);
      expect(state.staticEnabled).toBe(false);
    });

    it('keeps the unscoped ruleset when the scoped rules cannot be installed', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });
      chrome.declarativeNetRequest.updateDynamicRules
        .mockRejectedValueOnce(new Error('Dynamic rule count exceeded.'));

      await sync();

      expect(state.staticEnabled).toBe(true);
      expect(chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
      expect(state.dynamicRules).toEqual(OPTIONAL_RULES);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('keeps the unscoped ruleset when the manifest rules cannot be read', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });
      globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve(null) });

      await sync();

      expect(state.staticEnabled).toBe(true);
      expect(state.dynamicRules).toEqual(OPTIONAL_RULES);
    });

    it('keeps the unscoped ruleset when an installed scoped rule does not match', async () => {
      const state = installFakeDnr({ topDomainsSupported: true });
      chrome.declarativeNetRequest.updateDynamicRules.mockImplementationOnce(() => Promise.resolve());

      await sync();

      expect(state.staticEnabled).toBe(true);
      expect(chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
    });
  });

  describe('where topDomains is not supported', () => {
    it('keeps the manifest ruleset and installs optional rules unscoped, as before', async () => {
      const state = installFakeDnr({ topDomainsSupported: false });

      await sync();

      expect(state.staticEnabled).toBe(true);
      expect(state.dynamicRules).toEqual(OPTIONAL_RULES);
      expect(chrome.declarativeNetRequest.updateEnabledRulesets).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('re-enables the manifest ruleset before removing scoped rules', async () => {
      const state = installFakeDnr({
        topDomainsSupported: false,
        staticEnabled: false,
        dynamicRules: [...scopedStaticRules(), ...OPTIONAL_RULES.map(scoped), { id: 9999, priority: 1 }],
      });

      await sync();

      expect(state.calls).toEqual([
        { rulesets: { enableRulesetIds: [STATIC_FRAME_RULESET_ID], disableRulesetIds: [] } },
        {
          dynamic: {
            removeRuleIds: [...scopedStaticRules(), ...OPTIONAL_RULES].map(({ id }) => id),
            addIds: OPTIONAL_RULE_IDS,
          },
        },
      ]);
      expect(state.dynamicRules).toEqual([{ id: 9999, priority: 1 }, ...OPTIONAL_RULES]);
      expect(state.staticEnabled).toBe(true);
    });
  });

  it('does nothing without the declarativeNetRequest API', async () => {
    chrome.declarativeNetRequest = undefined;
    await expect(sync()).resolves.toBeUndefined();
  });
});
