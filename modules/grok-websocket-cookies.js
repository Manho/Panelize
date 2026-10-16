import { DEFAULT_PROVIDER_IDS } from './provider-defaults.js';

export const GROK_PROVIDER_ID = 'grok';
export const GROK_COOKIE_URL = 'https://grok.com/';
export const GROK_DOMAIN = 'grok.com';
export const GROK_WEBSOCKET_COOKIE_RULE_ID = 2001;
export const MULTI_PANEL_PAGE_PATH = 'multi-panel/multi-panel.html';
export const GROK_CONSENT_COOKIE_NAMES = Object.freeze([
  'OptanonAlertBoxClosed',
  'OptanonConsent'
]);

const registeredMultiPanelTabIds = new Set();

function isValidTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

export function registerMultiPanelTabId(tabId) {
  if (isValidTabId(tabId)) {
    registeredMultiPanelTabIds.add(tabId);
  }
}

export function unregisterMultiPanelTabId(tabId) {
  if (isValidTabId(tabId)) {
    registeredMultiPanelTabIds.delete(tabId);
  }
}

export function clearRegisteredMultiPanelTabIds() {
  registeredMultiPanelTabIds.clear();
}

export function isGrokCookieDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0) {
    return false;
  }

  const normalized = domain.startsWith('.')
    ? domain.slice(1).toLowerCase()
    : domain.toLowerCase();
  return normalized === GROK_DOMAIN || normalized.endsWith(`.${GROK_DOMAIN}`);
}

/**
 * Formats Grok cookies that Chromium omits from cross-site WebSocket handshakes
 * inside extension iframes. SameSite=None cookies (including partitioned CHIPS
 * cookies such as cf_clearance) are already attached by Chromium, so only
 * SameSite=Lax, SameSite=Strict, and unspecified cookies are appended.
 */
export function formatGrokWebSocketCookieHeader(cookies) {
  if (!Array.isArray(cookies)) {
    return '';
  }

  return cookies
    .filter((cookie) => (
      cookie &&
      typeof cookie.name === 'string' &&
      cookie.name.length > 0 &&
      typeof cookie.value === 'string' &&
      cookie.sameSite !== 'no_restriction' &&
      !cookie.partitionKey
    ))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function createGrokWebSocketCookieRule(cookieHeaderValue, tabIds) {
  const normalizedTabIds = [...new Set(
    (Array.isArray(tabIds) ? tabIds : []).filter(isValidTabId)
  )].sort((a, b) => a - b);

  return {
    id: GROK_WEBSOCKET_COOKIE_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Cookie',
          operation: 'append',
          value: cookieHeaderValue
        }
      ]
    },
    condition: {
      requestDomains: [GROK_DOMAIN],
      initiatorDomains: [GROK_DOMAIN],
      resourceTypes: ['websocket'],
      tabIds: normalizedTabIds
    }
  };
}

export async function getMultiPanelTabIds(extraTabId = null) {
  if (isValidTabId(extraTabId)) {
    registeredMultiPanelTabIds.add(extraTabId);
  }

  if (!isValidTabId(extraTabId) && typeof chrome !== 'undefined' && chrome.tabs?.getCurrent) {
    try {
      const currentTab = await chrome.tabs.getCurrent();
      if (isValidTabId(currentTab?.id)) {
        registeredMultiPanelTabIds.add(currentTab.id);
      }
    } catch (error) {
      // Ignore when called outside a tab context such as the background service worker
    }
  }

  if (typeof chrome !== 'undefined' && chrome.runtime?.getContexts && chrome.runtime?.getURL) {
    try {
      const multiPanelUrl = chrome.runtime.getURL(MULTI_PANEL_PAGE_PATH);
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      if (Array.isArray(contexts)) {
        for (const context of contexts) {
          if (
            typeof context?.documentUrl === 'string' &&
            context.documentUrl.startsWith(multiPanelUrl) &&
            isValidTabId(context.tabId)
          ) {
            registeredMultiPanelTabIds.add(context.tabId);
          }
        }
      }
    } catch (error) {
      // Fallback to in-memory registered tab IDs if getContexts fails
    }
  }

  return [...registeredMultiPanelTabIds].sort((a, b) => a - b);
}

function isSameRule(leftRule, rightRule) {
  if (!leftRule || !rightRule) {
    return false;
  }

  const leftHeader = leftRule.action?.requestHeaders?.[0];
  const rightHeader = rightRule.action?.requestHeaders?.[0];
  const leftTabIds = leftRule.condition?.tabIds || [];
  const rightTabIds = rightRule.condition?.tabIds || [];

  return (
    leftRule.id === rightRule.id &&
    leftRule.priority === rightRule.priority &&
    leftRule.action?.type === rightRule.action?.type &&
    leftHeader?.header === rightHeader?.header &&
    leftHeader?.operation === rightHeader?.operation &&
    leftHeader?.value === rightHeader?.value &&
    leftTabIds.length === rightTabIds.length &&
    leftTabIds.every((tabId, index) => tabId === rightTabIds[index])
  );
}

export async function syncGrokWebSocketCookies({
  enabledProviderIds = DEFAULT_PROVIDER_IDS,
  tabIds = [],
  cookies = []
} = {}) {
  if (
    typeof chrome === 'undefined' ||
    !chrome.declarativeNetRequest?.getSessionRules ||
    !chrome.declarativeNetRequest?.updateSessionRules
  ) {
    return;
  }

  const grokEnabled = Array.isArray(enabledProviderIds) && enabledProviderIds.includes(GROK_PROVIDER_ID);
  const normalizedTabIds = [...new Set(
    (Array.isArray(tabIds) ? tabIds : []).filter(isValidTabId)
  )].sort((a, b) => a - b);
  const cookieHeaderValue = grokEnabled && normalizedTabIds.length > 0
    ? formatGrokWebSocketCookieHeader(cookies)
    : '';
  const desiredRule = cookieHeaderValue
    ? createGrokWebSocketCookieRule(cookieHeaderValue, normalizedTabIds)
    : null;

  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const existingRule = sessionRules.find(({ id }) => id === GROK_WEBSOCKET_COOKIE_RULE_ID) || null;

  if (!desiredRule) {
    if (existingRule) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [GROK_WEBSOCKET_COOKIE_RULE_ID],
        addRules: []
      });
    }
    return;
  }

  if (isSameRule(existingRule, desiredRule)) {
    return;
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existingRule ? [GROK_WEBSOCKET_COOKIE_RULE_ID] : [],
    addRules: [desiredRule]
  });
}

export async function upgradeGrokConsentCookies(cookies) {
  if (!Array.isArray(cookies) || typeof chrome === 'undefined' || !chrome.cookies?.set) {
    return cookies;
  }

  const updatedCookies = [];
  for (const cookie of cookies) {
    if (
      cookie &&
      GROK_CONSENT_COOKIE_NAMES.includes(cookie.name) &&
      !cookie.partitionKey &&
      (cookie.sameSite !== 'no_restriction' || !cookie.secure)
    ) {
      const details = {
        url: GROK_COOKIE_URL,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path || '/',
        secure: true,
        httpOnly: Boolean(cookie.httpOnly),
        sameSite: 'no_restriction'
      };
      if (!cookie.hostOnly && cookie.domain) {
        details.domain = cookie.domain;
      }
      if (typeof cookie.expirationDate === 'number') {
        details.expirationDate = cookie.expirationDate;
      }
      if (typeof cookie.storeId === 'string') {
        details.storeId = cookie.storeId;
      }

      try {
        await chrome.cookies.set(details);
        updatedCookies.push({
          ...cookie,
          secure: true,
          sameSite: 'no_restriction'
        });
        continue;
      } catch (error) {
        // Keep original cookie entry if chrome.cookies.set fails
      }
    }

    updatedCookies.push(cookie);
  }

  return updatedCookies;
}

export async function reconcileGrokWebSocketCookies({ tabId = null } = {}) {
  try {
    if (
      typeof chrome === 'undefined' ||
      !chrome.declarativeNetRequest?.getSessionRules ||
      !chrome.declarativeNetRequest?.updateSessionRules
    ) {
      return;
    }

    const settings = await chrome.storage.sync.get({
      enabledProviders: DEFAULT_PROVIDER_IDS
    });
    const enabledProviderIds = Array.isArray(settings.enabledProviders)
      ? settings.enabledProviders
      : DEFAULT_PROVIDER_IDS;
    const tabIds = await getMultiPanelTabIds(tabId);
    const grokEnabled = enabledProviderIds.includes(GROK_PROVIDER_ID);
    const rawCookies = grokEnabled && tabIds.length > 0 && chrome.cookies?.getAll
      ? await chrome.cookies.getAll({ url: GROK_COOKIE_URL })
      : [];
    const cookies = grokEnabled && tabIds.length > 0
      ? await upgradeGrokConsentCookies(rawCookies)
      : rawCookies;

    await syncGrokWebSocketCookies({
      enabledProviderIds,
      tabIds,
      cookies
    });
  } catch (error) {
    console.error('[Background] Failed to synchronize Grok WebSocket cookies:', error);
  }
}
