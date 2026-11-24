import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_PROVIDERS_STORAGE_KEY,
  toCustomProviderDescriptor,
} from '../modules/custom-providers.js';
import {
  CHATGLM_ORIGIN,
  EMBEDDED_FRAME_COOKIE_SYNC_ACTION,
  MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY,
  PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY,
  computeCookieValueDigest,
  cookieMatchesHostname,
  createEmbeddedFrameCookieReconcileScheduler,
  getExtensionPartitionKey,
  isEmbeddedFrameTopLevelCookieChange,
  reconcileEmbeddedFrameCookies,
  requiresEmbeddedFrameCookieSync,
} from '../modules/embedded-frame-cookies.js';
import {
  getCompanionCookiePermissionOrigins,
  getProviderDescriptor,
  getProviderRequestPermissionOrigins,
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
  initialPendingCleanups = {},
  topDomainsSupported = true,
  enforceHostPermissionsOnCookies = false,
} = {}) {
  const state = {
    enabledProviders: [...enabledProviders],
    customRecords: structuredClone(customRecords),
    grantedOrigins: new Set(grantedOrigins),
    cookies: structuredClone(initialCookies),
    localStorage: {
      [CUSTOM_PROVIDERS_STORAGE_KEY]: structuredClone(customRecords),
      [MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]: structuredClone(initialMirrored),
      [PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]: structuredClone(initialPendingCleanups),
    },
  };

  const hasHostAccessForCookie = (cookie) => {
    if (!enforceHostPermissionsOnCookies) {
      return true;
    }
    const cleanHost = (cookie.domain || '').replace(/^\.+/, '').toLowerCase();
    const hasHttps = state.grantedOrigins.has(`https://${cleanHost}/*`);
    const hasHttp = state.grantedOrigins.has(`http://${cleanHost}/*`);
    if (cookie.secure) {
      return hasHttps;
    }
    return hasHttp;
  };

  const hasHostAccessForUrl = (rawUrl) => {
    if (!enforceHostPermissionsOnCookies) {
      return true;
    }
    const parsed = new URL(rawUrl);
    return state.grantedOrigins.has(`${parsed.origin}/*`);
  };

  const matchesCookieFilter = (cookie, filter = {}) => {
    if (!hasHostAccessForCookie(cookie)) {
      return false;
    }

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
      if (!hasHostAccessForUrl(details.url)) {
        return Promise.reject(new Error(`No host permissions for cookies at url: ${details.url}`));
      }
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
      if (!hasHostAccessForUrl(details.url)) {
        return Promise.reject(new Error(`No host permissions for cookies at url: ${details.url}`));
      }
      const parsedUrl = new URL(details.url);
      const partitionTop = details.partitionKey?.topLevelSite || null;
      const before = state.cookies.length;
      state.cookies = state.cookies.filter(
        (existing) =>
          !(
            existing.name === details.name &&
            cookieMatchesHostname(existing.domain, Boolean(existing.hostOnly), parsedUrl.hostname) &&
            (existing.path || '/') === (parsedUrl.pathname || '/') &&
            (existing.partitionKey?.topLevelSite || null) === partitionTop
          )
      );
      if (state.cookies.length === before) {
        return Promise.resolve(null);
      }
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

  it('keeps core permissionOrigins HTTPS-only while computing companion cookie origins separately', () => {
    expect(getCompanionCookiePermissionOrigins('http://localhost:3000')).toEqual([]);
    expect(getCompanionCookiePermissionOrigins('https://aistudio.xiaomimimo.com')).toEqual([
      'http://aistudio.xiaomimimo.com/*',
    ]);
    expect(getCompanionCookiePermissionOrigins('https://chat.internal.example:8443')).toEqual([
      'https://chat.internal.example/*',
      'http://chat.internal.example/*',
    ]);
    expect(getCompanionCookiePermissionOrigins('not-an-origin')).toEqual([]);

    const chatglm = getProviderDescriptor('chatglm');
    expect(chatglm.permissionOrigins).toEqual(['https://chatglm.cn/*']);
    expect(getProviderRequestPermissionOrigins(chatglm)).toEqual([
      'https://chatglm.cn/*',
      'http://chatglm.cn/*',
    ]);

    const mimoDescriptor = toCustomProviderDescriptor({
      id: 'custom-1111111111',
      name: 'Xiaomi MiMo',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    });
    expect(mimoDescriptor.permissionOrigins).toEqual(['https://aistudio.xiaomimimo.com/*']);
    expect(getProviderRequestPermissionOrigins(mimoDescriptor)).toEqual([
      'https://aistudio.xiaomimimo.com/*',
      'http://aistudio.xiaomimimo.com/*',
    ]);
  });

  it('identifies providers requiring embedded frame cookie sync', () => {
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
  });

  it('gates non-Secure cookie mirroring on http://<hostname>/* while allowing Secure cookie mirroring under legacy HTTPS-only grants', async () => {
    const mimoRecord = {
      id: 'custom-aabbccddee',
      name: 'Xiaomi MiMo',
      url: 'https://aistudio.xiaomimimo.com/',
      frameRuleId: 10000,
      createdAt: 1700000000000,
    };

    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm', mimoRecord.id],
      customRecords: [mimoRecord],
      // Legacy HTTPS-only upgrade: NO http:// grants yet
      grantedOrigins: ['https://chatglm.cn/*', 'https://aistudio.xiaomimimo.com/*'],
      initialCookies: [
        // Non-Secure cookie -> skipped until http:// grant exists
        {
          name: 'chatglm_token',
          value: 'non-secure-token',
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        // Secure SameSite=Lax cookie -> still mirrored under HTTPS-only grant
        {
          name: 'mimo_secure_pref',
          value: 'dark',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        // Non-Secure MiMo CSRF cookie -> skipped until http:// grant exists
        {
          name: 'xiaomichatbot_ph',
          value: 'ph-token-1',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'unspecified',
          storeId: '0',
        },
      ],
    });

    await reconcileEmbeddedFrameCookies();

    const partBeforeHttpGrant = state.cookies.filter(
      (c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(partBeforeHttpGrant.map((c) => ({ domain: c.domain, name: c.name }))).toEqual([
      { domain: 'aistudio.xiaomimimo.com', name: 'mimo_secure_pref' },
    ]);

    // Once user grants companion http:// permissions, non-Secure cookies mirror immediately
    state.grantedOrigins.add('http://chatglm.cn/*');
    state.grantedOrigins.add('http://aistudio.xiaomimimo.com/*');
    await reconcileEmbeddedFrameCookies();

    const partAfterHttpGrant = state.cookies.filter(
      (c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(
      partAfterHttpGrant
        .map((c) => ({ domain: c.domain, name: c.name, value: c.value }))
        .sort((a, b) => a.name.localeCompare(b.name))
    ).toEqual([
      { domain: 'chatglm.cn', name: 'chatglm_token', value: 'non-secure-token' },
      { domain: 'aistudio.xiaomimimo.com', name: 'mimo_secure_pref', value: 'dark' },
      { domain: 'aistudio.xiaomimimo.com', name: 'xiaomichatbot_ph', value: 'ph-token-1' },
    ]);
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

    // Raw cookie values are never stored in chrome.storage.local
    const serializedStorage = JSON.stringify(state.localStorage);
    expect(serializedStorage).not.toContain(userJwt);
    expect(serializedStorage).not.toContain(refreshJwt);
    expect(serializedStorage).not.toContain('ph-token-xyz');

    // Re-running reconcile when nothing changed performs zero redundant cookie writes
    chrome.cookies.set.mockClear();
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
  });

  it('is strictly one-way: never writes or deletes unpartitioned top-level cookies and ignores partitioned onChanged events (including HttpOnly, self-writes, and evictions)', async () => {
    const topLevelToken = createJwt({ uid: 'top-user', is_guest: false });
    const panelHttpOnlyToken = createJwt({ uid: 'panel-httponly', is_guest: false });

    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialCookies: [
        {
          name: 'chatglm_token',
          value: topLevelToken,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'lax',
          storeId: '0',
        },
        // Partitioned HttpOnly cookie in panel -> must NEVER be promoted/downgraded to top-level
        {
          name: 'chatglm_token',
          value: panelHttpOnlyToken,
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/',
          secure: true,
          httpOnly: true,
          sameSite: 'no_restriction',
          storeId: '0',
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE, hasCrossSiteAncestor: true },
        },
      ],
    });

    await reconcileEmbeddedFrameCookies();

    // Every chrome.cookies.set/remove call (if any) must strictly target partitioned cookies only
    for (const [details] of chrome.cookies.set.mock.calls) {
      expect(details.partitionKey).toEqual({ topLevelSite: EXTENSION_TOP_SITE });
    }
    for (const [details] of chrome.cookies.remove.mock.calls) {
      expect(details.partitionKey).toEqual({ topLevelSite: EXTENSION_TOP_SITE });
    }
    const unpart = state.cookies.find((c) => c.name === 'chatglm_token' && !c.partitionKey);
    expect(unpart).toMatchObject({ value: topLevelToken, httpOnly: true, secure: true });

    // Partitioned cookie events (eviction, expiration, delayed self-write, HttpOnly) are all ignored
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: true,
        cause: 'evicted',
        cookie: {
          name: 'chatglm_token',
          value: 'old',
          domain: 'chatglm.cn',
          httpOnly: false,
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
        },
      })
    ).toBe(false);
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: false,
        cause: 'explicit',
        cookie: {
          name: 'chatglm_token',
          value: 'delayed-self-write',
          domain: 'chatglm.cn',
          httpOnly: false,
          partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
        },
      })
    ).toBe(false);
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: false,
        cause: 'explicit',
        cookie: {
          name: 'serviceToken',
          value: 'secret',
          domain: 'aistudio.xiaomimimo.com',
          httpOnly: true,
        },
      })
    ).toBe(false);
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: true,
        cause: 'overwrite',
        cookie: {
          name: 'chatglm_token',
          value: 'old',
          domain: 'chatglm.cn',
          httpOnly: false,
        },
      })
    ).toBe(false);

    // Unpartitioned non-HttpOnly insertions and explicit removals trigger one-way reconciliation
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: false,
        cause: 'explicit',
        cookie: {
          name: 'chatglm_token',
          value: 'new-top-level',
          domain: 'chatglm.cn',
          httpOnly: false,
        },
      })
    ).toBe(true);
    expect(
      isEmbeddedFrameTopLevelCookieChange({
        removed: true,
        cause: 'explicit',
        cookie: {
          name: 'xiaomichatbot_ph',
          value: 'old',
          domain: 'aistudio.xiaomimimo.com',
          httpOnly: false,
        },
      })
    ).toBe(true);
  });

  it('preserves fresh panel-owned sessions across refresh and top-level logout, updates on brand-new top-level login, and records only verified writes', async () => {
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
          value: 'session-A',
          domain: 'aistudio.xiaomimimo.com',
          hostOnly: true,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
      ],
    });

    // 1. If cookies.set fails, do NOT record an unwritten digest in tracking state
    chrome.cookies.set.mockRejectedValueOnce(new Error('Transient write failure'));
    await reconcileEmbeddedFrameCookies();
    expect(state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});

    // 2. Subsequent verified write succeeds and records digest of session-A
    await reconcileEmbeddedFrameCookies();
    expect(
      state.cookies.find(
        (c) => c.name === 'xiaomichatbot_ph' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('session-A');
    expect(
      state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]['https://aistudio.xiaomimimo.com']
    ).toEqual([
      JSON.stringify([
        '0',
        1,
        'aistudio.xiaomimimo.com',
        '/',
        'xiaomichatbot_ph',
        computeCookieValueDigest('session-A'),
      ]),
    ]);

    // 3. Panel rotates / switches account to session-B while top-level still holds stale session-A.
    //    Repeated reconciles (e.g. panel refresh) MUST preserve session-B!
    state.cookies = state.cookies.map((c) =>
      c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && c.name === 'xiaomichatbot_ph'
        ? { ...c, value: 'session-B-panel-rotated' }
        : c
    );
    chrome.cookies.set.mockClear();
    await reconcileEmbeddedFrameCookies();
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(
      state.cookies.find(
        (c) => c.name === 'xiaomichatbot_ph' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('session-B-panel-rotated');

    // 4. If top-level now removes session-A (top-level logout), cleanup checks digest and MUST NOT
    //    delete the newer panel-owned session-B!
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'xiaomichatbot_ph' && !c.partitionKey)
    );
    await reconcileEmbeddedFrameCookies();
    expect(
      state.cookies.find(
        (c) => c.name === 'xiaomichatbot_ph' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('session-B-panel-rotated');
    expect(state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});

    // 5. Re-establish mirrored session-A -> panel rotates to session-B -> top-level actively logs
    //    into brand-new session-C (new digest != last mirrored digest) -> mirrors session-C!
    state.cookies = state.cookies.filter((c) => !c.partitionKey);
    state.cookies.push({
      name: 'xiaomichatbot_ph',
      value: 'session-A',
      domain: 'aistudio.xiaomimimo.com',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
      storeId: '0',
    });
    await reconcileEmbeddedFrameCookies();
    state.cookies = state.cookies.map((c) =>
      c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && c.name === 'xiaomichatbot_ph'
        ? { ...c, value: 'session-B-panel-rotated' }
        : c
    );
    state.cookies = state.cookies.map((c) =>
      !c.partitionKey && c.name === 'xiaomichatbot_ph'
        ? { ...c, value: 'session-C-top-new-account' }
        : c
    );
    await reconcileEmbeddedFrameCookies();
    expect(
      state.cookies.find(
        (c) => c.name === 'xiaomichatbot_ph' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('session-C-top-new-account');
    expect(
      state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]['https://aistudio.xiaomimimo.com']
    ).toEqual([
      JSON.stringify([
        '0',
        1,
        'aistudio.xiaomimimo.com',
        '/',
        'xiaomichatbot_ph',
        computeCookieValueDigest('session-C-top-new-account'),
      ]),
    ]);
  });

  it('removes unmodified mirrored CHIPS cookies on top-level logout while preserving panel-only CHIPS consent cookies', async () => {
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

    // Top-level logout deletes unpartitioned xiaomichatbot_ph; mirror digest still matches -> removed
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'xiaomichatbot_ph' && !c.partitionKey)
    );
    await reconcileEmbeddedFrameCookies();

    const remainingPartitioned = state.cookies.filter(
      (c) => c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
    );
    expect(remainingPartitioned.map((c) => c.name)).toEqual(['cookie_consent_choice']);
  });

  it('retains pending cleanup across external host-permission revocation and flushes stale mirrors on regrant without deleting newer panel-owned cookies', async () => {
    const userJwt = createJwt({ uid: 'zhipu-user-1', is_guest: false });
    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      enforceHostPermissionsOnCookies: true,
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
      ],
    });

    // 1. Initial mirror succeeds
    await reconcileEmbeddedFrameCookies();
    expect(
      state.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe(userJwt);

    // 2. User revokes chatglm.cn externally in chrome://extensions while mirror stays in CHIPS
    state.grantedOrigins.delete('https://chatglm.cn/*');
    state.grantedOrigins.delete('http://chatglm.cn/*');
    await reconcileEmbeddedFrameCookies();

    // Stale cookie still sits in CHIPS (could not be removed without host permission),
    // and its identity + digest MUST be retained in pendingEmbeddedFrameCookieCleanups!
    expect(
      state.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe(userJwt);
    expect(state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});
    expect(
      state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY][CHATGLM_ORIGIN]
    ).toEqual([
      JSON.stringify([
        '0',
        1,
        'chatglm.cn',
        '/',
        'chatglm_token',
        computeCookieValueDigest(userJwt),
      ]),
    ]);

    // 3. While permission is absent, user logs out of chatglm.cn in a top-level tab
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'chatglm_token' && !c.partitionKey)
    );

    // 4. User regrants permission -> reconcile flushes pending cleanup BEFORE panel startup,
    //    deleting the stale mirrored token cleanly!
    state.grantedOrigins.add('https://chatglm.cn/*');
    state.grantedOrigins.add('http://chatglm.cn/*');
    await reconcileEmbeddedFrameCookies();

    expect(
      state.cookies.some(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )
    ).toBe(false);
    expect(state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]).toEqual({});

    // 5. Repeat revocation flow when cookies.remove fails transiently, AND verify that if the
    //    panel cookie changed to a newer value before flush, flush preserves the newer value.
    state.cookies.push({
      name: 'chatglm_token',
      value: userJwt,
      domain: 'chatglm.cn',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'lax',
      storeId: '0',
    });
    await reconcileEmbeddedFrameCookies();

    // Disable provider while cookies.remove fails -> retained in pending cleanup
    state.enabledProviders = [];
    chrome.cookies.remove.mockRejectedValueOnce(new Error('Transient remove failure'));
    await reconcileEmbeddedFrameCookies();
    expect(
      state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY][CHATGLM_ORIGIN]
    ).toHaveLength(1);

    // Suppose before retry, the partitioned cookie now holds a fresh panel-owned token
    state.cookies = state.cookies.map((c) =>
      c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && c.name === 'chatglm_token'
        ? { ...c, value: 'fresh-panel-owned-token' }
        : c
    );
    await reconcileEmbeddedFrameCookies();

    // Pending cleanup settles without deleting the fresh panel-owned token
    expect(
      state.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('fresh-panel-owned-token');
    expect(state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]).toEqual({});
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
