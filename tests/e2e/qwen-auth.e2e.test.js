import { test, expect } from '@playwright/test';
import { OPTIONAL_PROVIDER_CONFIGS } from '../../modules/optional-provider-access.js';
import { createPatchedExtensionCopy, launchExtension, openMultiPanel, startFixtureServer } from './extension-harness.js';

test('preserves Qwen login in an embedded panel', async ({}, testInfo) => {
  test.setTimeout(60000);
  const authRequests = [];
  const server = await startFixtureServer((request, response) => {
    if (request.headers.host.startsWith('auth.qwen.ai:')) {
      const authenticated = (request.headers.cookie || '').includes('refresh_token=fixture-session');
      authRequests.push({ authenticated });
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': `http://chat.qwen.ai:${server.port}`,
        'Access-Control-Allow-Credentials': 'true',
      });
      response.end(JSON.stringify({ success: authenticated }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><html><body>
      <p id="auth-state">Checking session</p>
      <script>
        fetch('http://auth.qwen.ai:${server.port}/api/v2/auths/refresh', {
          method: 'POST', credentials: 'include'
        }).then(response => response.json()).then(({ success }) => {
          document.querySelector('#auth-state').textContent = success ? 'Logged in' : 'Log in';
        });
      </script>
    </body></html>`);
  });
  const extensionCopy = await createPatchedExtensionCopy(manifest => {
    const origins = OPTIONAL_PROVIDER_CONFIGS['qwen-global'].origins;
    // Map the permission set to the HTTP fixture and check the cookies received
    // by a real server, after Chromium applies its SameSite exemptions.
    manifest.host_permissions.push(...origins, ...origins.map(origin => origin.replace('https:', 'http:')));
  });
  const extension = await launchExtension({
    extensionPath: extensionCopy.extensionPath,
    args: [
      '--disable-features=HttpsUpgrades',
      '--proxy-bypass-list=*',
      '--host-resolver-rules=MAP chat.qwen.ai 127.0.0.1, MAP auth.qwen.ai 127.0.0.1',
    ],
  });
  try {
    const pageErrors = [];
    extension.context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
    // Qwen's real refresh cookie is HttpOnly and SameSite=Lax. Secure is
    // omitted only because this isolated fixture uses loopback HTTP.
    await extension.context.addCookies([{
      name: 'refresh_token', value: 'fixture-session', domain: '.qwen.ai',
      path: '/', httpOnly: true, sameSite: 'Lax',
    }]);
    await extension.context.route('https://chat.qwen.ai/**', route => route.fulfill({
      status: 302, headers: { Location: `http://chat.qwen.ai:${server.port}/` },
    }));
    const topLevel = await extension.context.newPage();
    await topLevel.goto(`http://chat.qwen.ai:${server.port}/`);
    await expect(topLevel.locator('#auth-state')).toHaveText('Logged in');

    const page = await openMultiPanel(extension, { providers: ['qwen-global'] });
    const panelState = page.frameLocator('iframe').locator('#auth-state');
    await expect(panelState).toHaveText('Logged in');
    expect(authRequests).toEqual([{ authenticated: true }, { authenticated: true }]);

    await page.reload();
    await expect(page.frameLocator('iframe').locator('#auth-state'))
      .toHaveText('Logged in');
    await page.screenshot({ path: testInfo.outputPath('qwen-auth-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.frameLocator('iframe').locator('#auth-state'))
      .toHaveText('Logged in');
    expect(authRequests).toEqual(Array.from({ length: 4 }, () => ({ authenticated: true })));
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('qwen-auth-mobile.png'), fullPage: true });
  } finally {
    await extension.close();
    await server.close();
    await extensionCopy.cleanup();
  }
});
