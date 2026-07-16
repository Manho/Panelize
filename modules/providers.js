import { DEFAULT_PROVIDER_IDS } from './provider-defaults.js';
import {
  OPTIONAL_PROVIDER_CONFIGS,
  filterProvidersWithGrantedAccess
} from './optional-provider-access.js';

export const PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    topLevelUrl: 'https://chatgpt.com/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    topLevelUrl: 'https://claude.ai/new',
    icon: '/icons/providers/claude.png',
    iconDark: '/icons/providers/dark/claude.png',
    enabled: true,
    // Claude can serve a limited model selector when embedded in an extension iframe.
    embeddedModelSelectionLimited: true
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    topLevelUrl: 'https://gemini.google.com/app',
    icon: '/icons/providers/gemini.png',
    iconDark: '/icons/providers/dark/gemini.png',
    enabled: true
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    topLevelUrl: 'https://grok.com/',
    icon: '/icons/providers/grok.png',
    iconDark: '/icons/providers/dark/grok.png',
    enabled: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    topLevelUrl: 'https://chat.deepseek.com/',
    icon: '/icons/providers/deepseek.png',
    iconDark: '/icons/providers/dark/deepseek.png',
    enabled: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com',
    topLevelUrl: 'https://www.kimi.com/',
    icon: '/icons/providers/kimi.png',
    iconDark: '/icons/providers/dark/kimi.png',
    enabled: true
  },
  {
    id: 'google',
    name: 'Google',
    url: 'https://www.google.com/search?udm=50',
    topLevelUrl: 'https://www.google.com/search?udm=50',
    icon: '/icons/providers/google.png',
    iconDark: '/icons/providers/dark/google.png',
    enabled: true
  },
  {
    id: 'doubao',
    name: 'Doubao',
    url: 'https://www.doubao.com/chat/',
    topLevelUrl: 'https://www.doubao.com/chat/',
    icon: '/icons/providers/doubao.png',
    iconDark: '/icons/providers/dark/doubao.png',
    enabled: true
  },
  {
    id: 'qwen-cn',
    name: 'Qwen (China)',
    url: 'https://www.qianwen.com/',
    topLevelUrl: 'https://www.qianwen.com/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    optionalOrigins: OPTIONAL_PROVIDER_CONFIGS['qwen-cn'].origins
  },
  {
    id: 'qwen-global',
    name: 'Qwen (Global)',
    url: 'https://chat.qwen.ai/',
    topLevelUrl: 'https://chat.qwen.ai/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    optionalOrigins: OPTIONAL_PROVIDER_CONFIGS['qwen-global'].origins
  },
  {
    id: 'chatglm',
    name: 'Zhipu (China)',
    url: 'https://chatglm.cn/',
    topLevelUrl: 'https://chatglm.cn/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    optionalOrigins: OPTIONAL_PROVIDER_CONFIGS.chatglm.origins
  },
  {
    id: 'zai-global',
    name: 'Z.ai (Global)',
    url: 'https://chat.z.ai/',
    topLevelUrl: 'https://chat.z.ai/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    optionalOrigins: OPTIONAL_PROVIDER_CONFIGS['zai-global'].origins
  }
];

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
  return PROVIDERS.find(p => p.id === id);
}

export async function getProviderByIdWithSettings(id) {
  const provider = PROVIDERS.find(p => p.id === id);
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
  let enabledProviders = PROVIDERS.filter(p => availableProviderIds.includes(p.id));

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
