import { getGoogleProviderUrl, normalizeGoogleProviderMode } from './google-mode.js';

const PROVIDER_ALLOWED_HOSTS = {
  chatgpt: new Set(['chatgpt.com', 'chat.openai.com']),
  claude: new Set(['claude.ai']),
  gemini: new Set(['gemini.google.com']),
  grok: new Set(['grok.com']),
  deepseek: new Set(['chat.deepseek.com']),
  kimi: new Set(['www.kimi.com', 'kimi.com']),
  google: new Set(['www.google.com', 'google.com']),
  doubao: new Set(['www.doubao.com', 'doubao.com']),
  'qwen-cn': new Set(['www.qianwen.com']),
  'qwen-global': new Set(['chat.qwen.ai'])
};

const QWEN_GLOBAL_NON_CONVERSATION_IDS = new Set(['new-chat', 'new-branch', 'guest']);

function parseHttpUrl(url) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function hasAllowedProviderHost(providerId, url) {
  const allowedHosts = PROVIDER_ALLOWED_HOSTS[providerId];
  return Boolean(allowedHosts && allowedHosts.has(url.hostname));
}

export function isProviderAllowedUrl(providerId, rawUrl) {
  const url = parseHttpUrl(rawUrl);
  return Boolean(url && hasAllowedProviderHost(providerId, url));
}

function isGenericPath(url, paths) {
  return paths.includes(url.pathname);
}

export function getProviderFallbackUrl(provider, providerMode = null) {
  if (!provider) {
    return '';
  }

  if (provider.id === 'google') {
    return getGoogleProviderUrl(normalizeGoogleProviderMode(providerMode));
  }

  return provider.topLevelUrl || provider.url || '';
}

export function isProviderCurrentUrl(providerId, rawUrl) {
  const url = parseHttpUrl(rawUrl);
  if (!url || !hasAllowedProviderHost(providerId, url)) {
    return false;
  }

  switch (providerId) {
    case 'chatgpt':
      return url.pathname.startsWith('/c/') && url.searchParams.get('temporary-chat') !== 'true';
    case 'claude':
      return url.pathname.startsWith('/chat/') && !url.searchParams.has('incognito');
    case 'gemini':
      return url.pathname.startsWith('/app/') && url.pathname !== '/app/';
    case 'grok':
      return (url.pathname.startsWith('/c/') || url.pathname.startsWith('/chat/')) && url.hash !== '#private';
    case 'deepseek':
      return url.pathname.startsWith('/a/chat/s/') || url.pathname.startsWith('/chat/');
    case 'kimi':
      return url.pathname.startsWith('/chat/');
    case 'google':
      return isGenericPath(url, ['/', '/webhp', '/search']);
    case 'doubao':
      return url.pathname.startsWith('/chat/') && url.pathname !== '/chat/';
    case 'qwen-cn':
      return false;
    case 'qwen-global': {
      const conversationMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
      return Boolean(
        conversationMatch &&
        !QWEN_GLOBAL_NON_CONVERSATION_IDS.has(conversationMatch[1])
      );
    }
    default:
      return false;
  }
}

export function getProviderOpenUrl(provider, reportedUrl = null, providerMode = null) {
  if (provider && isProviderCurrentUrl(provider.id, reportedUrl)) {
    return new URL(reportedUrl).toString();
  }

  return getProviderFallbackUrl(provider, providerMode);
}
