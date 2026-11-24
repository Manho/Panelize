import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { OPTIONAL_PROVIDER_CONFIGS } from '../../modules/optional-provider-access.js';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
} from './extension-harness.js';

const CHATGLM_HOST = 'chatglm.cn';
const MIMO_HOST = 'aistudio.xiaomimimo.com';
const ATTACKER_HOST = 'attacker.test';
const CUSTOM_MIMO_ID = 'custom-a1b2c3d4e5';
const CUSTOM_MIMO_RULE_ID = 10000;

function createJwt(payload) {
  const encode = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function parseCookies(cookieHeader = '') {
  const map = new Map();
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    map.set(trimmed.slice(0, eqIdx), trimmed.slice(eqIdx + 1));
  }
  return map;
}

async function startAuthTlsFixtureServer() {
  const certDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-auth-tls-'));
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');

  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      `subjectAltName=DNS:${CHATGLM_HOST},DNS:${MIMO_HOST},DNS:${ATTACKER_HOST}`,
    ],
    { stdio: 'ignore' }
  );

  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certPath)]);
  const expectedUserToken = createJwt({ uid: 'zhipu-user-88', is_guest: false });
  const expectedRefreshToken = createJwt({ uid: 'zhipu-user-88', is_guest: false, type: 'refresh' });
  const guestToken = createJwt({ uid: 'zhipu-guest-00', is_guest: true });
  const guestRefreshToken = createJwt({ uid: 'zhipu-guest-00', is_guest: true, type: 'refresh' });

  const observed = {
    chatglmGuestCalls: 0,
    chatglmUserInfoAuths: [],
    mimoHistoryListCalls: [],
  };

  const server = https.createServer({ key, cert }, (req, res) => {
    const hostHeader = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url || '/', `https://${req.headers.host}`);

    if (hostHeader === ATTACKER_HOST) {
      const frameSrc = url.searchParams.get('frame') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <iframe id="embedded" src="${frameSrc}"></iframe>
      </body></html>`);
      return;
    }

    if (hostHeader === CHATGLM_HOST) {
      if (url.pathname === '/chatglm/user-api/guest/access') {
        observed.chatglmGuestCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 0,
            result: { access_token: guestToken, refresh_token: guestRefreshToken },
          })
        );
        return;
      }

      if (url.pathname === '/chatglm/user-api/user/info') {
        const auth = req.headers.authorization || '';
        observed.chatglmUserInfoAuths.push(auth);
        const isUser = auth === `Bearer ${expectedUserToken}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 0,
            result: {
              _id: isUser ? 'zhipu-user-88' : 'zhipu-guest-00',
              nickname: isUser ? 'ZhipuLoggedInUser' : 'Guest',
              is_guest: !isUser,
            },
          })
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'SAMEORIGIN',
      });
      res.end(`<!doctype html><html><body>
        <p id="chatglm-auth-state">Checking</p>
        <textarea id="search-input" placeholder="Ask Zhipu"></textarea>
        <script>
          function readCookie(name) {
            const prefix = name + '=';
            for (const item of (document.cookie || '').split('; ')) {
              if (item.startsWith(prefix)) return item.slice(prefix.length);
            }
            return '';
          }
          if (location.search.includes('doLogin=1')) {
            // Real chatglm.cn writes non-Secure, SameSite-unspecified cookies via js-cookie
            document.cookie = 'chatglm_token=${expectedUserToken}; path=/; max-age=2592000';
            document.cookie = 'chatglm_refresh_token=${expectedRefreshToken}; path=/; max-age=15552000';
          }
          if (location.search.includes('doLogout=1')) {
            document.cookie = 'chatglm_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
            document.cookie = 'chatglm_refresh_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
          }
          (async () => {
            let token = readCookie('chatglm_token');
            const refresh = readCookie('chatglm_refresh_token');
            if (!token || !refresh) {
              const guest = await fetch('/chatglm/user-api/guest/access', { method: 'POST' }).then(r => r.json());
              document.cookie = 'chatglm_token=' + guest.result.access_token + '; path=/; max-age=2592000';
              document.cookie = 'chatglm_refresh_token=' + guest.result.refresh_token + '; path=/; max-age=15552000';
              token = readCookie('chatglm_token');
            }
            if (!token) {
              document.getElementById('chatglm-auth-state').textContent = 'Logged out';
              return;
            }
            const info = await fetch('/chatglm/user-api/user/info', {
              headers: { Authorization: 'Bearer ' + token }
            }).then(r => r.json());
            document.getElementById('chatglm-auth-state').textContent =
              info.result.is_guest ? 'Logged out (Guest)' : ('Logged in: ' + info.result.nickname);
          })();
        </script>
      </body></html>`);
      return;
    }

    if (hostHeader === MIMO_HOST) {
      const cookies = parseCookies(req.headers.cookie || '');

      if (url.pathname === '/sts-login') {
        // Real Xiaomi Passport STS sets HttpOnly serviceToken + non-HttpOnly xiaomichatbot_ph without Secure
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': [
            'serviceToken=mimo-session-secret; Path=/; HttpOnly',
            'xiaomichatbot_ph=mimo-ph-csrf-777; Path=/',
          ],
        });
        res.end('<!doctype html><p id="sts-done">STS Login Complete</p>');
        return;
      }

      if (url.pathname === '/sts-logout') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': [
            'serviceToken=; Path=/; Max-Age=0; HttpOnly',
            'xiaomichatbot_ph=; Path=/; Max-Age=0',
          ],
        });
        res.end('<!doctype html><p id="sts-logout-done">STS Logout Complete</p>');
        return;
      }

      if (url.pathname === '/open-apis/user/mi/get') {
        if (cookies.get('serviceToken') !== 'mimo-session-secret') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { userId: 'mi-10001', userName: 'MiMoUser' } }));
        return;
      }

      if (url.pathname === '/open-apis/chat/conversation/list') {
        const phParam = url.searchParams.get('xiaomichatbot_ph') || '';
        const authenticated =
          cookies.get('serviceToken') === 'mimo-session-secret' &&
          cookies.get('xiaomichatbot_ph') === 'mimo-ph-csrf-777' &&
          phParam === 'mimo-ph-csrf-777';
        observed.mimoHistoryListCalls.push({ authenticated, phParam });
        if (!authenticated) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { dataList: [], pageNum: 1, total: 0 } }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
      });
      res.end(`<!doctype html><html><body>
        <p id="mimo-auth-state">Checking</p>
        <textarea id="mimo-composer" placeholder="Ask MiMo"></textarea>
        <script>
          function readCookie(name) {
            const prefix = encodeURIComponent(name) + '=';
            for (const item of (document.cookie || '').split('; ')) {
              if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
            }
            return '';
          }
          (async () => {
            const userRes = await fetch('/open-apis/user/mi/get', { credentials: 'same-origin' });
            if (!userRes.ok) {
              document.getElementById('mimo-auth-state').textContent = 'Sign in';
              return;
            }
            const userJson = await userRes.json();
            let userInfo = userJson.data;
            // Exact Xiaomi MiMo startup flow: history.fetchList() POSTs with ?xiaomichatbot_ph from document.cookie,
            // and 401 triggers handleAuthExpired() -> clearUserInfo() -> 'Sign in'.
            const ph = readCookie('xiaomichatbot_ph');
            const listUrl = ph
              ? '/open-apis/chat/conversation/list?xiaomichatbot_ph=' + encodeURIComponent(ph)
              : '/open-apis/chat/conversation/list';
            const listRes = await fetch(listUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageInfo: { pageNum: 1, pageSize: 20 } }),
              credentials: 'same-origin'
            });
            if (listRes.status === 401) {
              userInfo = null;
            }
            document.getElementById('mimo-auth-state').textContent =
              userInfo ? ('Logged in: ' + userInfo.userName) : 'Sign in';
          })();
        </script>
      </body></html>`);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    observed,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(certDir, { recursive: true, force: true });
    },
  };
}

test.describe('Zhipu (chatglm.cn) and custom HTTPS web provider (Xiaomi MiMo) login sync E2E', () => {
  test.setTimeout(60_000);

  test('syncs top-level login state into embedded panels, blocks third-party cookie leakage, and reflects top-level logout', async ({}, testInfo) => {
    const server = await startAuthTlsFixtureServer();
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(
        ...OPTIONAL_PROVIDER_CONFIGS.chatglm.origins,
        `https://${MIMO_HOST}/*`,
        `http://${MIMO_HOST}/*`
      );
    });

    const hostRules = [
      `MAP ${CHATGLM_HOST} 127.0.0.1:${server.port}`,
      `MAP ${MIMO_HOST} 127.0.0.1:${server.port}`,
      `MAP ${ATTACKER_HOST} 127.0.0.1:${server.port}`,
    ].join(', ');

    const extension = await launchExtension({
      extensionPath: extensionCopy.extensionPath,
      viewport: { width: 1280, height: 800 },
      args: [
        '--ignore-certificate-errors',
        '--proxy-bypass-list=*',
        `--host-resolver-rules=${hostRules}`,
      ],
    });

    try {
      const pageErrors = [];
      extension.context.on('page', (p) => p.on('pageerror', (err) => pageErrors.push(err.message)));

      // 1. Log in on top-level browser tabs first (exact user reproduction steps)
      const zhipuTab = await extension.context.newPage();
      await zhipuTab.goto(`https://${CHATGLM_HOST}/?doLogin=1`);
      await expect(zhipuTab.locator('#chatglm-auth-state')).toHaveText(
        'Logged in: ZhipuLoggedInUser'
      );
      await zhipuTab.close();

      const mimoTab = await extension.context.newPage();
      await mimoTab.goto(`https://${MIMO_HOST}/sts-login`);
      await expect(mimoTab.locator('#sts-done')).toHaveText('STS Login Complete');
      await mimoTab.goto(`https://${MIMO_HOST}/`);
      await expect(mimoTab.locator('#mimo-auth-state')).toHaveText('Logged in: MiMoUser');
      await mimoTab.close();

      server.observed.chatglmGuestCalls = 0;

      // 2. Register Xiaomi MiMo as a custom web provider and open Multi-Panel with both providers
      await extension.serviceWorker.evaluate(
        async ({ customId, ruleId, mimoUrl }) => {
          await chrome.storage.local.set({
            customProviders: [
              {
                id: customId,
                name: 'Xiaomi MiMo',
                url: mimoUrl,
                frameRuleId: ruleId,
                createdAt: 1700000000000,
              },
            ],
          });
        },
        {
          customId: CUSTOM_MIMO_ID,
          ruleId: CUSTOM_MIMO_RULE_ID,
          mimoUrl: `https://${MIMO_HOST}/`,
        }
      );

      const mpPage = await openMultiPanel(extension, {
        providers: ['chatglm', CUSTOM_MIMO_ID],
        layout: '1x2',
      });

      const panelFrames = mpPage.locator('#panel-grid iframe');
      await expect(panelFrames).toHaveCount(2);

      await expect(panelFrames.nth(0).contentFrame().locator('#chatglm-auth-state')).toHaveText(
        'Logged in: ZhipuLoggedInUser'
      );
      await expect(panelFrames.nth(1).contentFrame().locator('#mimo-auth-state')).toHaveText(
        'Logged in: MiMoUser'
      );
      expect(server.observed.chatglmGuestCalls).toBe(0);
      expect(server.observed.mimoHistoryListCalls.at(-1)).toEqual({
        authenticated: true,
        phParam: 'mimo-ph-csrf-777',
      });

      await mpPage.screenshot({
        path: testInfo.outputPath('chatglm-mimo-auth-desktop.png'),
        fullPage: true,
      });

      // Verify mobile viewport + reload preserves synced sessions
      await mpPage.setViewportSize({ width: 390, height: 844 });
      await mpPage.reload();
      await expect(
        mpPage.locator('#panel-grid iframe').nth(0).contentFrame().locator('#chatglm-auth-state')
      ).toHaveText('Logged in: ZhipuLoggedInUser');
      await expect(
        mpPage.locator('#panel-grid iframe').nth(1).contentFrame().locator('#mimo-auth-state')
      ).toHaveText('Logged in: MiMoUser');
      await mpPage.screenshot({
        path: testInfo.outputPath('chatglm-mimo-auth-mobile.png'),
        fullPage: true,
      });

      // 3. Third-party page framing multi-panel.html must NEVER expose CHIPS session cookies
      const framedMultiPanel = await extension.context.newPage();
      await framedMultiPanel.goto(
        `https://${ATTACKER_HOST}/?frame=${encodeURIComponent(
          extension.extensionUrl('multi-panel/multi-panel.html')
        )}`
      );
      const nestedPanels = framedMultiPanel
        .frameLocator('#embedded')
        .locator('#panel-grid iframe');
      await expect(nestedPanels).toHaveCount(2);
      // Without extension as top-level site, scoped frame rules do not strip XFO or expose CHIPS cookies
      const attackerGlmText = await nestedPanels
        .nth(0)
        .contentFrame()
        .locator('#chatglm-auth-state')
        .textContent({ timeout: 2000 })
        .catch(() => null);
      expect(attackerGlmText).not.toBe('Logged in: ZhipuLoggedInUser');
      await framedMultiPanel.close();

      // 4. Top-level logout clears mirrored CHIPS cookies so panel refresh shows logged-out state
      const logoutZhipu = await extension.context.newPage();
      await logoutZhipu.goto(`https://${CHATGLM_HOST}/?doLogout=1`);
      await expect(logoutZhipu.locator('#chatglm-auth-state')).toHaveText('Logged out (Guest)');
      await logoutZhipu.close();

      const logoutMimo = await extension.context.newPage();
      await logoutMimo.goto(`https://${MIMO_HOST}/sts-logout`);
      await expect(logoutMimo.locator('#sts-logout-done')).toHaveText('STS Logout Complete');
      await logoutMimo.close();

      await mpPage.setViewportSize({ width: 1280, height: 800 });
      await mpPage.reload();
      await expect(
        mpPage.locator('#panel-grid iframe').nth(0).contentFrame().locator('#chatglm-auth-state')
      ).toHaveText('Logged out (Guest)');
      await expect(
        mpPage.locator('#panel-grid iframe').nth(1).contentFrame().locator('#mimo-auth-state')
      ).toHaveText('Sign in');

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
      await extensionCopy.cleanup();
      await server.close();
    }
  });
});
