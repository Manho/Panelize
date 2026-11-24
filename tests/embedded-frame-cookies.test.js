import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import {
  CHATGLM_ORIGIN,
  EMBEDDED_FRAME_COOKIE_SYNC_ACTION,
  MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY,
  cookieMatchesHostname,
  createEmbeddedFrameCookieReconcileScheduler,
  getExtensionPartitionKey,
  handleEmbeddedFrameCookieChanged,
  isChatglmGuestJwt,
  reconcileEmbeddedFrameCookies,
  requiresEmbeddedFrameCookieSync,
} from '../modules/embedded-frame-cookies.js';
import {
  getExpectedCustomWebPermissionOrigins,
  setCustomProviderDescriptors,
} from '../modules/provider-registry.js';

const EXTENSION_ID = 'panelizeembeddedcookietestid';
const EXTENSION_TOP_SITE = `chrome-extension://${EXTENSION_ID}`;

function createJwt(payload) {
  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function installStatefulCookieEnv({
  enabledProviders = [],
  customRecords = [],
  grantedOrigins = [],
  initialCookies = [],
  initialMirrored = {},
  topDomainsSupported = true,
} = {}) {
  const state = {
    enabledProviders: [...enabledProviders],
    customRecords: structuredClone(customRecords),
    grantedOrigins: new Set(grantedOrigins),
    cookies: structuredClone(initialCookies),
    localStorage: {
      [CUSTOM_PROVIDERS_STORAGE_KEY]: structuredClone(customRecords),
      [MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]: structuredClone(initialMirrored),
    },
  };

  const matchesCookieFilter = (cookie, filter = {}) => {
    if (filter.partitionKey) {
      if (cookie.partitionKey?.topLevelSite !== filter.partitionKey.topLevelSite) {
        return false;
      }
    } else if (cookie.partitionKey) {
      return false;
    }

    if (filter.name && cookie.name !== filter.name) {
      return false;
    }

    if (filter.url) {
      const parsed = new URL(filter.url);
      if (cookie.secure && parsed.protocol !== 'https:') {
        return false;
      }
      if (!cookieMatchesHostname(cookie.domain, Boolean(cookie.hostOnly), parsed.hostname)) {
        return false;
      }
      const cookiePath = cookie.path || '/';
      if (!parsed.pathname.startsWith(cookiePath)) {
        return false;
      }
    }

    if (filter.domain) {
      const filterDom = filter.domain.replace(/^\.+/, '').toLowerCase();
      const cookieDom = cookie.domain.replace(/^\.+/, '').toLowerCase();
      if (cookieDom !== filterDom && !cookieDom.endsWith(`.${filterDom}`)) {
        return false;
      }
    }

    return true;
  };

  chrome.runtime.id = EXTENSION_ID;
  chrome.runtime.getURL = vi.fn(
    (path = '') => `${EXTENSION_TOP_SITE}/${String(path).replace(/^\/+/, '')}`
  );
  chrome.declarativeNetRequest = topDomainsSupported
    ? { RuleConditionKeys: { TOP_DOMAINS: 'topDomains' } }
    : {};

  chrome.permissions = {
    contains: vi.fn(({ origins = [] } = {}) =>
      Promise.resolve(
        origins.length > 0 && origins.every((origin) => state.grantedOrigins.has(origin))
      )
    ),
  };

  chrome.storage.sync.get.mockImplementation((defaults = {}) =>
    Promise.resolve({
      ...defaults,
      enabledProviders: [...state.enabledProviders],
    })
  );

  chrome.storage.local.get.mockImplementation((defaults = {}) => {
    if (typeof defaults === 'string') {
      return Promise.resolve({ [defaults]: structuredClone(state.localStorage[defaults]) });
    }
    const result = { ...defaults };
    for (const key of Object.keys(defaults)) {
      if (key in state.localStorage) {
        result[key] = structuredClone(state.localStorage[key]);
      }
    }
    return Promise.resolve(result);
  });

  chrome.storage.local.set.mockImplementation((updates) => {
    Object.assign(state.localStorage, structuredClone(updates));
    return Promise.resolve();
  });

  chrome.cookies = {
    getAll: vi.fn((filter = {}) =>
      Promise.resolve(structuredClone(state.cookies.filter((c) => matchesCookieFilter(c, filter))))
    ),
    set: vi.fn((details) => {
      const parsedUrl = new URL(details.url);
      const hostOnly = !details.domain;
      const domain = details.domain || parsedUrl.hostname;
      const path = details.path || '/';
      const storeId = details.storeId || '0';
      const partitionTop = details.partitionKey?.topLevelSite || null;

      state.cookies = state.cookies.filter(
        (existing) =>
          !(
            existing.name === details.name &&
            existing.domain.toLowerCase() === domain.toLowerCase() &&
            Boolean(existing.hostOnly) === hostOnly &&
            (existing.path || '/') === path &&
            (existing.storeId || '0') === storeId &&
            (existing.partitionKey?.topLevelSite || null) === partitionTop
          )
      );

      const saved = {
        name: details.name,
        value: details.value,
        domain,
        hostOnly,
        path,
        secure: Boolean(details.secure),
        httpOnly: Boolean(details.httpOnly),
        sameSite: details.sameSite || 'unspecified',
        storeId,
        ...(typeof details.expirationDate === 'number'
          ? { expirationDate: details.expirationDate }
          : { session: true }),
        ...(details.partitionKey
          ? {
              partitionKey: {
                topLevelSite: details.partitionKey.topLevelSite,
                hasCrossSiteAncestor: true,
              },
            }
          : {}),
      };
      state.cookies.push(saved);
      return Promise.resolve(structuredClone(saved));
    }),
    remove: vi.fn((details) => {
      const parsedUrl = new URL(details.url);
      const partitionTop = details.partitionKey?.topLevelSite || null;
      state.cookies = state.cookies.filter(
        (existing) =>
          !(
            existing.name === details.name &&
            cookieMatchesHostname(existing.domain, Boolean(existing.hostOnly), parsedUrl.hostname) &&
            (existing.path || '/') === (parsedUrl.pathname || '/') &&
            (existing.partitionKey?.topLevelSite || null) === partitionTop
          )
      );
      return Promise.resolve({ url: details.url, name: details.name });
    }),
  };

  return state;
}

describe('modules/embedded-frame-cookies.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCustomProviderDescriptors([]);
  });

  afterEach(() => {
    setCustomProviderDescriptors([]);
    vi.restoreAllMocks();
  });

  it('computes expected permission origins for HTTP vs HTTPS custom web providers (including custom ports)', () => {
    expect(getExpectedCustomWebPermissionOrigins('http://localhost:3000')).toEqual([
      'http://localhost:3000/*',
    ]);
    expect(getExpectedCustomWebPermissionOrigins('https://aistudio.xiaomimimo.com')).toEqual([
      'https://aistudio.xiaomimimo.com/*',
      'http://aistudio.xiaomimimo.com/*',
    ]);
    expect(getExpectedCustomWebPermissionOrigins('https://chat.internal.example:8443')).toEqual([
      'https://chat.internal.example:8443/*',
      'https://chat.internal.example/*',
      'http://chat.internal.example/*',
    ]);
    expect(getExpectedCustomWebPermissionOrigins('not-an-origin')).toEqual([]);
  });

  it('identifies providers requiring embedded frame cookie sync and parses ChatGLM guest JWTs accurately', () => {
    const httpsWebRecord = {
      id: 'custom-1111111111',
      name: 'Xiaomi MiMo',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };
    const httpWebRecord = {
      id: 'custom-2222222222',
      name: 'Local WebUI',
      url: 'http://localhost:3000/',
      frameRuleId: 10001,
      createdAt: 1700000001000,
    };
    const apiRecord = {
      id: 'custom-3333333333',
      kind: 'api',
      name: 'OpenRouter',
      endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'gpt-4o',
      hasApiKey: true,
      frameRuleId: 10002,
      createdAt: 1700000002000,
    };

    chrome.runtime.id = EXTENSION_ID;
    setCustomProviderDescriptors([
      toCustomProviderDescriptor(httpsWebRecord),
      toCustomProviderDescriptor(httpWebRecord),
      toCustomProviderDescriptor(apiRecord),
    ]);

    expect(EMBEDDED_FRAME_COOKIE_SYNC_ACTION).toBe('syncEmbeddedFrameCookies');
    expect(getExtensionPartitionKey()).toEqual({ topLevelSite: EXTENSION_TOP_SITE });

    expect(requiresEmbeddedFrameCookieSync('chatglm')).toBe(true);
    expect(requiresEmbeddedFrameCookieSync('custom-1111111111')).toBe(true);
    expect(requiresEmbeddedFrameCookieSync('custom-2222222222')).toBe(false);
    expect(requiresEmbeddedFrameCookieSync('custom-3333333333')).toBe(false);
    expect(requiresEmbeddedFrameCookieSync('chatgpt')).toBe(false);
    expect(requiresEmbeddedFrameCookieSync('qwen-global')).toBe(false);

    expect(isChatglmGuestJwt(createJwt({ uid: 'g1', is_guest: true }))).toBe(true);
    expect(isChatglmGuestJwt(createJwt({ uid: 'u1', is_guest: false }))).toBe(false);
    expect(isChatglmGuestJwt(createJwt({ uid: 'u2' }))).toBe(false);
    expect(isChatglmGuestJwt('invalid-token')).toBe(false);
    expect(isChatglmGuestJwt('')).toBe(false);
  });

  it('mirrors non-HttpOnly ChatGLM and Xiaomi MiMo cookies into extension CHIPS partition while skipping HttpOnly and SameSite=None; Secure cookies', async () => {
    const mimoRecord = {
      id: 'custom-aabbccddee',
      name: 'Xiaomi MiMo',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };
    const userJwt = createJwt({ uid: 'user-zhipu-1', is_guest: false });
    const refreshJwt = createJwt({ uid: 'user-zhipu-1', is_guest: false, type: 'refresh' });

    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm', mimoRecord.id],
      customRecords: [mimoRecord],
      grantedOrigins: [
        'https://chatglm.cn/*',
        'http://chatglm.cn/*',
        'https://aistudio.xiaomimimo.com/*',
        'http://aistudio.xiaomimimo.com/*',
      ],
      initialCookies: [
        // Zhipu non-Secure, non-HttpOnly tokens set via js-cookie
        {
          name: 'chatglm_token',
          value: userJwt,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          expirationDate: 1800000000,
          storeId: '0',
        },
        {
          name: 'chatglm_refresh_token',
          value: refreshJwt,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          expirationDate: 1810000000,
          storeId: '0',
        },
        // Zhipu HttpOnly WAF cookie -> must NEVER be mirrored
        {
          name: 'acw_tc',
          value: 'waf-secret',
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          storeId: '0',
        },
        // Xiaomi MiMo HttpOnly session cookie -> must NEVER be mirrored
        {
          name: 'serviceToken',
          value: 'xiaomi-http-only-session',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: true,
          sameSite: 'lax',
          storeId: '0',
        },
        // Xiaomi MiMo non-HttpOnly CSRF/PH token -> MUST be mirrored to CHIPS
        {
          name: 'xiaomichatbot_ph',
          value: 'ph-token-xyz',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'unspecified',
          storeId: '0',
        },
        // Already cross-site readable cookie -> skipped
        {
          name: 'already_none',
          value: 'v1',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          storeId: '0',
        },
      ],
    });

    await reconcileEmbeddedFrameCookies();

    const partitioned = state.cookies.filter(
      (c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(partitioned.map((c) => ({ domain: c.domain, name: c.name, value: c.value }))).toEqual([
      { domain: 'chatglm.cn', name: 'chatglm_token', value: userJwt },
      { domain: 'chatglm.cn', name: 'chatglm_refresh_token', value: refreshJwt },
      { domain: 'aistudio.xiaomimimo.com', name: 'xiaomichatbot_ph', value: 'ph-token-xyz' },
    ]);
    for (const mirror of partitioned) {
      expect(mirror.secure).toBe(true);
      expect(mirror.httpOnly).toBe(false);
      expect(mirror.sameSite).toBe('no_restriction');
    }

    // Re-running reconcile when nothing changed performs zero redundant cookie writes
    chrome.cookies.set.mockClear();
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
  });

  it('removes mirrored CHIPS cookies on top-level logout while preserving panel-only CHIPS consent cookies', async () => {
    const mimoRecord = {
      id: 'custom-aabbccddee',
      name: 'Xiaomi MiMo',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };

    const state = installStatefulCookieEnv({
      enabledProviders: [mimoRecord.id],
      customRecords: [mimoRecord],
      grantedOrigins: ['https://aistudio.xiaomimimo.com/*', 'http://aistudio.xiaomimimo.com/*'],
      initialCookies: [
        {
          name: 'xiaomichatbot_ph',
          value: 'ph-active',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        // Panel-local cookie consent choice written inside iframe (never existed top-level)
        {
          name: 'cookie_consent_choice',
          value: 'accepted',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          storeId: '0',
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE, hasCrossSiteAncestor: true },
        },
      ],
    });

    await reconcileEmbeddedFrameCookies();
    expect(
      state.cookies
        .filter((c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE)
        .map((c) => c.name)
        .sort()
    ).toEqual(['cookie_consent_choice', 'xiaomichatbot_ph']);

    // Simulate top-level logout deleting unpartitioned xiaomichatbot_ph
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'xiaomichatbot_ph' && !c.partitionKey)
    );
    await reconcileEmbeddedFrameCookies();

    const remainingPartitioned = state.cookies.filter(
      (c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(remainingPartitioned.map((c) => c.name)).toEqual(['cookie_consent_choice']);
  });

  it('promotes in-panel ChatGLM user login over a stale top-level guest token and syncs in-panel logout cleanly', async () => {
    const guestJwt = createJwt({ uid: 'guest-1', is_guest: true });
    const guestRefresh = createJwt({ uid: 'guest-1', is_guest: true, type: 'refresh' });
    const realUserJwt = createJwt({ uid: 'real-user-99', is_guest: false });
    const realUserRefresh = createJwt({ uid: 'real-user-99', is_guest: false, type: 'refresh' });

    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialCookies: [
        {
          name: 'chatglm_token',
          value: guestJwt,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        {
          name: 'chatglm_refresh_token',
          value: guestRefresh,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        {
          name: 'chatglm_token',
          value: realUserJwt,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          storeId: '0',
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE, hasCrossSiteAncestor: true },
        },
        {
          name: 'chatglm_refresh_token',
          value: realUserRefresh,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'no_restriction',
          storeId: '0',
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE, hasCrossSiteAncestor: true },
        },
      ],
    });

    await reconcileEmbeddedFrameCookies();

    const unpartToken = state.cookies.find((c) => c.name === 'chatglm_token' && !c.partitionKey);
    const partToken = state.cookies.find(
      (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(unpartToken?.value).toBe(realUserJwt);
    expect(partToken?.value).toBe(realUserJwt);
    expect(state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY][CHATGLM_ORIGIN]).toHaveLength(2);

    // Simulate in-panel logout removing partitioned chatglm_token
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE)
    );
    const shouldReconcile = await handleEmbeddedFrameCookieChanged({
      removed: true,
      cause: 'expired_overwrite',
      cookie: {
        name: 'chatglm_token',
        value: '',
        domain: 'chatglm.cn',
        hostOnly: true,
        path: '/',
        partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
      },
    });
    expect(shouldReconcile).toBe(true);
    expect(state.cookies.some((c) => c.name === 'chatglm_token' && !c.partitionKey)).toBe(false);

    // Subsequent echo when unpartitioned cookie is already gone is a no-op
    await expect(
      handleEmbeddedFrameCookieChanged({
        removed: true,
        cause: 'explicit',
        cookie: {
          name: 'chatglm_token',
          value: '',
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
        },
      })
    ).resolves.toBe(false);
  });

  it('does not re-promote stale mirrored ChatGLM user tokens when top-level logs out into a guest session, and never persists raw cookie values', async () => {
    const userJwt = createJwt({ uid: 'zhipu-top-user', is_guest: false });
    const userRefresh = createJwt({ uid: 'zhipu-top-user', is_guest: false, type: 'refresh' });
    const postLogoutGuestJwt = createJwt({ uid: 'zhipu-guest-after-logout', is_guest: true });
    const postLogoutGuestRefresh = createJwt({
      uid: 'zhipu-guest-after-logout',
      is_guest: true,
      type: 'refresh',
    });

    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialCookies: [
        {
          name: 'chatglm_token',
          value: userJwt,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        {
          name: 'chatglm_refresh_token',
          value: userRefresh,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
      ],
    });

    // 1. Initial sync mirrors top-level user session to CHIPS and stores only non-secret digests
    await reconcileEmbeddedFrameCookies();
    const serializedStorage = JSON.stringify(state.localStorage);
    expect(serializedStorage).not.toContain(userJwt);
    expect(serializedStorage).not.toContain(userRefresh);

    // 2. Top-level logout replaces unpartitioned cookies with a new guest session while CHIPS still holds userJwt
    state.cookies = state.cookies.map((cookie) => {
      if (!cookie.partitionKey && cookie.name === 'chatglm_token') {
        return { ...cookie, value: postLogoutGuestJwt };
      }
      if (!cookie.partitionKey && cookie.name === 'chatglm_refresh_token') {
        return { ...cookie, value: postLogoutGuestRefresh };
      }
      return cookie;
    });

    await reconcileEmbeddedFrameCookies();

    const unpartAfterLogout = state.cookies.find((c) => c.name === 'chatglm_token' && !c.partitionKey);
    const partAfterLogout = state.cookies.find(
      (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(unpartAfterLogout?.value).toBe(postLogoutGuestJwt);
    expect(partAfterLogout?.value).toBe(postLogoutGuestJwt);

    // 3. If the user later logs back in inside the panel (even with the same userJwt), it promotes cleanly
    state.cookies = state.cookies.map((cookie) => {
      if (cookie.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && cookie.name === 'chatglm_token') {
        return { ...cookie, value: userJwt };
      }
      if (
        cookie.partitionKey?.topLevelSite === EXTENSION_TOP_SITE &&
        cookie.name === 'chatglm_refresh_token'
      ) {
        return { ...cookie, value: userRefresh };
      }
      return cookie;
    });

    await reconcileEmbeddedFrameCookies();

    expect(state.cookies.find((c) => c.name === 'chatglm_token' && !c.partitionKey)?.value).toBe(
      userJwt
    );
  });

  it('coalesces burst reconcile calls in createEmbeddedFrameCookieReconcileScheduler', async () => {
    let releaseFirst;
    let count = 0;
    const reconcile = vi.fn(() => {
      count += 1;
      if (count === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve();
    });
    const schedule = createEmbeddedFrameCookieReconcileScheduler(reconcile);

    const first = schedule();
    await Promise.resolve();
    const second = schedule();
    const third = schedule();
    expect(third).toBe(second);

    releaseFirst();
    await expect(first).resolves.toEqual({ success: true });
    await expect(second).resolves.toEqual({ success: true });
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
