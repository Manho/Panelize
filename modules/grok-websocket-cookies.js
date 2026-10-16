import { DEFAULT_PROVIDER_IDS } from './provider-defaults.js';

export const GROK_PROVIDER_ID = 'grok';
export const GROK_COOKIE_URL = 'https://grok.com/';
export const GROK_DOMAIN = 'grok.com';
export const GROK_WEBSOCKET_COOKIE_RULE_ID = 2001;
export const GROK_WEBSOCKET_COOKIE_SYNC_ACTION = 'syncGrokWebSocketCookies';
export const MULTI_PANEL_PAGE_PATH = 'multi-panel/multi-panel.html';
export const GROK_CONSENT_COOKIE_NAMES = Object.freeze([
  'OptanonAlertBoxClosed',
  'OptanonConsent'
]);

// Tabs whose top-level document started navigating. They stay out of the
// forwarding rule until the navigation completes or a Multi-Panel page in that
// tab asks for a sync, so a Multi-Panel tab that navigates elsewhere never
// keeps receiving forwarded cookies while its old document is still listed.
const navigatingTabIds = new Set();
// Navigating tabs that were left out of the rule only because of the mark
// above; they need a reconcile once their navigation settles.
const suppressedTabIds = new Set();
// Tab IDs of the installed rule, or null when unknown (e.g. after a service
// worker restart) and the session rules must be read again.
let appliedRuleTabIds = null;

function isValidTabId(tabId) {
  return Number.isInteger(tabId) && tabId >= 0;
}

function normalizeTabIds(tabIds) {
  return [...new Set(
    (Array.isArray(tabIds) ? tabIds : []).filter(isValidTabId)
  )].sort((a, b) => a - b);
}

export function resetGrokWebSocketCookieState() {
  navigatingTabIds.clear();
  suppressedTabIds.clear();
  appliedRuleTabIds = null;
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

function isForwardedCookie(cookie) {
  return Boolean(
    cookie &&
    typeof cookie.name === 'string' &&
    cookie.name.length > 0 &&
    typeof cookie.value === 'string' &&
    cookie.sameSite !== 'no_restriction' &&
    !cookie.partitionKey
  );
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
    .filter(isForwardedCookie)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

/**
 * Whether a chrome.cookies.onChanged event can change the forwarded header.
 * Overwrites report the old cookie as removed and the new one as added, so
 * a cookie moving out of the header (e.g. to SameSite=None) is still caught
 * by its removal event.
 */
export function isGrokWebSocketCookieChange(changeInfo) {
  const cookie = changeInfo?.cookie;
  return isGrokCookieDomain(cookie?.domain) && isForwardedCookie(cookie);
}

/**
 * Top-level domains the rule is restricted to: this extension's own pages.
 * RuleCondition.topDomains exists since Chrome 145, and older versions reject
 * unknown condition keys, so it is only used when the browser advertises it.
 * There the rule cannot apply to a Multi-Panel tab that already navigated to
 * another site, or to a third-party page framing multi-panel.html, even
 * before the tab list is updated.
 */
export function getExtensionTopDomains() {
  if (
    typeof chrome === 'undefined' ||
    chrome.declarativeNetRequest?.RuleConditionKeys?.TOP_DOMAINS !== 'topDomains' ||
    typeof chrome.runtime?.id !== 'string' ||
    chrome.runtime.id.length === 0
  ) {
    return null;
  }
  return [chrome.runtime.id];
}

export function createGrokWebSocketCookieRule(cookieHeaderValue, tabIds, topDomains = getExtensionTopDomains()) {
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
      ...(Array.isArray(topDomains) && topDomains.length > 0 ? { topDomains: [...topDomains] } : {}),
      resourceTypes: ['websocket'],
      tabIds: normalizeTabIds(tabIds)
    }
  };
}

export function isMultiPanelPageUrl(url) {
  if (typeof url !== 'string' || typeof chrome === 'undefined' || !chrome.runtime?.getURL) {
    return false;
  }

  try {
    const actual = new URL(url);
    const expected = new URL(chrome.runtime.getURL(MULTI_PANEL_PAGE_PATH));
    // Compare scheme and host explicitly: URL.origin is "null" for
    // chrome-extension: URLs outside the browser.
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

/**
 * Only a Multi-Panel page that is the top-level document of its tab may ask
 * for cookie forwarding. multi-panel.html is web-accessible, so third-party
 * pages can frame it; those frames have a non-zero frameId.
 */
export function isMultiPanelTopFrameSender(sender) {
  return Boolean(
    sender &&
    typeof chrome !== 'undefined' &&
    sender.id === chrome.runtime?.id &&
    sender.frameId === 0 &&
    isValidTabId(sender.tab?.id) &&
    isMultiPanelPageUrl(sender.url)
  );
}

async function getMultiPanelTopFrameTabIds() {
  if (typeof chrome === 'undefined' || !chrome.runtime?.getContexts) {
    // Without getContexts there is no trustworthy way to tell which tabs show
    // the Multi-Panel page, so forward nothing.
    return [];
  }

  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  return normalizeTabIds((Array.isArray(contexts) ? contexts : [])
    .filter((context) => context?.frameId === 0 && isMultiPanelPageUrl(context.documentUrl))
    .map((context) => context.tabId));
}

export async function getMultiPanelTabIds() {
  const tabIds = await getMultiPanelTopFrameTabIds();
  return tabIds.filter((tabId) => {
    if (navigatingTabIds.has(tabId)) {
      suppressedTabIds.add(tabId);
      return false;
    }
    return true;
  });
}

async function getAppliedRuleTabIds() {
  if (appliedRuleTabIds) {
    return appliedRuleTabIds;
  }

  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.getSessionRules) {
    return [];
  }

  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = sessionRules.find(({ id }) => id === GROK_WEBSOCKET_COOKIE_RULE_ID);
  appliedRuleTabIds = normalizeTabIds(rule?.condition?.tabIds);
  return appliedRuleTabIds;
}

/**
 * Handles a top-level navigation start in any tab. A tab covered by the
 * forwarding rule is removed from it right away, without a full reconcile, so
 * the next document in that tab (e.g. grok.com top-level) does not receive
 * duplicate cookies. Returns true when the rule changed.
 */
export async function handleGrokTabNavigationStart(tabId) {
  if (!isValidTabId(tabId)) {
    return false;
  }

  // Mark synchronously so a reconcile racing with this handler already skips
  // the tab.
  navigatingTabIds.add(tabId);
  const ruleTabIds = await getAppliedRuleTabIds();
  if (!ruleTabIds.includes(tabId)) {
    return false;
  }

  const sessionRules = await chrome.declarativeNetRequest.getSessionRules();
  const rule = sessionRules.find(({ id }) => id === GROK_WEBSOCKET_COOKIE_RULE_ID);
  const remainingTabIds = normalizeTabIds(rule?.condition?.tabIds).filter((id) => id !== tabId);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [GROK_WEBSOCKET_COOKIE_RULE_ID],
    addRules: rule && remainingTabIds.length > 0
      ? [{ ...rule, condition: { ...rule.condition, tabIds: remainingTabIds } }]
      : []
  });
  appliedRuleTabIds = remainingTabIds;
  suppressedTabIds.add(tabId);
  return true;
}

/**
 * Handles a finished navigation. Returns true when the tab was left out of the
 * rule while navigating and must be re-evaluated against its new document.
 */
export function handleGrokTabNavigationComplete(tabId) {
  navigatingTabIds.delete(tabId);
  return suppressedTabIds.delete(tabId);
}

/**
 * Handles a sync request from a trusted Multi-Panel top frame: its document is
 * live, so the tab no longer counts as navigating.
 */
export function handleMultiPanelSyncRequest(tabId) {
  navigatingTabIds.delete(tabId);
  suppressedTabIds.delete(tabId);
}

/**
 * Handles a closed tab. Returns true when the forwarding rule still lists it.
 */
export async function handleGrokTabRemoved(tabId) {
  navigatingTabIds.delete(tabId);
  suppressedTabIds.delete(tabId);
  const ruleTabIds = await getAppliedRuleTabIds();
  return ruleTabIds.includes(tabId);
}

function isSameList(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSameRule(leftRule, rightRule) {
  if (!leftRule || !rightRule) {
    return false;
  }

  const leftHeader = leftRule.action?.requestHeaders?.[0];
  const rightHeader = rightRule.action?.requestHeaders?.[0];

  return (
    leftRule.id === rightRule.id &&
    leftRule.priority === rightRule.priority &&
    leftRule.action?.type === rightRule.action?.type &&
    leftHeader?.header === rightHeader?.header &&
    leftHeader?.operation === rightHeader?.operation &&
    leftHeader?.value === rightHeader?.value &&
    isSameList(leftRule.condition?.tabIds, rightRule.condition?.tabIds) &&
    isSameList(leftRule.condition?.topDomains, rightRule.condition?.topDomains)
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
  const normalizedTabIds = normalizeTabIds(tabIds);
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
    appliedRuleTabIds = [];
    return;
  }

  if (!isSameRule(existingRule, desiredRule)) {
    // Always remove the ID first so the update stays valid even if another
    // context installed the rule after getSessionRules() returned.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [GROK_WEBSOCKET_COOKIE_RULE_ID],
      addRules: [desiredRule]
    });
  }
  appliedRuleTabIds = desiredRule.condition.tabIds;
}

/**
 * Rewrites existing OneTrust consent cookies to SameSite=None; Secure so Grok
 * can read a choice the user already made top-level from inside its embedded
 * panel; Chromium hides SameSite=Lax cookies from document.cookie there.
 * Value, path, domain and expiry are kept. New choices made inside the panel
 * are handled by content-scripts/grok-cookie-consent.js instead.
 */
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
        console.warn(`[Grok] Failed to update consent cookie ${cookie.name}:`, error);
      }
    }

    updatedCookies.push(cookie);
  }

  return updatedCookies;
}

/**
 * Recomputes the forwarding rule from the live Multi-Panel tabs and cookies.
 * @param {object} [options]
 * @param {boolean} [options.upgradeConsentCookies] - Also rewrite existing
 *   consent cookies; only set when a Multi-Panel page is about to load Grok.
 */
export async function reconcileGrokWebSocketCookies({ upgradeConsentCookies = false } = {}) {
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
  const grokEnabled = enabledProviderIds.includes(GROK_PROVIDER_ID);
  const tabIds = grokEnabled ? await getMultiPanelTabIds() : [];
  const active = grokEnabled && tabIds.length > 0;
  let cookies = active && chrome.cookies?.getAll
    ? await chrome.cookies.getAll({ url: GROK_COOKIE_URL })
    : [];
  if (active && upgradeConsentCookies) {
    cookies = await upgradeGrokConsentCookies(cookies);
  }

  await syncGrokWebSocketCookies({
    enabledProviderIds,
    tabIds,
    cookies
  });
}

/**
 * Serializes reconciles and coalesces bursts: requests that arrive while a run
 * is queued share it, so a flurry of cookie or tab events costs at most one
 * run in progress plus one queued run. The returned promise never rejects.
 * @param {(options: {upgradeConsentCookies?: boolean}) => Promise<void>} reconcile
 * @param {(error: unknown) => void} [onError]
 * @returns {(options?: {upgradeConsentCookies?: boolean}) =>
 *   Promise<{success: true} | {success: false, error: string}>}
 */
export function createGrokWebSocketCookieReconcileScheduler(reconcile, onError = () => {}) {
  let tail = Promise.resolve();
  let pendingRun = null;
  let pendingOptions = {};

  return function scheduleReconcile(options = {}) {
    if (options.upgradeConsentCookies) {
      pendingOptions = { ...pendingOptions, upgradeConsentCookies: true };
    }
    if (pendingRun) {
      return pendingRun;
    }

    pendingRun = tail
      .then(() => {
        const runOptions = pendingOptions;
        pendingRun = null;
        pendingOptions = {};
        return reconcile(runOptions);
      })
      .then(
        () => ({ success: true }),
        (error) => {
          onError(error);
          return { success: false, error: error?.message || String(error) };
        }
      );
    tail = pendingRun;
    return pendingRun;
  };
}
