import { loadCustomProviders } from './custom-providers.js';
import { syncFrameHeaderRules } from './frame-header-rules.js';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  listProviderDescriptors
} from './provider-registry.js';

const optionalConfigCache = new WeakMap();

function createContentScriptFromSpec(id, contentScriptSpec) {
  return {
    id,
    matches: [...contentScriptSpec.matches],
    js: [...contentScriptSpec.js],
    runAt: 'document_start',
    allFrames: true,
    persistAcrossSessions: true
  };
}

function createFrameRule(id, urlFilter) {
  // Installed only for enabled providers and scoped to their embedded subframes;
  // see frame-header-rules.js for the top-level page restriction.
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

function toOptionalProviderConfig(descriptor) {
  const cached = optionalConfigCache.get(descriptor);
  if (cached) {
    return cached;
  }

  const config = {
    origins: descriptor.permissionOrigins,
    contentScript: Object.freeze(
      createContentScriptFromSpec(`${descriptor.id}-scripts`, descriptor.contentScript)
    )
  };

  if (descriptor.frameRule) {
    config.frameRule = Object.freeze(
      createFrameRule(descriptor.frameRule.id, descriptor.frameRule.urlFilter)
    );
  }

  const frozen = Object.freeze(config);
  optionalConfigCache.set(descriptor, frozen);
  return frozen;
}

export const OPTIONAL_PROVIDER_CONFIGS = Object.freeze(
  Object.fromEntries(
    BUILTIN_PROVIDER_DESCRIPTORS
      .filter((descriptor) => descriptor.access === 'optional')
      .map((descriptor) => [descriptor.id, toOptionalProviderConfig(descriptor)])
  )
);

export function getOptionalProviderConfig(providerId) {
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor || descriptor.access !== 'optional') {
    return null;
  }
  return toOptionalProviderConfig(descriptor);
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
  const configs = listProviderDescriptors()
    .filter((descriptor) => descriptor.access === 'optional')
    .map((descriptor) => [descriptor.id, toOptionalProviderConfig(descriptor)]);
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
    await loadCustomProviders();
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
  await syncFrameHeaderRules({
    optionalRules: desiredConfigs.map(({ frameRule }) => frameRule).filter(Boolean),
    optionalRuleIds: allConfigs.map(({ frameRule }) => frameRule?.id).filter(Number.isInteger)
  });
}
