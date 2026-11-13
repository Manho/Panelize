import { getGoogleProviderUrl, normalizeGoogleProviderMode } from './google-mode.js';
import { getProviderDescriptor } from './provider-registry.js';

const QWEN_GLOBAL_NON_CONVERSATION_IDS = new Set(['new-chat', 'new-branch', 'guest']);
const AISTUDIO_NON_CONVERSATION_IDS = new Set(['new_chat', 'new_multiturn', 'new_chunk']);

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
  const descriptor = getProviderDescriptor(providerId);
  return Boolean(descriptor && descriptor.allowedHosts.includes(url.hostname));
}

/**
 * Origins a provider's panel can be on while its content script runs there.
 * The Multi-Panel page posts to each one instead of to '*': the browser
 * delivers to the one the frame is on, and to none when the frame has left
 * them, so prompts never reach another site.
 * @param {string} providerId
 * @returns {string[]}
 */
export function getProviderFrameOrigins(providerId) {
  const descriptor = getProviderDescriptor(providerId);
  return descriptor ? [...descriptor.frameOrigins] : [];
}

/**
 * Whether a message origin is one the provider's panel frame can be on. A
 * frame may move between them (ChatGPT redirects between its two origins),
 * so any listed origin is accepted.
 * @param {string} providerId
 * @param {unknown} origin - `MessageEvent.origin`.
 * @returns {boolean}
 */
export function isProviderFrameOrigin(providerId, origin) {
  return typeof origin === 'string' && getProviderFrameOrigins(providerId).includes(origin);
}

/**
 * Finds the panel a window message came from. It must come from a panel's
 * frame window and from an origin that panel's provider page can be on, so
 * a frame that navigated elsewhere is not trusted.
 * @param {Array<{providerId: string, iframe?: HTMLIFrameElement}>} panels
 * @param {MessageEvent} event
 * @returns {object | null} The sending panel, or null.
 */
export function findMessageSourcePanel(panels, event) {
  if (!event?.source || !Array.isArray(panels)) {
    return null;
  }
  const panel = panels.find((candidate) => candidate?.iframe?.contentWindow === event.source);
  return panel && isProviderFrameOrigin(panel.providerId, event.origin) ? panel : null;
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
      // Qwen China does not expose a verified stable conversation URL.
      return false;
    case 'qwen-global': {
      const conversationMatch = url.pathname.match(/^\/c\/([^/]+)\/?$/);
      return Boolean(
        conversationMatch &&
        !QWEN_GLOBAL_NON_CONVERSATION_IDS.has(conversationMatch[1])
      );
    }
    case 'chatglm':
      return url.pathname === '/main/alltoolsdetail' && Boolean(url.searchParams.get('cid'));
    case 'zai-global':
      return /^\/c\/[^/]+\/?$/.test(url.pathname);
    case 'yuanbao':
      return (
        /^\/chat\/[^/]+\/[^/]+\/?$/.test(url.pathname) &&
        url.searchParams.get('chatMode') !== 'temp'
      );
    case 'aistudio': {
      const promptMatch = url.pathname.match(/^\/prompts\/([^/]+)\/?$/);
      return Boolean(
        promptMatch &&
        !AISTUDIO_NON_CONVERSATION_IDS.has(promptMatch[1]) &&
        url.searchParams.get('temporary') !== 'true'
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
