import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GROK_COOKIE_URL,
  GROK_WEBSOCKET_COOKIE_RULE_ID,
  clearRegisteredMultiPanelTabIds,
  createGrokWebSocketCookieRule,
  formatGrokWebSocketCookieHeader,
  getMultiPanelTabIds,
  isGrokCookieDomain,
  reconcileGrokWebSocketCookies,
  registerMultiPanelTabId,
  syncGrokWebSocketCookies,
  unregisterMultiPanelTabId,
  upgradeGrokConsentCookies,
} from '../modules/grok-websocket-cookies.js';

const manifest = JSON.parse(
  readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8')
);
const grokCookieConsentScript = readFileSync(
  resolve(process.cwd(), 'content-scripts/grok-cookie-consent.js'),
  'utf8'
);

describe('Grok WebSocket cookie synchronization', () => {
  beforeEach(() => {
    clearRegisteredMultiPanelTabIds();
    chrome.runtime.getURL = vi.fn((path) => `chrome-extension://test-ext-id/${path}`);
    chrome.runtime.getContexts = vi.fn(() => Promise.resolve([]));
    chrome.tabs.getCurrent = vi.fn(() => Promise.resolve(null));
    chrome.cookies = {
      getAll: vi.fn(() => Promise.resolve([])),
      set: vi.fn(() => Promise.resolve({})),
    };
    chrome.declarativeNetRequest = {
      getSessionRules: vi.fn(() => Promise.resolve([])),
      updateSessionRules: vi.fn(() => Promise.resolve()),
    };
    chrome.storage.sync.get.mockImplementation((defaults) => Promise.resolve(defaults));
  });

  it('declares cookies and wss://grok.com/* permissions in manifest.json', () => {
    expect(manifest.permissions).toContain('cookies');
    expect(manifest.host_permissions).toEqual(expect.arrayContaining([
      '*://grok.com/*',
      'wss://grok.com/*',
    ]));
    expect(manifest.content_scripts).toContainEqual({
      matches: ['https://grok.com/*'],
      js: ['content-scripts/grok-cookie-consent.js'],
      run_at: 'document_start',
      all_frames: true,
      world: 'MAIN',
    });
  });

  it('matches Grok cookie domains and rejects unrelated domains', () => {
    expect(isGrokCookieDomain('grok.com')).toBe(true);
    expect(isGrokCookieDomain('.grok.com')).toBe(true);
    expect(isGrokCookieDomain('assets.grok.com')).toBe(true);
    expect(isGrokCookieDomain('chatgpt.com')).toBe(false);
    expect(isGrokCookieDomain('notgrok.com')).toBe(false);
    expect(isGrokCookieDomain('')).toBe(false);
    expect(isGrokCookieDomain(null)).toBe(false);
  });

  it('formats SameSite=Lax, Strict, and unspecified cookies while omitting SameSite=None and partitioned cookies', () => {
    const header = formatGrokWebSocketCookieHeader([
      { name: 'grok_device_id', value: 'device-1', sameSite: 'lax' },
      { name: 'sso', value: 'sso-token', sameSite: 'lax', httpOnly: true },
      { name: 'sso-rw', value: 'sso-rw-token', sameSite: 'strict', httpOnly: true },
      { name: '__cuid', value: 'cuid-1', sameSite: 'unspecified' },
      { name: '__cf_bm', value: 'cf-bm', sameSite: 'no_restriction' },
      {
        name: 'cf_clearance',
        value: 'cf-clearance',
        sameSite: 'no_restriction',
        partitionKey: { topLevelSite: 'chrome-extension://test-ext-id' },
      },
    ]);

    expect(header).toBe(
      'grok_device_id=device-1; sso=sso-token; sso-rw=sso-rw-token; __cuid=cuid-1'
    );
  });

  it('creates a session rule scoped to Grok WebSockets in Multi-Panel tabs', () => {
    expect(createGrokWebSocketCookieRule('sso=token-1; sso-rw=token-2', [42, 7, 42])).toEqual({
      id: GROK_WEBSOCKET_COOKIE_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          {
            header: 'Cookie',
            operation: 'append',
            value: 'sso=token-1; sso-rw=token-2',
          },
        ],
      },
      condition: {
        requestDomains: ['grok.com'],
        initiatorDomains: ['grok.com'],
        resourceTypes: ['websocket'],
        tabIds: [7, 42],
      },
    });
  });

  it('discovers Multi-Panel tab IDs from extension contexts and current tab', async () => {
    chrome.tabs.getCurrent.mockResolvedValue({ id: 15 });
    chrome.runtime.getContexts.mockResolvedValue([
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://test-ext-id/multi-panel/multi-panel.html',
        tabId: 8,
      },
      {
        contextType: 'TAB',
        documentUrl: 'chrome-extension://test-ext-id/options/options.html',
        tabId: 99,
      },
    ]);

    await expect(getMultiPanelTabIds()).resolves.toEqual([8, 15]);
  });

  it('installs and updates the Grok WebSocket session rule when Grok is enabled', async () => {
    registerMultiPanelTabId(12);
    chrome.cookies.getAll.mockResolvedValue([
      { name: 'sso', value: 'session-a', sameSite: 'lax', httpOnly: true },
      { name: 'sso-rw', value: 'session-rw-a', sameSite: 'strict', httpOnly: true },
    ]);

    await reconcileGrokWebSocketCookies();

    expect(chrome.cookies.getAll).toHaveBeenCalledWith({ url: GROK_COOKIE_URL });
    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [],
      addRules: [
        createGrokWebSocketCookieRule('sso=session-a; sso-rw=session-rw-a', [12]),
      ],
    });
  });

  it('skips redundant session rule updates when the installed rule already matches', async () => {
    const rule = createGrokWebSocketCookieRule('sso=session-a', [12]);
    chrome.declarativeNetRequest.getSessionRules.mockResolvedValue([rule]);

    await syncGrokWebSocketCookies({
      enabledProviderIds: ['grok'],
      tabIds: [12],
      cookies: [{ name: 'sso', value: 'session-a', sameSite: 'lax' }],
    });

    expect(chrome.declarativeNetRequest.updateSessionRules).not.toHaveBeenCalled();
  });

  it('removes the session rule when Grok is disabled or Multi-Panel tabs close', async () => {
    const existingRule = createGrokWebSocketCookieRule('sso=session-a', [12]);
    registerMultiPanelTabId(12);
    chrome.declarativeNetRequest.getSessionRules.mockResolvedValue([existingRule]);
    chrome.storage.sync.get.mockResolvedValue({ enabledProviders: ['chatgpt'] });

    await reconcileGrokWebSocketCookies();

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [GROK_WEBSOCKET_COOKIE_RULE_ID],
      addRules: [],
    });

    chrome.declarativeNetRequest.updateSessionRules.mockClear();
    chrome.storage.sync.get.mockResolvedValue({ enabledProviders: ['grok'] });
    unregisterMultiPanelTabId(12);

    await reconcileGrokWebSocketCookies();

    expect(chrome.declarativeNetRequest.updateSessionRules).toHaveBeenCalledWith({
      removeRuleIds: [GROK_WEBSOCKET_COOKIE_RULE_ID],
      addRules: [],
    });
  });

  it('upgrades existing OneTrust consent cookies to SameSite=None; Secure for embedded frames', async () => {
    const cookies = [
      {
        name: 'OptanonAlertBoxClosed',
        value: '2026-10-16T12:00:00.000Z',
        domain: '.grok.com',
        path: '/',
        secure: false,
        httpOnly: false,
        sameSite: 'lax',
        expirationDate: 1821756479,
        storeId: '0',
      },
      {
        name: 'sso',
        value: 'session-token',
        domain: '.grok.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
      },
    ];

    const upgraded = await upgradeGrokConsentCookies(cookies);

    expect(chrome.cookies.set).toHaveBeenCalledTimes(1);
    expect(chrome.cookies.set).toHaveBeenCalledWith({
      url: GROK_COOKIE_URL,
      name: 'OptanonAlertBoxClosed',
      value: '2026-10-16T12:00:00.000Z',
      domain: '.grok.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
      expirationDate: 1821756479,
      storeId: '0',
    });
    expect(upgraded[0]).toMatchObject({
      name: 'OptanonAlertBoxClosed',
      secure: true,
      sameSite: 'no_restriction',
    });
    expect(upgraded[1]).toMatchObject({
      name: 'sso',
      sameSite: 'lax',
    });
  });

  it('rewrites Optanon consent cookies written via document.cookie in embedded Grok frames', () => {
    const writtenValues = [];
    const fakeDocumentProto = {};
    Object.defineProperty(fakeDocumentProto, 'cookie', {
      configurable: true,
      enumerable: true,
      get() {
        return writtenValues.join('; ');
      },
      set(value) {
        writtenValues.push(value);
      },
    });
    const fakeDoc = Object.create(fakeDocumentProto);
    const fakeWindow = {
      self: {},
      top: {},
      location: { protocol: 'https:' },
      Document: { prototype: fakeDocumentProto },
      HTMLDocument: { prototype: fakeDocumentProto },
    };

    new Function(
      'window',
      'document',
      'location',
      'Document',
      'HTMLDocument',
      grokCookieConsentScript
    )(
      fakeWindow,
      fakeDoc,
      fakeWindow.location,
      fakeWindow.Document,
      fakeWindow.HTMLDocument
    );

    fakeDoc.cookie = 'OptanonAlertBoxClosed=2026-10-16T13:00:00.000Z; path=/; domain=.grok.com; Samesite=Lax';
    fakeDoc.cookie = 'other_cookie=1; path=/; SameSite=Lax';

    expect(writtenValues).toEqual([
      'OptanonAlertBoxClosed=2026-10-16T13:00:00.000Z; path=/; domain=.grok.com; SameSite=None; Secure',
      'other_cookie=1; path=/; SameSite=Lax',
    ]);
  });
});
