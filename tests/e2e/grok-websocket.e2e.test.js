import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
} from './extension-harness.js';
import { PROVIDERS } from '../../modules/providers.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const GROK_WEBSOCKET_COOKIE_RULE_ID = 2001;

function buildWebSocketTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function renderGrokPage() {
  return `<!doctype html><html><body>
    <p id="ws-state">Connecting</p>
    <script>
      const params = new URLSearchParams(location.search);
      const tag = params.get('tag') || 'default';
      // Real Grok opens its WebSocket only after loading its app bundle.
      setTimeout(() => {
      const ws = new WebSocket('ws://grok.com:' + location.port + '/ws/mgw/?tag=' + tag);
      ws.addEventListener('message', (event) => {
        document.querySelector('#ws-state').textContent = event.data;
      });
      ws.addEventListener('error', () => {
        document.querySelector('#ws-state').textContent = 'Unable to start conversation';
      });
      }, Number(params.get('delay') || 0));
    </script>
  </body></html>`;
}

function renderThirdPartyPage(frameUrl) {
  return `<!doctype html><html><body>
    <iframe id="embedded" src="${frameUrl}"></iframe>
  </body></html>`;
}

function startGrokWebSocketFixtureServer() {
  const wsHandshakes = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    response.writeHead(200, { 'Content-Type': 'text/html' });
    if (url.hostname === 'attacker.test') {
      response.end(renderThirdPartyPage(url.searchParams.get('frame')));
      return;
    }
    response.end(renderGrokPage());
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const tag = new URL(request.url, 'http://grok.com').searchParams.get('tag');
    const cookieHeader = request.headers.cookie || '';
    const ssoMatches = cookieHeader.match(/(?:^|;\s*)sso=([^;]+)/g) || [];
    const ssoRwMatches = cookieHeader.match(/(?:^|;\s*)sso-rw=([^;]+)/g) || [];
    const deviceMatches = cookieHeader.match(/(?:^|;\s*)grok_device_id=([^;]+)/g) || [];
    const ssoValue = cookieHeader.match(/(?:^|;\s*)sso=([^;]+)/)?.[1] || null;
    const authenticated = Boolean(
      ssoValue &&
      ssoMatches.length === 1 &&
      ssoRwMatches.length === 1 &&
      deviceMatches.length === 1
    );

    wsHandshakes.push({
      tag,
      authenticated,
      ssoValue,
      ssoCount: ssoMatches.length,
      ssoRwCount: ssoRwMatches.length,
    });

    if (!authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const acceptKey = createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}${WEBSOCKET_GUID}`)
      .digest('base64');

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ].join('\r\n'));
    socket.write(buildWebSocketTextFrame(`OK:${ssoValue}`));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        wsHandshakes,
        close: () => new Promise((closeResolve, closeReject) => {
          for (const socket of sockets) {
            socket.destroy();
          }
          server.close((error) => (error ? closeReject(error) : closeResolve()));
        }),
      });
    });
  });
}

// Grok's real session and device cookies use SameSite=Lax and SameSite=Strict
// with HttpOnly, which Chromium strips on cross-site WebSocket handshakes.
function grokSessionCookies(ssoValue) {
  return [
    {
      name: 'grok_device_id',
      value: 'fixture-device',
      domain: '.grok.com',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'sso',
      value: ssoValue,
      domain: '.grok.com',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
    {
      name: 'sso-rw',
      value: 'fixture-session-rw',
      domain: '.grok.com',
      path: '/',
      httpOnly: true,
      sameSite: 'Strict',
    },
  ];
}

async function launchGrokFixture({ grantOptionalProviders = false } = {}) {
  const server = await startGrokWebSocketFixtureServer();
  const extensionCopy = await createPatchedExtensionCopy((manifest) => {
    if (grantOptionalProviders) {
      // Optional providers need a user gesture to grant; grant them up front.
      manifest.host_permissions.push(...manifest.optional_host_permissions);
    }
    // Map the wss:// permission to ws:// for the loopback fixture server.
    manifest.host_permissions.push('ws://grok.com/*');
    // Run the Grok content scripts on the plain-http fixture as well.
    for (const contentScript of manifest.content_scripts) {
      if (contentScript.matches.includes('https://grok.com/*')) {
        contentScript.matches.push('http://grok.com/*');
      }
    }
  });
  const extension = await launchExtension({
    extensionPath: extensionCopy.extensionPath,
    args: [
      '--disable-features=HttpsUpgrades',
      '--proxy-bypass-list=*',
      '--host-resolver-rules=MAP grok.com 127.0.0.1, MAP attacker.test 127.0.0.1',
    ],
  });

  const pageErrors = [];
  extension.context.on('page', (page) => {
    page.on('pageerror', (error) => pageErrors.push(error.message));
  });

  await extension.context.addCookies(grokSessionCookies('fixture-session-1'));
  // Other provider sites are irrelevant here; serve blank pages instead of the network.
  await extension.context.route((url) => url.protocol === 'https:' && url.hostname !== 'grok.com', (route) => (
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>provider</title>' })
  ));
  await extension.context.route('https://grok.com/**', (route) => {
    const target = new URL(route.request().url());
    return route.fulfill({
      status: 302,
      headers: { Location: `http://grok.com:${server.port}${target.pathname}${target.search}` },
    });
  });

  return {
    server,
    extension,
    pageErrors,
    grokUrl: (tag, delay = 0) => `http://grok.com:${server.port}/?tag=${tag}&delay=${delay}`,
    // Simulates Chrome < 145, which has no RuleCondition.topDomains.
    async disableTopDomains() {
      await extension.serviceWorker.evaluate(() => {
        Object.defineProperty(chrome.declarativeNetRequest, 'RuleConditionKeys', {
          configurable: true,
          value: undefined,
        });
      });
    },
    async getRule() {
      return extension.serviceWorker.evaluate(async (ruleId) => {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        return rules.find(({ id }) => id === ruleId) ?? null;
      }, GROK_WEBSOCKET_COOKIE_RULE_ID);
    },
    thirdPartyUrl: (frameUrl) => (
      `http://attacker.test:${server.port}/?frame=${encodeURIComponent(frameUrl)}`
    ),
    async getRuleTabIds() {
      return extension.serviceWorker.evaluate(async (ruleId) => {
        const rules = await chrome.declarativeNetRequest.getSessionRules();
        return rules.find(({ id }) => id === ruleId)?.condition?.tabIds ?? null;
      }, GROK_WEBSOCKET_COOKIE_RULE_ID);
    },
    async getTabId(page) {
      const url = page.url();
      return extension.serviceWorker.evaluate(async (pageUrl) => {
        const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
        const match = contexts.find((context) => context.frameId === 0 && context.documentUrl === pageUrl);
        return match?.tabId ?? null;
      }, url);
    },
    async close() {
      await extension.close();
      await server.close();
      await extensionCopy.cleanup();
    },
  };
}

test('connects Grok WebSockets in an embedded panel with SameSite session cookies', async () => {
  test.setTimeout(60000);
  const fixture = await launchGrokFixture();
  const { extension, server } = fixture;

  try {
    // Top-level Grok works natively and must not receive duplicate cookies.
    const topLevel = await extension.context.newPage();
    await topLevel.goto(fixture.grokUrl('top'));
    await expect(topLevel.locator('#ws-state')).toHaveText('OK:fixture-session-1');

    // Embedded Grok panel inside Panelize must also establish its WebSocket.
    const page = await openMultiPanel(extension, { providers: ['grok'] });
    const panelState = page.frameLocator('iframe').locator('#ws-state');
    await expect(panelState).toHaveText('OK:fixture-session-1');

    // Rotate the session cookie and verify the updated cookie is used on reload.
    await extension.context.addCookies(grokSessionCookies('fixture-session-2'));

    await page.reload();
    await expect(page.frameLocator('iframe').locator('#ws-state'))
      .toHaveText('OK:fixture-session-2');

    // Re-check top-level tab while the Multi-Panel session rule is active.
    await topLevel.reload();
    await expect(topLevel.locator('#ws-state')).toHaveText('OK:fixture-session-2');

    expect(server.wsHandshakes.map(({ authenticated, ssoValue, ssoCount, ssoRwCount }) => ({
      authenticated, ssoValue, ssoCount, ssoRwCount,
    }))).toEqual([
      { authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-2', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-2', ssoCount: 1, ssoRwCount: 1 },
    ]);
    expect(await fixture.getRuleTabIds()).toEqual([await fixture.getTabId(page)]);
    expect(fixture.pageErrors).toEqual([]);
  } finally {
    await fixture.close();
  }
});

for (const legacy of [false, true]) {
  const variant = legacy ? ' (without topDomains)' : '';

  test(`never forwards Grok session cookies to Grok frames embedded by third-party pages${variant}`, async () => {
    test.setTimeout(60000);
    const fixture = await launchGrokFixture();
    const { extension, server } = fixture;

    try {
      if (legacy) {
        await fixture.disableTopDomains();
      }
      const multiPanel = await openMultiPanel(extension, { providers: ['grok'] });
      await expect(multiPanel.frameLocator('iframe').locator('#ws-state'))
        .toHaveText('OK:fixture-session-1');
      const multiPanelTabId = await fixture.getTabId(multiPanel);
      expect((await fixture.getRule()).condition.topDomains)
        .toEqual(legacy ? undefined : [extension.extensionId]);

      // A third-party page frames grok.com directly.
      const thirdParty = await extension.context.newPage();
      await thirdParty.goto(fixture.thirdPartyUrl(fixture.grokUrl('third-party')));
      await expect(thirdParty.frameLocator('#embedded').locator('#ws-state'))
        .toHaveText('Unable to start conversation');

      // A third-party page frames the web-accessible Multi-Panel page, which in
      // turn frames Grok.
      const framedMultiPanel = await extension.context.newPage();
      await framedMultiPanel.goto(fixture.thirdPartyUrl(
        extension.extensionUrl('multi-panel/multi-panel.html')
      ));
      await expect(framedMultiPanel.frameLocator('#embedded').locator('#panel-grid iframe'))
        .toHaveCount(1);
      await expect(framedMultiPanel.frameLocator('#embedded').frameLocator('#panel-grid iframe')
        .locator('#ws-state')).toHaveText('Unable to start conversation');

      expect(await fixture.getRuleTabIds()).toEqual([multiPanelTabId]);
      expect(server.wsHandshakes.filter(({ tag }) => tag === 'third-party'))
        .toEqual([{ tag: 'third-party', authenticated: false, ssoValue: null, ssoCount: 0, ssoRwCount: 0 }]);
      // Panel frames load https://grok.com/ without a tag: first the real
      // Multi-Panel tab, then the one framed by the third-party page.
      expect(server.wsHandshakes.filter(({ tag }) => tag === 'default')).toEqual([
        { tag: 'default', authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 },
        { tag: 'default', authenticated: false, ssoValue: null, ssoCount: 0, ssoRwCount: 0 },
      ]);
    } finally {
      await fixture.close();
    }
  });

  test(`stops forwarding Grok cookies once a Multi-Panel tab navigates to grok.com${variant}`, async () => {
    test.setTimeout(60000);
    const fixture = await launchGrokFixture();
    const { extension, server } = fixture;

    try {
      if (legacy) {
        await fixture.disableTopDomains();
      }
      const page = await openMultiPanel(extension, { providers: ['grok'] });
      await expect(page.frameLocator('iframe').locator('#ws-state'))
        .toHaveText('OK:fixture-session-1');
      expect(await fixture.getRuleTabIds()).toHaveLength(1);

      // The same tab now shows Grok top-level, where Chromium already sends
      // SameSite cookies natively; appending them again would duplicate them.
      // With topDomains the rule never matches there, even if the WebSocket
      // opens immediately. Without it the tab is dropped from the rule when
      // the navigation starts, ahead of Grok loading its app bundle.
      await page.goto(fixture.grokUrl('navigated', legacy ? 300 : 0));
      await expect(page.locator('#ws-state')).toHaveText('OK:fixture-session-1');

      expect(server.wsHandshakes.filter(({ tag }) => tag === 'navigated'))
        .toEqual([{ tag: 'navigated', authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 }]);
      await expect.poll(() => fixture.getRuleTabIds()).toBeNull();
    } finally {
      await fixture.close();
    }
  });
}

test('adding Grok twice at once never exceeds the panel limit', async () => {
  test.setTimeout(90000);
  const fixture = await launchGrokFixture({ grantOptionalProviders: true });
  const { extension } = fixture;
  const MAX_PANELS = 12;
  const otherProviderIds = PROVIDERS.map(({ id }) => id).filter((id) => id !== 'grok').slice(0, MAX_PANELS - 1);
  expect(otherProviderIds).toHaveLength(MAX_PANELS - 1);

  try {
    // Multi-Panel opens min(enabled providers, layout capacity) panels, so
    // start with exactly 11 enabled and enable Grok only for the add menu.
    const page = await openMultiPanel(extension, {
      providers: otherProviderIds,
      layout: '1x12',
    });
    await extension.serviceWorker.evaluate(async (enabledProviders) => {
      await chrome.storage.sync.set({ enabledProviders, providerOrder: enabledProviders });
    }, [...otherProviderIds, 'grok']);

    await page.click('#add-panel-btn');
    const grokItem = page.locator('.add-panel-item[data-provider-id="grok"]');
    await expect(grokItem).toHaveCount(1);
    // Both clicks start addPanel() before either Grok cookie sync resolves.
    await grokItem.evaluate((item) => {
      item.click();
      item.click();
    });

    await expect(page.locator('#panel-grid iframe')).toHaveCount(MAX_PANELS);
    await expect.poll(() => extension.serviceWorker.evaluate(async () => (
      (await chrome.storage.sync.get('multiPanelProviders')).multiPanelProviders.length
    ))).toBe(MAX_PANELS);
    await page.waitForTimeout(500);
    await expect(page.locator('#panel-grid iframe')).toHaveCount(MAX_PANELS);
  } finally {
    await fixture.close();
  }
});
