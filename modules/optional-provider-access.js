import { isCustomProviderId, loadCustomProviders } from './custom-providers.js';
import { supportsScopedFrameRules, syncFrameHeaderRulesWithStatus } from './frame-header-rules.js';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  getProviderDescriptor,
  listProviderDescriptors
} from './provider-registry.js';

export { supportsScopedFrameRules } from './frame-header-rules.js';

const optionalConfigCache = new WeakMap();
const CUSTOM_PROVIDER_SCRIPT_ID_PATTERN = /^custom-[0-9a-f]{10}-scripts$/;

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
  const descriptor = getProviderDescriptor(providerId);
  if (descriptor?.access === 'custom') {
    if (!chrome.permissions?.contains) {
      return false;
    }
    return Boolean(
      await chrome.permissions.contains({ origins: [...descriptor.permissionOrigins] })
    );
  }
  if (isCustomProviderId(providerId)) {
    return false;
  }

  const config = getOptionalProviderConfig(providerId);
  if (!config) {
    return true;
  }

  return chrome.permissions.contains({ origins: [...config.origins] });
}

export function requestOptionalProviderPermission(providerId) {
  const descriptor = getProviderDescriptor(providerId);
  if (descriptor?.access === 'custom') {
    if (!chrome.permissions?.request) {
      return Promise.resolve(false);
    }
    return chrome.permissions.request({ origins: [...descriptor.permissionOrigins] });
  }
  if (isCustomProviderId(providerId)) {
    return Promise.resolve(false);
  }

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

function isManagedCustomRuleId(id) {
  return (
    Number.isInteger(id) &&
    id >= CUSTOM_FRAME_RULE_ID_MIN &&
    id <= CUSTOM_FRAME_RULE_ID_MAX
  );
}

function isManagedCustomScriptId(id) {
  return typeof id === 'string' && CUSTOM_PROVIDER_SCRIPT_ID_PATTERN.test(id);
}

function createCustomApiOriginRule(id, urlFilter) {
  const extensionId = typeof chrome !== 'undefined' && typeof chrome?.runtime?.id === 'string'
    ? chrome.runtime.id
    : '';
  return {
    id,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Origin', operation: 'remove' }
      ]
    },
    condition: {
      urlFilter,
      initiatorDomains: [extensionId],
      resourceTypes: ['xmlhttprequest']
    }
  };
}

function createCustomProviderConfig(descriptor) {
  if (descriptor.customKind === 'api') {
    return {
      origins: descriptor.permissionOrigins,
      contentScript: null,
      frameRule: null,
      apiOriginRule: createCustomApiOriginRule(
        descriptor.apiOriginRule.id,
        descriptor.apiOriginRule.urlFilter
      )
    };
  }

  return {
    origins: descriptor.permissionOrigins,
    contentScript: {
      id: `${descriptor.id}-scripts`,
      matches: [...descriptor.contentScript.matches],
      js: [...descriptor.contentScript.js],
      allFrames: true,
      persistAcrossSessions: true,
      world: 'ISOLATED',
      runAt: 'document_start'
    },
    frameRule: createFrameRule(descriptor.frameRule.id, descriptor.frameRule.urlFilter),
    apiOriginRule: null
  };
}

export async function syncOptionalProviderAccess(
  enabledProviderIds,
  { reconcileCustom = true } = {}
) {
  const enabledIds = new Set(Array.isArray(enabledProviderIds) ? enabledProviderIds : []);
  const allDescriptors = listProviderDescriptors();
  const configs = allDescriptors
    .filter((descriptor) => descriptor.access === 'optional')
    .map((descriptor) => [descriptor.id, toOptionalProviderConfig(descriptor)]);
  const desiredConfigs = [];

  for (const [providerId, config] of configs) {
    if (enabledIds.has(providerId) && await hasOptionalProviderPermission(providerId)) {
      desiredConfigs.push(config);
    }
  }

  const candidateCustomConfigs = [];
  if (reconcileCustom && supportsScopedFrameRules()) {
    const customDescriptors = allDescriptors.filter(
      (descriptor) => descriptor.access === 'custom'
    );
    for (const descriptor of customDescriptors) {
      if (enabledIds.has(descriptor.id) && await hasOptionalProviderPermission(descriptor.id)) {
        candidateCustomConfigs.push(createCustomProviderConfig(descriptor));
      }
    }
  }

  const { scopedInstalled } = await syncFrameRules(
    configs.map(([, config]) => config),
    desiredConfigs,
    {
      customConfigs: candidateCustomConfigs,
      reconcileCustom
    }
  );
  const activeCustomConfigs = reconcileCustom && scopedInstalled ? candidateCustomConfigs : [];

  await syncContentScripts(
    configs.map(([, config]) => config),
    desiredConfigs,
    {
      desiredCustomConfigs: activeCustomConfigs,
      reconcileCustom
    }
  );
}

/**
 * Reconcile device-local scripts and frame rules with the synced provider preference.
 * Missing device permissions must never overwrite the user's synced preference.
 */
export async function reconcileOptionalProviderAccess() {
  try {
    const hydration = await loadCustomProviders();
    const settings = await chrome.storage.sync.get({ enabledProviders: [] });
    const enabledProviderIds = Array.isArray(settings.enabledProviders)
      ? settings.enabledProviders
      : [];

    await syncOptionalProviderAccess(enabledProviderIds, {
      reconcileCustom: hydration.ok
    });
  } catch (error) {
    console.error('[Background] Failed to synchronize optional provider access:', error);
  }
}

function isSameStringArray(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function matchesRegisteredCustomScript(registeredScript, desiredScript) {
  if (!registeredScript || registeredScript.id !== desiredScript.id) {
    return false;
  }
  if (
    Array.isArray(registeredScript.matches) &&
    !isSameStringArray(registeredScript.matches, desiredScript.matches)
  ) {
    return false;
  }
  if (
    Array.isArray(registeredScript.js) &&
    !isSameStringArray(registeredScript.js, desiredScript.js)
  ) {
    return false;
  }
  return true;
}

async function syncContentScripts(
  allConfigs,
  desiredConfigs,
  { desiredCustomConfigs = [], reconcileCustom = true } = {}
) {
  if (!chrome.scripting?.getRegisteredContentScripts) {
    return;
  }

  const managedOptionalScriptIds = new Set(allConfigs.map(({ contentScript }) => contentScript.id));
  const isManagedScriptId = (id) => (
    managedOptionalScriptIds.has(id) ||
    (reconcileCustom && isManagedCustomScriptId(id))
  );

  const desiredOptionalScriptIds = new Set(desiredConfigs.map(({ contentScript }) => contentScript.id));
  const desiredCustomScripts = desiredCustomConfigs
    .map(({ contentScript }) => contentScript)
    .filter(Boolean);
  const desiredCustomById = new Map(
    desiredCustomScripts.map((contentScript) => [contentScript.id, contentScript])
  );

  const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
  const registeredManagedScripts = registeredScripts.filter(({ id }) => isManagedScriptId(id));

  const unchangedIds = new Set();
  for (const script of registeredManagedScripts) {
    if (desiredOptionalScriptIds.has(script.id)) {
      unchangedIds.add(script.id);
      continue;
    }
    const desiredCustom = desiredCustomById.get(script.id);
    if (desiredCustom && matchesRegisteredCustomScript(script, desiredCustom)) {
      unchangedIds.add(script.id);
    }
  }

  const scriptIdsToRemove = registeredManagedScripts
    .map(({ id }) => id)
    .filter((id) => !unchangedIds.has(id));

  if (scriptIdsToRemove.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: scriptIdsToRemove });
  }

  const scriptsToRegister = [
    ...desiredConfigs.map(({ contentScript }) => contentScript),
    ...desiredCustomScripts
  ].filter(({ id }) => !unchangedIds.has(id));

  if (scriptsToRegister.length > 0) {
    await chrome.scripting.registerContentScripts(scriptsToRegister);
  }
}

async function syncFrameRules(
  allConfigs,
  desiredConfigs,
  { customConfigs = [], reconcileCustom = true } = {}
) {
  return syncFrameHeaderRulesWithStatus({
    optionalRules: desiredConfigs.map(({ frameRule }) => frameRule).filter(Boolean),
    optionalRuleIds: allConfigs.map(({ frameRule }) => frameRule?.id).filter(Number.isInteger),
    customRules: customConfigs.map(({ frameRule }) => frameRule).filter(Boolean),
    customApiOriginRules: customConfigs.map(({ apiOriginRule }) => apiOriginRule).filter(Boolean),
    isManagedCustomRuleId: reconcileCustom ? isManagedCustomRuleId : () => false
  });
}
