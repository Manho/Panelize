function createContentScript(id, matches, enterBehaviorScript) {
  return {
    id,
    matches,
    js: [
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-utils.js',
      enterBehaviorScript,
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js'
    ],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true
  };
}

function createFrameRule(id, urlFilter) {
  // Installed only for enabled providers and scoped to their embedded subframes.
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        { header: 'X-Frame-Options', operation: 'remove' },
        { header: 'Content-Security-Policy', operation: 'remove' }
      ]
    },
    condition: {
      urlFilter,
      resourceTypes: ['sub_frame']
    }
  };
}

export const OPTIONAL_PROVIDER_CONFIGS = Object.freeze({
  'qwen-cn': Object.freeze({
    origins: Object.freeze(['https://www.qianwen.com/*']),
    contentScript: Object.freeze(createContentScript(
      'qwen-cn-scripts',
      ['https://www.qianwen.com/*'],
      'content-scripts/enter-behavior-qwen-cn.js'
    )),
    frameRule: Object.freeze(createFrameRule(1001, 'https://www.qianwen.com/*'))
  }),
  'qwen-global': Object.freeze({
    origins: Object.freeze(['https://chat.qwen.ai/*']),
    contentScript: Object.freeze(createContentScript(
      'qwen-global-scripts',
      ['https://chat.qwen.ai/*'],
      'content-scripts/enter-behavior-qwen-global.js'
    )),
    frameRule: Object.freeze(createFrameRule(1002, 'https://chat.qwen.ai/*'))
  })
});

export function getOptionalProviderConfig(providerId) {
  return OPTIONAL_PROVIDER_CONFIGS[providerId] || null;
}

export async function hasOptionalProviderPermission(providerId) {
  const config = getOptionalProviderConfig(providerId);
  if (!config) {
    return true;
  }

  return chrome.permissions.contains({ origins: [...config.origins] });
}

export function requestOptionalProviderPermission(providerId) {
  const config = getOptionalProviderConfig(providerId);
  if (!config) {
    return Promise.resolve(true);
  }

  return chrome.permissions.request({ origins: [...config.origins] });
}

export async function filterProvidersWithGrantedAccess(providerIds) {
  if (!Array.isArray(providerIds)) {
    return [];
  }

  const accessChecks = await Promise.all(providerIds.map(async (providerId) => ({
    providerId,
    granted: await hasOptionalProviderPermission(providerId)
  })));

  return accessChecks
    .filter(({ granted }) => granted)
    .map(({ providerId }) => providerId);
}

export async function syncOptionalProviderAccess(enabledProviderIds) {
  const enabledIds = new Set(Array.isArray(enabledProviderIds) ? enabledProviderIds : []);
  const configs = Object.entries(OPTIONAL_PROVIDER_CONFIGS);
  const desiredConfigs = [];

  for (const [providerId, config] of configs) {
    if (enabledIds.has(providerId) && await hasOptionalProviderPermission(providerId)) {
      desiredConfigs.push(config);
    }
  }

  await syncContentScripts(configs.map(([, config]) => config), desiredConfigs);
  await syncFrameRules(configs.map(([, config]) => config), desiredConfigs);
}

/**
 * Reconcile device-local scripts and frame rules with the synced provider preference.
 * Missing device permissions must never overwrite the user's synced preference.
 */
export async function reconcileOptionalProviderAccess() {
  try {
    const settings = await chrome.storage.sync.get({ enabledProviders: [] });
    const enabledProviderIds = Array.isArray(settings.enabledProviders)
      ? settings.enabledProviders
      : [];

    await syncOptionalProviderAccess(enabledProviderIds);
  } catch (error) {
    console.error('[Background] Failed to synchronize optional provider access:', error);
  }
}

async function syncContentScripts(allConfigs, desiredConfigs) {
  if (!chrome.scripting?.getRegisteredContentScripts) {
    return;
  }

  const managedScriptIds = new Set(allConfigs.map(({ contentScript }) => contentScript.id));
  const desiredScriptIds = new Set(desiredConfigs.map(({ contentScript }) => contentScript.id));
  const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
  const registeredManagedIds = registeredScripts
    .map(({ id }) => id)
    .filter((id) => managedScriptIds.has(id));
  const scriptIdsToRemove = registeredManagedIds.filter((id) => !desiredScriptIds.has(id));

  if (scriptIdsToRemove.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: scriptIdsToRemove });
  }

  const registeredIdSet = new Set(registeredManagedIds);
  const scriptsToRegister = desiredConfigs
    .map(({ contentScript }) => contentScript)
    .filter(({ id }) => !registeredIdSet.has(id));

  if (scriptsToRegister.length > 0) {
    await chrome.scripting.registerContentScripts(scriptsToRegister);
  }
}

async function syncFrameRules(allConfigs, desiredConfigs) {
  if (!chrome.declarativeNetRequest?.getDynamicRules) {
    return;
  }

  const managedRuleIds = new Set(allConfigs.map(({ frameRule }) => frameRule.id));
  const desiredRuleIds = new Set(desiredConfigs.map(({ frameRule }) => frameRule.id));
  const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();
  const installedManagedRuleIds = dynamicRules
    .map(({ id }) => id)
    .filter((id) => managedRuleIds.has(id));
  const removeRuleIds = installedManagedRuleIds.filter((id) => !desiredRuleIds.has(id));
  const installedRuleIdSet = new Set(installedManagedRuleIds);
  const addRules = desiredConfigs
    .map(({ frameRule }) => frameRule)
    .filter(({ id }) => !installedRuleIdSet.has(id));

  if (removeRuleIds.length > 0 || addRules.length > 0) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  }
}
