import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OPTIONAL_PROVIDER_CONFIGS,
  filterProvidersWithGrantedAccess,
  reconcileOptionalProviderAccess,
  requestOptionalProviderPermission,
  syncOptionalProviderAccess,
} from '../modules/optional-provider-access.js';

describe('optional provider access', () => {
  beforeEach(() => {
    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.scripting = {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
    };
    chrome.declarativeNetRequest = {
      getDynamicRules: vi.fn(() => Promise.resolve([])),
      updateDynamicRules: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.sync.get.mockImplementation((defaults) => Promise.resolve(defaults));
    chrome.storage.sync.set.mockResolvedValue();
  });

  it('uses separate narrow origins and script registrations for both Qwen sites', () => {
    expect(OPTIONAL_PROVIDER_CONFIGS['qwen-cn']).toMatchObject({
      origins: ['https://www.qianwen.com/*'],
      contentScript: {
        id: 'qwen-cn-scripts',
        matches: ['https://www.qianwen.com/*'],
      },
      frameRule: { id: 1001 },
    });
    expect(OPTIONAL_PROVIDER_CONFIGS['qwen-global']).toMatchObject({
      origins: ['https://chat.qwen.ai/*'],
      contentScript: {
        id: 'qwen-global-scripts',
        matches: ['https://chat.qwen.ai/*'],
      },
      frameRule: { id: 1002 },
    });
  });

  it('places each provider-specific Enter behavior script explicitly in registration order', () => {
    expect(OPTIONAL_PROVIDER_CONFIGS['qwen-cn'].contentScript.js).toEqual([
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-utils.js',
      'content-scripts/enter-behavior-qwen-cn.js',
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js',
    ]);
    expect(OPTIONAL_PROVIDER_CONFIGS['qwen-global'].contentScript.js).toEqual([
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-utils.js',
      'content-scripts/enter-behavior-qwen-global.js',
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js',
    ]);
  });

  it('requests only the selected provider origin', async () => {
    await expect(requestOptionalProviderPermission('qwen-cn')).resolves.toBe(true);

    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://www.qianwen.com/*'],
    });
  });

  it('reports a denied permission request without enabling access', async () => {
    chrome.permissions.request.mockResolvedValue(false);

    await expect(requestOptionalProviderPermission('qwen-global')).resolves.toBe(false);

    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://chat.qwen.ai/*'],
    });
  });

  it('keeps non-optional providers and removes optional providers without access', async () => {
    chrome.permissions.contains.mockImplementation(({ origins }) =>
      Promise.resolve(origins.includes('https://chat.qwen.ai/*'))
    );

    await expect(filterProvidersWithGrantedAccess([
      'chatgpt',
      'qwen-cn',
      'qwen-global',
    ])).resolves.toEqual(['chatgpt', 'qwen-global']);
  });

  it('never overwrites synced provider preferences when this device lacks permission', async () => {
    chrome.storage.sync.get.mockResolvedValue({
      enabledProviders: ['chatgpt', 'qwen-cn'],
    });
    chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
      { id: 'qwen-cn-scripts' },
    ]);
    chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([
      { id: 1001 },
    ]);

    await reconcileOptionalProviderAccess();

    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['qwen-cn-scripts'],
    });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1001],
      addRules: [],
    });
  });

  it('registers scripts and frame rules only for enabled providers with access', async () => {
    chrome.permissions.contains.mockImplementation(({ origins }) =>
      Promise.resolve(origins.includes('https://chat.qwen.ai/*'))
    );

    await syncOptionalProviderAccess(['qwen-cn', 'qwen-global']);

    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.registerContentScripts.mock.calls[0][0]).toEqual([
      expect.objectContaining({ id: 'qwen-global-scripts' }),
    ]);
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [],
      addRules: [expect.objectContaining({ id: 1002 })],
    });
  });

  it('removes managed scripts and rules when providers are disabled', async () => {
    chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
      { id: 'qwen-cn-scripts' },
      { id: 'qwen-global-scripts' },
      { id: 'unrelated-script' },
    ]);
    chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([
      { id: 1001 },
      { id: 1002 },
      { id: 9999 },
    ]);

    await syncOptionalProviderAccess([]);

    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['qwen-cn-scripts', 'qwen-global-scripts'],
    });
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1001, 1002],
      addRules: [],
    });
  });

  it('removes only the provider whose permission was manually revoked', async () => {
    chrome.permissions.contains.mockImplementation(({ origins }) =>
      Promise.resolve(origins.includes('https://chat.qwen.ai/*'))
    );
    chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
      { id: 'qwen-cn-scripts' },
      { id: 'qwen-global-scripts' },
    ]);
    chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([
      { id: 1001 },
      { id: 1002 },
    ]);

    await syncOptionalProviderAccess(['qwen-cn', 'qwen-global']);

    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({
      ids: ['qwen-cn-scripts'],
    });
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.declarativeNetRequest.updateDynamicRules).toHaveBeenCalledWith({
      removeRuleIds: [1001],
      addRules: [],
    });
  });

  it('does not duplicate already registered access', async () => {
    chrome.permissions.contains.mockResolvedValue(true);
    chrome.scripting.getRegisteredContentScripts.mockResolvedValue([
      { id: 'qwen-cn-scripts' },
      { id: 'qwen-global-scripts' },
    ]);
    chrome.declarativeNetRequest.getDynamicRules.mockResolvedValue([
      { id: 1001 },
      { id: 1002 },
    ]);

    await syncOptionalProviderAccess(['qwen-cn', 'qwen-global']);

    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(chrome.declarativeNetRequest.updateDynamicRules).not.toHaveBeenCalled();
  });
});
