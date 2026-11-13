import { DEFAULT_PROVIDER_IDS } from './provider-defaults.js';
import { filterProvidersWithGrantedAccess } from './optional-provider-access.js';
import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  getTemporaryChatNormalUrl,
  getTemporaryChatUrl,
  isTemporaryChatSupportedProvider,
  isUrlDrivenTemporaryChatProvider,
  listProviderDescriptors,
  requiresTemporaryChatActivationRetry
} from './provider-registry.js';

export {
  getTemporaryChatNormalUrl,
  getTemporaryChatUrl,
  isTemporaryChatSupportedProvider,
  isUrlDrivenTemporaryChatProvider,
  requiresTemporaryChatActivationRetry
};

const providerObjectCache = new WeakMap();

function toProviderObject(descriptor) {
  const cached = providerObjectCache.get(descriptor);
  if (cached) {
    return cached;
  }

  const provider = {
    id: descriptor.id,
    name: descriptor.name,
    url: descriptor.url,
    topLevelUrl: descriptor.topLevelUrl,
    icon: descriptor.icon,
    iconDark: descriptor.iconDark,
    enabled: descriptor.enabled
  };

  if (descriptor.access === 'optional' && descriptor.permissionOrigins) {
    provider.optionalOrigins = descriptor.permissionOrigins;
  }

  providerObjectCache.set(descriptor, provider);
  return provider;
}

export const PROVIDERS = BUILTIN_PROVIDER_DESCRIPTORS.map(toProviderObject);

export function listProviders() {
  return listProviderDescriptors().map(toProviderObject);
}

export function getProviderIcon(provider, theme = null) {
  if (!provider) return '';

  const documentTheme = typeof document !== 'undefined'
    ? document.documentElement?.getAttribute('data-theme')
    : null;
  const resolvedTheme = theme || documentTheme || 'light';
  if (resolvedTheme === 'dark' && provider.iconDark) {
    return provider.iconDark;
  }

  return provider.icon;
}

export function getProviderById(id) {
  const descriptor = getProviderDescriptor(id);
  return descriptor ? toProviderObject(descriptor) : undefined;
}

export async function getProviderByIdWithSettings(id) {
  const provider = getProviderById(id);
  if (!provider) return null;

  return provider;
}

export async function getEnabledProviders() {
  let settings = {
    enabledProviders: DEFAULT_PROVIDER_IDS,
    providerOrder: null
  };
  
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      settings = await chrome.storage.sync.get(settings);
    }
  } catch (error) {
    console.warn('Failed to load provider settings, using defaults');
  }

  // Synced preferences may include optional providers that are not authorized on
  // this device. Keep the preference intact, but do not load inaccessible panels.
  const availableProviderIds = await filterProvidersWithGrantedAccess(settings.enabledProviders);
  let enabledProviders = listProviderDescriptors()
    .map(toProviderObject)
    .filter(p => availableProviderIds.includes(p.id));

  // Sort by custom order if available
  if (settings.providerOrder && Array.isArray(settings.providerOrder)) {
    enabledProviders.sort((a, b) => {
      const indexA = settings.providerOrder.indexOf(a.id);
      const indexB = settings.providerOrder.indexOf(b.id);
      // If not in order array, put at the end
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  }

  return enabledProviders;
}
