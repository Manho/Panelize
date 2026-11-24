import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  getEmbeddedFrameCookieSyncOrigin,
  getExtensionPartitionKey,
  hasPendingEmbeddedCookieCleanupForProvider,
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

    if (filter.storeId && (cookie.storeId || '0') !== filter.storeId) {
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

      // Match Chromium CookieMonster behavior: an expirationDate in the past expires
      // only that exact canonical cookie and resolves to null without inserting it.
      if (typeof details.expirationDate === 'number' && details.expirationDate * 1000 <= Date.now()) {
        return Promise.resolve(null);
      }

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
    // Match Chromium's real CookieDeletionInfo bug (cookies_api.cc:747 ->
    // cookie_deletion_info.cc:114 -> cookie_monster.cc:951): chrome.cookies.remove
    // with partitionKey leaves partitioned_state_only unset, so it ALSO deletes
    // matching unpartitioned cookies and any same-name cookies whose path prefixes url.
    remove: vi.fn((details) => {
      if (!hasHostAccessForUrl(details.url)) {
        return Promise.reject(new Error(`No host permissions for cookies at url: ${details.url}`));
      }
      const parsedUrl = new URL(details.url);
      const partitionTop = details.partitionKey?.topLevelSite || null;
      const before = state.cookies.length;
      state.cookies = state.cookies.filter((existing) => {
        const existingPartition = existing.partitionKey?.topLevelSite || null;
        const partitionMatches =
          existingPartition === partitionTop || (partitionTop !== null && existingPartition === null);
        const existingPath = existing.path || '/';
        const pathMatches = (parsedUrl.pathname || '/').startsWith(existingPath);
        return !(
          existing.name === details.name &&
          cookieMatchesHostname(existing.domain, Boolean(existing.hostOnly), parsedUrl.hostname) &&
          pathMatches &&
          partitionMatches
        );
      });
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

    // 5. Re-establish mirrored session-A -> when panel STILL holds mirrored session-A and
    //    top-level actively changes to session-C -> mirrors session-C.
    state.cookies = [];
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

    // 6. If panel now diverges to session-D while top-level changes to session-E, panel-owned
    //    session-D is still preserved and mirror tracking is relinquished.
    state.cookies = state.cookies.map((c) =>
      c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && c.name === 'xiaomichatbot_ph'
        ? { ...c, value: 'session-D-panel-owned' }
        : c
    );
    state.cookies = state.cookies.map((c) =>
      !c.partitionKey && c.name === 'xiaomichatbot_ph'
        ? { ...c, value: 'session-E-top-refreshed' }
        : c
    );
    chrome.cookies.set.mockClear();
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(
      state.cookies.find(
        (c) => c.name === 'xiaomichatbot_ph' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('session-D-panel-owned');
    expect(state.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});
  });

  it('never overwrites or adopts pre-existing panel-owned cookies when mirror tracking storage is empty (upgrade / fresh storage)', async () => {
    // Case A: empty tracking + pre-existing panel cookie B != top-level A -> preserve B untouched
    const stateA = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialMirrored: {},
      initialCookies: [
        {
          name: 'chatglm_token',
          value: 'top-level-A',
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
          value: 'panel-owned-B',
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
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(
      stateA.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('panel-owned-B');
    expect(stateA.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});

    // Case B: empty tracking + pre-existing panel cookie A == top-level A -> do NOT adopt ownership,
    // so a subsequent top-level logout does NOT delete the panel-owned cookie!
    const stateB = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialMirrored: {},
      initialCookies: [
        {
          name: 'chatglm_token',
          value: 'shared-value-A',
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
          value: 'shared-value-A',
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
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(stateB.localStorage[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]).toEqual({});

    // Top-level logs out -> pre-existing panel cookie A MUST survive because we never wrote/adopted it
    stateB.cookies = stateB.cookies.filter(
      (c) => !(c.name === 'chatglm_token' && !c.partitionKey)
    );
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.set).not.toHaveBeenCalled();
    expect(chrome.cookies.remove).not.toHaveBeenCalled();
    expect(
      stateB.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('shared-value-A');
  });

  it('expires mirrored CHIPS cookies via exact-identity cookies.set (never cookies.remove), preserving top-level cookies, other-path cookies, and hostOnly vs domain distinctions', async () => {
    const state = installStatefulCookieEnv({
      enabledProviders: ['chatglm'],
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialCookies: [
        // Host-only top-level cookie at /chat
        {
          name: 'chatglm_token',
          value: 'host-chat-token',
          domain: 'chatglm.cn',
          hostOnly: true,
          path: '/chat',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        // Domain-scoped top-level cookie at /
        {
          name: 'chatglm_domain_cookie',
          value: 'domain-root-token',
          domain: '.chatglm.cn',
          hostOnly: false,
          path: '/',
          secure: false,
          httpOnly: false,
          sameSite: 'lax',
          storeId: '0',
        },
        // Pre-existing panel-only CHIPS cookie with same name on parent path '/' (must NOT be touched!)
        {
          name: 'chatglm_token',
          value: 'panel-root-path-session',
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

    // Verify both host-only (/chat) and domain-scoped (.chatglm.cn /) mirrors were created
    expect(
      state.cookies.find(
        (c) =>
          c.name === 'chatglm_token' &&
          c.path === '/chat' &&
          c.hostOnly === true &&
          c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('host-chat-token');
    expect(
      state.cookies.find(
        (c) =>
          c.name === 'chatglm_domain_cookie' &&
          c.domain === '.chatglm.cn' &&
          c.hostOnly === false &&
          c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('domain-root-token');

    // Disable provider while top-level cookies are STILL present -> cleanup runs!
    chrome.cookies.set.mockClear();
    chrome.cookies.remove.mockClear();
    state.enabledProviders = [];
    const cleanupResult = await reconcileEmbeddedFrameCookies();
    expect(cleanupResult).toEqual({
      ok: true,
      success: true,
      hasPendingCleanup: false,
      pendingCleanupCount: 0,
      pendingCleanupsByOrigin: {},
    });

    // CRITICAL: chrome.cookies.remove MUST NEVER be called (Chromium bug deletes top-level cookies!)
    expect(chrome.cookies.remove).not.toHaveBeenCalled();

    // Verify exact-identity expiration calls: hostOnly omits domain, domain cookie passes domain
    const expireCalls = chrome.cookies.set.mock.calls.map(([details]) => details);
    expect(expireCalls).toHaveLength(2);
    const hostExpire = expireCalls.find((d) => d.name === 'chatglm_token');
    const domainExpire = expireCalls.find((d) => d.name === 'chatglm_domain_cookie');
    expect(hostExpire).toMatchObject({
      url: 'https://chatglm.cn/chat',
      name: 'chatglm_token',
      value: '',
      path: '/chat',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: 1,
      partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
    });
    expect('domain' in hostExpire).toBe(false);

    expect(domainExpire).toMatchObject({
      url: 'https://chatglm.cn/',
      domain: '.chatglm.cn',
      name: 'chatglm_domain_cookie',
      value: '',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: 1,
      partitionKey: { topLevelSite: EXTENSION_TOP_SITE },
    });

    // Both mirrored CHIPS cookies are gone
    expect(
      state.cookies.some(
        (c) =>
          c.name === 'chatglm_token' &&
          c.path === '/chat' &&
          c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )
    ).toBe(false);
    expect(
      state.cookies.some(
        (c) =>
          c.name === 'chatglm_domain_cookie' &&
          c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )
    ).toBe(false);

    // Unpartitioned top-level cookies AND the other-path CHIPS cookie are ALL STILL INTACT!
    expect(
      state.cookies.find((c) => c.name === 'chatglm_token' && !c.partitionKey)?.value
    ).toBe('host-chat-token');
    expect(
      state.cookies.find((c) => c.name === 'chatglm_domain_cookie' && !c.partitionKey)?.value
    ).toBe('domain-root-token');
    expect(
      state.cookies.find(
        (c) =>
          c.name === 'chatglm_token' &&
          c.path === '/' &&
          c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('panel-root-path-session');
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

    // Top-level logout deletes unpartitioned xiaomichatbot_ph; mirror digest still matches -> expired
    state.cookies = state.cookies.filter(
      (c) => !(c.name === 'xiaomichatbot_ph' && !c.partitionKey)
    );
    await reconcileEmbeddedFrameCookies();
    expect(chrome.cookies.remove).not.toHaveBeenCalled();

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
    const revokeResult = await reconcileEmbeddedFrameCookies();
    expect(revokeResult).toEqual({
      ok: false,
      success: false,
      hasPendingCleanup: true,
      pendingCleanupCount: 1,
      pendingCleanupsByOrigin: { [CHATGLM_ORIGIN]: 1 },
    });

    // Stale cookie still sits in CHIPS (could not be expired without host permission),
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
    //    expiring the stale mirrored token cleanly!
    state.grantedOrigins.add('https://chatglm.cn/*');
    state.grantedOrigins.add('http://chatglm.cn/*');
    const regrantResult = await reconcileEmbeddedFrameCookies();
    expect(regrantResult).toEqual({
      ok: true,
      success: true,
      hasPendingCleanup: false,
      pendingCleanupCount: 0,
      pendingCleanupsByOrigin: {},
    });

    expect(
      state.cookies.some(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )
    ).toBe(false);
    expect(state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]).toEqual({});

    // 5. Repeat revocation flow when cookies.set expiration fails transiently, AND verify that
    //    if the panel cookie changed to a newer value before flush, flush preserves the newer value.
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

    // Disable provider while cookies.set expiration fails -> retained in pending cleanup and reports ok: false
    state.enabledProviders = [];
    chrome.cookies.set.mockRejectedValueOnce(new Error('Transient expire failure'));
    const failedDisableResult = await reconcileEmbeddedFrameCookies();
    expect(failedDisableResult).toEqual({
      ok: false,
      success: false,
      hasPendingCleanup: true,
      pendingCleanupCount: 1,
      pendingCleanupsByOrigin: { [CHATGLM_ORIGIN]: 1 },
    });
    expect(
      state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY][CHATGLM_ORIGIN]
    ).toHaveLength(1);

    // Suppose before retry, the partitioned cookie now holds a fresh panel-owned token
    state.cookies = state.cookies.map((c) =>
      c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE && c.name === 'chatglm_token'
        ? { ...c, value: 'fresh-panel-owned-token' }
        : c
    );
    const settledResult = await reconcileEmbeddedFrameCookies();
    expect(settledResult).toEqual({
      ok: true,
      success: true,
      hasPendingCleanup: false,
      pendingCleanupCount: 0,
      pendingCleanupsByOrigin: {},
    });

    // Pending cleanup settles without deleting the fresh panel-owned token
    expect(
      state.cookies.find(
        (c) => c.name === 'chatglm_token' && c.partitionKey?.topLevelSite === EXTENSION_TOP_SITE
      )?.value
    ).toBe('fresh-panel-owned-token');
    expect(state.localStorage[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]).toEqual({});
  });

  it('reports ok: false and hasPendingCleanup: true when pending cleanup retry still fails on regrant/startup, and blocks Multi-Panel iframe navigation until cleanup succeeds', async () => {
    const staleJwt = createJwt({ uid: 'stale-logged-out-user', is_guest: false });
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
      grantedOrigins: ['https://chatglm.cn/*', 'http://chatglm.cn/*'],
      initialCookies: [
        {
          name: 'chatglm_token',
          value: staleJwt,
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
      initialPendingCleanups: {
        [CHATGLM_ORIGIN]: [
          JSON.stringify([
            '0',
            1,
            'chatglm.cn',
            '/',
            'chatglm_token',
            computeCookieValueDigest(staleJwt),
          ]),
        ],
      },
    });

    const schedule = createEmbeddedFrameCookieReconcileScheduler(reconcileEmbeddedFrameCookies);

    // Retry fails on regrant/panel startup -> scheduler MUST NOT report ok: true!
    chrome.cookies.set.mockRejectedValueOnce(new Error('Persistent expire failure'));
    const failedStartupSync = await schedule();
    expect(failedStartupSync).toEqual({
      ok: false,
      success: false,
      hasPendingCleanup: true,
      pendingCleanupCount: 1,
      pendingCleanupsByOrigin: { [CHATGLM_ORIGIN]: 1 },
    });
    expect(getEmbeddedFrameCookieSyncOrigin('chatglm')).toBe(CHATGLM_ORIGIN);
    expect(hasPendingEmbeddedCookieCleanupForProvider('chatglm', failedStartupSync)).toBe(true);
    expect(hasPendingEmbeddedCookieCleanupForProvider(mimoRecord.id, failedStartupSync)).toBe(false);
    expect(
      hasPendingEmbeddedCookieCleanupForProvider('chatglm', {
        ok: false,
        hasPendingCleanup: true,
        pendingCleanupCount: 1,
      })
    ).toBe(true);

    // Now boot real multi-panel/multi-panel.js in jsdom and verify it blocks Zhipu iframe
    // navigation when sync returns pending cleanup, then loads cleanly once refresh succeeds.
    const multiPanelHtml = readFileSync(
      resolve(process.cwd(), 'multi-panel/multi-panel.html'),
      'utf8'
    );
    const bodyHtml = multiPanelHtml
      .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

    vi.resetModules();
    document.body.innerHTML = bodyHtml;

    const cleanupListeners = [];
    const origWinAdd = window.addEventListener.bind(window);
    const origWinRemove = window.removeEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    const origDocRemove = document.removeEventListener.bind(document);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origWinRemove(type, listener, options));
      return origWinAdd(type, listener, options);
    });
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origDocRemove(type, listener, options));
      return origDocAdd(type, listener, options);
    });

    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.windows = {
      getCurrent: vi.fn(() => Promise.resolve({ type: 'normal' })),
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    };
    chrome.storage.session = {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.local.get.mockImplementation((keys) =>
      Promise.resolve(
        typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? { ...keys } : {}
      )
    );
    chrome.storage.local.set.mockResolvedValue();
    chrome.storage.local.remove.mockResolvedValue();
    chrome.storage.sync.get.mockImplementation((defaults) =>
      Promise.resolve({
        ...(typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? defaults
          : {}),
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x1',
        enabledProviders: ['chatglm'],
        providerOrder: ['chatglm'],
        multiPanelProviders: ['chatglm'],
      })
    );
    chrome.storage.sync.set.mockResolvedValue();

    let nextCookieSyncResponse = failedStartupSync;
    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      const response =
        msg?.action === EMBEDDED_FRAME_COOKIE_SYNC_ACTION
          ? nextCookieSyncResponse
          : { success: true };
      if (callback) callback(response);
      return Promise.resolve(response);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );

    try {
      await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(1);
      });

      const panelEl = document.querySelector('#panel-grid .panel-item');
      const iframe = panelEl.querySelector('iframe');
      const loadingEl = panelEl.querySelector('.panel-loading');

      // Iframe MUST NOT navigate to chatglm.cn while pending cleanup remains unresolved
      expect(iframe.getAttribute('src')).toBeNull();
      expect(loadingEl.classList.contains('hidden')).toBe(false);
      expect(loadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');
      expect(loadingEl.textContent).toContain('Failed to clear previous');

      // Clicking Refresh once cleanup succeeds clears the blocked state and navigates cleanly
      nextCookieSyncResponse = {
        ok: true,
        success: true,
        hasPendingCleanup: false,
        pendingCleanupCount: 0,
        pendingCleanupsByOrigin: {},
      };
      panelEl.querySelector('.refresh-panel-btn').click();
      await vi.waitFor(() => {
        expect(iframe.getAttribute('src')).toBe('https://chatglm.cn/');
      });
      expect(loadingEl.dataset.blockedReason).toBeUndefined();
    } finally {
      for (const cleanup of cleanupListeners.splice(0)) {
        cleanup();
      }
      globalThis.fetch = originalFetch;
      document.body.innerHTML = '';
    }
  });

  it('preserves pending-cleanup block on a custom HTTPS panel across New Chat for All, settings-driven reload, and unsuccessful Refresh until affirmative clearance', async () => {
    const mimoOrigin = 'https://aistudio.xiaomimimo.com';
    const initialMimoRecord = {
      id: 'custom-a1b2c3d4e5',
      name: 'MiMo',
      url: `${mimoOrigin}/`,
      frameRuleId: 10002,
      createdAt: 1700000000000,
    };
    const updatedMimoRecord = {
      ...initialMimoRecord,
      name: 'MiMo Updated',
      url: `${mimoOrigin}/chat`,
    };

    const multiPanelHtml = readFileSync(
      resolve(process.cwd(), 'multi-panel/multi-panel.html'),
      'utf8'
    );
    const bodyHtml = multiPanelHtml
      .match(/<body[^>]*>([\s\S]*?)<\/body>/i)[1]
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

    vi.resetModules();
    document.body.innerHTML = bodyHtml;

    const cleanupListeners = [];
    const origWinAdd = window.addEventListener.bind(window);
    const origWinRemove = window.removeEventListener.bind(window);
    const origDocAdd = document.addEventListener.bind(document);
    const origDocRemove = document.removeEventListener.bind(document);
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origWinRemove(type, listener, options));
      return origWinAdd(type, listener, options);
    });
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      cleanupListeners.push(() => origDocRemove(type, listener, options));
      return origDocAdd(type, listener, options);
    });

    const storageListeners = new Set();
    const originalOnChanged = chrome.storage.onChanged;
    chrome.storage.onChanged = {
      addListener: vi.fn((listener) => storageListeners.add(listener)),
      removeListener: vi.fn((listener) => storageListeners.delete(listener)),
    };

    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.windows = {
      getCurrent: vi.fn(() => Promise.resolve({ type: 'normal' })),
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    };
    chrome.storage.session = {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    };

    let currentCustomRecords = [initialMimoRecord];
    chrome.storage.local.get.mockImplementation((keys) => {
      const defaults =
        typeof keys === 'object' && keys !== null && !Array.isArray(keys) ? { ...keys } : {};
      if (
        keys === CUSTOM_PROVIDERS_STORAGE_KEY ||
        (Array.isArray(keys) && keys.includes(CUSTOM_PROVIDERS_STORAGE_KEY)) ||
        (typeof keys === 'object' && keys !== null && CUSTOM_PROVIDERS_STORAGE_KEY in keys)
      ) {
        defaults[CUSTOM_PROVIDERS_STORAGE_KEY] = structuredClone(currentCustomRecords);
      }
      return Promise.resolve(defaults);
    });
    chrome.storage.local.set.mockResolvedValue();
    chrome.storage.local.remove.mockResolvedValue();
    chrome.storage.sync.get.mockImplementation((defaults) =>
      Promise.resolve({
        ...(typeof defaults === 'object' && defaults !== null && !Array.isArray(defaults)
          ? defaults
          : {}),
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x2',
        enabledProviders: ['chatgpt', initialMimoRecord.id],
        providerOrder: ['chatgpt', initialMimoRecord.id],
        multiPanelProviders: ['chatgpt', initialMimoRecord.id],
      })
    );
    chrome.storage.sync.set.mockResolvedValue();

    let cookieSyncBehavior = () =>
      Promise.resolve({
        ok: false,
        success: false,
        hasPendingCleanup: true,
        pendingCleanupCount: 1,
        pendingCleanupsByOrigin: { [mimoOrigin]: 1 },
      });
    let cookieSyncCallCount = 0;

    chrome.runtime.sendMessage.mockImplementation((msg, callback) => {
      if (msg?.action === EMBEDDED_FRAME_COOKIE_SYNC_ACTION) {
        cookieSyncCallCount += 1;
        return cookieSyncBehavior();
      }
      const response = { success: true };
      if (callback) callback(response);
      return Promise.resolve(response);
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    );

    const flushMicrotasks = async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    };

    try {
      await import('../multi-panel/multi-panel.js');
      await vi.waitFor(() => {
        expect(document.querySelectorAll('#panel-grid .panel-item')).toHaveLength(2);
      });

      const [chatgptPanelEl, mimoPanelEl] = Array.from(
        document.querySelectorAll('#panel-grid .panel-item')
      );
      const chatgptIframe = chatgptPanelEl.querySelector('iframe');
      const mimoIframe = mimoPanelEl.querySelector('iframe');
      const mimoLoadingEl = mimoPanelEl.querySelector('.panel-loading');

      // Initial startup: ChatGPT loads normally while MiMo is blocked due to pending cleanup
      expect(chatgptIframe.getAttribute('src')).toBe('https://chatgpt.com');
      expect(mimoIframe.getAttribute('src')).toBeNull();
      expect(mimoLoadingEl.classList.contains('hidden')).toBe(false);
      expect(mimoLoadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');
      expect(mimoLoadingEl.textContent).toContain('Failed to clear previous MiMo session cookies');

      // Path 1: Global New Chat for All must not navigate the blocked MiMo panel
      // (MiMo has inPageNewChat: false), while still messaging unblocked ChatGPT.
      const chatgptPost = vi.fn();
      Object.defineProperty(chatgptIframe, 'contentWindow', {
        configurable: true,
        value: { postMessage: chatgptPost },
      });
      document.getElementById('new-chat-btn').click();
      await flushMicrotasks();

      expect(chatgptPost).toHaveBeenCalledWith(
        {
          type: 'NEW_CHAT',
          providerMode: null,
          context: 'multi-panel',
        },
        'https://chatgpt.com'
      );
      expect(mimoIframe.getAttribute('src')).toBeNull();
      expect(mimoLoadingEl.classList.contains('hidden')).toBe(false);
      expect(mimoLoadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');

      // Path 2: Custom-provider settings-driven reload must preserve the block and not assign src
      currentCustomRecords = [updatedMimoRecord];
      for (const listener of Array.from(storageListeners)) {
        listener(
          {
            [CUSTOM_PROVIDERS_STORAGE_KEY]: {
              oldValue: [initialMimoRecord],
              newValue: [updatedMimoRecord],
            },
          },
          'local'
        );
      }
      await vi.waitFor(() => {
        expect(
          mimoPanelEl.querySelector('.panel-header-left span:not(.panel-origin-badge)').textContent
        ).toBe('MiMo Updated');
      });
      expect(mimoIframe.getAttribute('src')).toBeNull();
      expect(mimoLoadingEl.classList.contains('hidden')).toBe(false);
      expect(mimoLoadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');
      expect(mimoLoadingEl.textContent).toContain(
        'Failed to clear previous MiMo Updated session cookies'
      );

      // Path 3a: Unsuccessful Refresh (sendMessage rejects -> requestEmbeddedFrameCookieSync returns null)
      // MUST preserve the block and never navigate the blocked panel.
      const callsBeforeRejectedRefresh = cookieSyncCallCount;
      cookieSyncBehavior = () => Promise.reject(new Error('Service worker unavailable'));
      mimoPanelEl.querySelector('.refresh-panel-btn').click();
      await vi.waitFor(() => {
        expect(cookieSyncCallCount).toBe(callsBeforeRejectedRefresh + 1);
      });
      await flushMicrotasks();

      expect(mimoIframe.getAttribute('src')).toBeNull();
      expect(mimoLoadingEl.classList.contains('hidden')).toBe(false);
      expect(mimoLoadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');

      // Path 3b: Unsuccessful Refresh with non-ok response (ok: false, no pendingCleanupCount)
      // MUST also preserve the block.
      const callsBeforeFailedOkRefresh = cookieSyncCallCount;
      cookieSyncBehavior = () =>
        Promise.resolve({
          ok: false,
          success: false,
          hasPendingCleanup: false,
          pendingCleanupCount: 0,
          pendingCleanupsByOrigin: {},
          error: 'Transient reconcile failure',
        });
      mimoPanelEl.querySelector('.refresh-panel-btn').click();
      await vi.waitFor(() => {
        expect(cookieSyncCallCount).toBe(callsBeforeFailedOkRefresh + 1);
      });
      await flushMicrotasks();

      expect(mimoIframe.getAttribute('src')).toBeNull();
      expect(mimoLoadingEl.classList.contains('hidden')).toBe(false);
      expect(mimoLoadingEl.dataset.blockedReason).toBe('pending-cookie-cleanup');

      // Path 3c: Affirmative successful Refresh (ok: true, zero pending cleanups)
      // cleanly lifts the block and navigates to the updated MiMo URL.
      const callsBeforeSuccessRefresh = cookieSyncCallCount;
      cookieSyncBehavior = () =>
        Promise.resolve({
          ok: true,
          success: true,
          hasPendingCleanup: false,
          pendingCleanupCount: 0,
          pendingCleanupsByOrigin: {},
        });
      mimoPanelEl.querySelector('.refresh-panel-btn').click();
      await vi.waitFor(() => {
        expect(cookieSyncCallCount).toBe(callsBeforeSuccessRefresh + 1);
        expect(mimoIframe.getAttribute('src')).toBe(updatedMimoRecord.url);
      });
      expect(mimoLoadingEl.dataset.blockedReason).toBeUndefined();

      // Path 3d: Once unblocked, a transient sync rejection on Refresh does not re-block the panel.
      const callsBeforeTransientUnblockedRefresh = cookieSyncCallCount;
      mimoIframe.setAttribute('src', `${mimoOrigin}/chat/thread-1`);
      cookieSyncBehavior = () => Promise.reject(new Error('Transient background error'));
      mimoPanelEl.querySelector('.refresh-panel-btn').click();
      await vi.waitFor(() => {
        expect(cookieSyncCallCount).toBe(callsBeforeTransientUnblockedRefresh + 1);
        expect(mimoIframe.getAttribute('src')).toBe(updatedMimoRecord.url);
      });
      expect(mimoLoadingEl.dataset.blockedReason).toBeUndefined();
    } finally {
      for (const cleanup of cleanupListeners.splice(0)) {
        cleanup();
      }
      storageListeners.clear();
      chrome.storage.onChanged = originalOnChanged;
      globalThis.fetch = originalFetch;
      document.body.innerHTML = '';
    }
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
