import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import http from 'node:http';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
} from './extension-harness.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildWebSocketTextFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function startGrokWebSocketFixtureServer() {
  const wsHandshakes = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><body>
      <p id="ws-state">Connecting</p>
      <script>
        const port = location.port;
        const ws = new WebSocket('ws://grok.com:' + port + '/ws/mgw/?uid=fixture-user');
        ws.addEventListener('message', (event) => {
          document.querySelector('#ws-state').textContent = event.data;
        });
        ws.addEventListener('error', () => {
          document.querySelector('#ws-state').textContent = 'Unable to start conversation';
        });
      </script>
    </body></html>`);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (request, socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const cookieHeader = request.headers.cookie || '';
    const ssoMatches = cookieHeader.match(/(?:^|;\s*)sso=([^;]+)/g) || [];
    const ssoRwMatches = cookieHeader.match(/(?:^|;\s*)sso-rw=([^;]+)/g) || [];
    const deviceMatches = cookieHeader.match(/(?:^|;\s*)grok_device_id=([^;]+)/g) || [];
    const ssoValue = cookieHeader.match(/(?:^|;\s*)sso=([^;]+)/)?.[1] || null;
    const authenticated = Boolean(
      ssoValue &&
      ssoRwMatches.length === 1 &&
      deviceMatches.length === 1
    );

    wsHandshakes.push({
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

test('connects Grok WebSockets in an embedded panel with SameSite session cookies', async () => {
  test.setTimeout(60000);
  const server = await startGrokWebSocketFixtureServer();
  const extensionCopy = await createPatchedExtensionCopy((manifest) => {
    // Map the wss:// permission to ws:// for the loopback fixture server.
    manifest.host_permissions.push('ws://grok.com/*');
  });
  const extension = await launchExtension({
    extensionPath: extensionCopy.extensionPath,
    args: [
      '--disable-features=HttpsUpgrades',
      '--proxy-bypass-list=*',
      '--host-resolver-rules=MAP grok.com 127.0.0.1',
    ],
  });

  try {
    const pageErrors = [];
    extension.context.on('page', (page) => {
      page.on('pageerror', (error) => pageErrors.push(error.message));
    });

    // Grok's real session and device cookies use SameSite=Lax and SameSite=Strict
    // with HttpOnly, which Chromium strips on cross-site WebSocket handshakes.
    await extension.context.addCookies([
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
        value: 'fixture-session-1',
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
    ]);

    await extension.context.route('https://grok.com/**', (route) => route.fulfill({
      status: 302,
      headers: { Location: `http://grok.com:${server.port}/` },
    }));

    // Top-level Grok works natively and must not receive duplicate cookies.
    const topLevel = await extension.context.newPage();
    await topLevel.goto(`http://grok.com:${server.port}/`);
    await expect(topLevel.locator('#ws-state')).toHaveText('OK:fixture-session-1');

    // Embedded Grok panel inside Panelize must also establish its WebSocket.
    const page = await openMultiPanel(extension, { providers: ['grok'] });
    const panelState = page.frameLocator('iframe').locator('#ws-state');
    await expect(panelState).toHaveText('OK:fixture-session-1');

    // Rotate the session cookie and verify the updated cookie is used on reload.
    await extension.context.addCookies([
      {
        name: 'sso',
        value: 'fixture-session-2',
        domain: '.grok.com',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);

    await page.reload();
    await expect(page.frameLocator('iframe').locator('#ws-state'))
      .toHaveText('OK:fixture-session-2');

    // Re-check top-level tab while the Multi-Panel session rule is active.
    await topLevel.reload();
    await expect(topLevel.locator('#ws-state')).toHaveText('OK:fixture-session-2');

    expect(server.wsHandshakes).toEqual([
      { authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-1', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-2', ssoCount: 1, ssoRwCount: 1 },
      { authenticated: true, ssoValue: 'fixture-session-2', ssoCount: 1, ssoRwCount: 1 },
    ]);
    expect(pageErrors).toEqual([]);
  } finally {
    await extension.close();
    await server.close();
    await extensionCopy.cleanup();
  }
});
