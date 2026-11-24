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
const MIMO_PARENT_DOMAIN = 'xiaomimimo.com';
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

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
    chatglmPageRequests: 0,
    chatglmGuestCalls: 0,
    chatglmUserInfoAuths: [],
    chatglmProbeCookieHeaders: [],
    mimoPageRequests: 0,
    mimoUserGetCalls: [],
    mimoHistoryListCalls: [],
    mimoProbeCookieHeaders: [],
  };

  const server = https.createServer({ key, cert }, (req, res) => {
    const hostHeader = (req.headers.host || '').split(':')[0];
    const url = new URL(req.url || '/', `https://${req.headers.host}`);

    if (hostHeader === ATTACKER_HOST) {
      if (url.pathname === '/probe-host') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <iframe id="probe-chatglm" src="https://${CHATGLM_HOST}/probe-cookies"></iframe>
          <iframe id="probe-mimo" src="https://${MIMO_HOST}/probe-cookies"></iframe>
        </body></html>`);
        return;
      }

      const frameSrc = url.searchParams.get('frame') || '';
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
        <iframe id="embedded" src="${escapeHtml(frameSrc)}"></iframe>
      </body></html>`);
      return;
    }

    if (hostHeader === CHATGLM_HOST) {
      if (url.pathname === '/probe-cookies') {
        const cookieHeader = req.headers.cookie || '';
        observed.chatglmProbeCookieHeaders.push(cookieHeader);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <p id="probe-header">${escapeHtml(cookieHeader || 'NONE')}</p>
          <p id="probe-doc-cookie">PENDING</p>
          <script>
            document.getElementById('probe-doc-cookie').textContent = document.cookie || 'EMPTY';
          </script>
        </body></html>`);
        return;
      }

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

      observed.chatglmPageRequests += 1;
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

      if (url.pathname === '/probe-cookies') {
        const cookieHeader = req.headers.cookie || '';
        observed.mimoProbeCookieHeaders.push(cookieHeader);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><body>
          <p id="probe-header">${escapeHtml(cookieHeader || 'NONE')}</p>
          <p id="probe-doc-cookie">PENDING</p>
          <script>
            document.getElementById('probe-doc-cookie').textContent = document.cookie || 'EMPTY';
          </script>
        </body></html>`);
        return;
      }

      if (url.pathname === '/sts-login') {
        // Real production Xiaomi MiMo sets all three auth cookies on parent domain .xiaomimimo.com
        // without Secure or SameSite, plus we set a host-only non-Secure cookie to verify both scopes.
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': [
            `xiaomichatbot_serviceToken=mimo-session-secret; Domain=.${MIMO_PARENT_DOMAIN}; Path=/; HttpOnly`,
            `xiaomichatbot_ph=mimo-ph-csrf-777; Domain=.${MIMO_PARENT_DOMAIN}; Path=/`,
            `userId=mi-10001; Domain=.${MIMO_PARENT_DOMAIN}; Path=/`,
            'mimo_host_pref=studio-dark; Path=/',
          ],
        });
        res.end('<!doctype html><p id="sts-done">STS Login Complete</p>');
        return;
      }

      if (url.pathname === '/sts-logout') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Set-Cookie': [
            `xiaomichatbot_serviceToken=; Domain=.${MIMO_PARENT_DOMAIN}; Path=/; Max-Age=0; HttpOnly`,
            `xiaomichatbot_ph=; Domain=.${MIMO_PARENT_DOMAIN}; Path=/; Max-Age=0`,
            `userId=; Domain=.${MIMO_PARENT_DOMAIN}; Path=/; Max-Age=0`,
            'mimo_host_pref=; Path=/; Max-Age=0',
          ],
        });
        res.end('<!doctype html><p id="sts-logout-done">STS Logout Complete</p>');
        return;
      }

      if (url.pathname === '/open-apis/user/mi/get') {
        const hasServiceToken = cookies.get('xiaomichatbot_serviceToken') === 'mimo-session-secret';
        observed.mimoUserGetCalls.push({ hasServiceToken });
        if (!hasServiceToken) {
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
          cookies.get('xiaomichatbot_serviceToken') === 'mimo-session-secret' &&
          cookies.get('xiaomichatbot_ph') === 'mimo-ph-csrf-777' &&
          cookies.get('userId') === 'mi-10001' &&
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

      observed.mimoPageRequests += 1;
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
            // requires parent-domain userId + xiaomichatbot_ph cookies, and 401 triggers handleAuthExpired() -> 'Sign in'.
            const ph = readCookie('xiaomichatbot_ph');
            const cookieUserId = readCookie('userId');
            const listUrl = ph
              ? '/open-apis/chat/conversation/list?xiaomichatbot_ph=' + encodeURIComponent(ph)
              : '/open-apis/chat/conversation/list';
            const listRes = await fetch(listUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ pageInfo: { pageNum: 1, pageSize: 20 } }),
              credentials: 'same-origin'
            });
            if (listRes.status === 401 || cookieUserId !== userInfo.userId) {
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

  test('syncs top-level login state into embedded panels, enforces frame-block and CHIPS isolation for both Zhipu and MiMo on third-party origins, and reflects top-level logout', async ({}, testInfo) => {
    const server = await startAuthTlsFixtureServer();
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(
        ...OPTIONAL_PROVIDER_CONFIGS.chatglm.origins,
        `http://${CHATGLM_HOST}/*`,
        `https://${MIMO_HOST}/*`,
        `https://*.${MIMO_PARENT_DOMAIN}/*`,
        `http://*.${MIMO_PARENT_DOMAIN}/*`
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

      // 3A. Third-party page framing multi-panel.html: scoped DNR rules must NOT strip XFO,
      //     so Chromium explicitly blocks BOTH Zhipu and MiMo subframes with zero API calls.
      const beforeAttacker = {
        chatglmPageRequests: server.observed.chatglmPageRequests,
        mimoPageRequests: server.observed.mimoPageRequests,
        chatglmUserInfoCount: server.observed.chatglmUserInfoAuths.length,
        mimoUserGetCount: server.observed.mimoUserGetCalls.length,
        mimoHistoryListCount: server.observed.mimoHistoryListCalls.length,
      };
      const blockedFrameFailures = [];
      const framedMultiPanel = await extension.context.newPage();
      framedMultiPanel.on('requestfailed', (request) => {
        blockedFrameFailures.push({
          url: request.url(),
          errorText: request.failure()?.errorText || '',
        });
      });

      await framedMultiPanel.goto(
        `https://${ATTACKER_HOST}/?frame=${encodeURIComponent(
          extension.extensionUrl('multi-panel/multi-panel.html')
        )}`
      );
      const nestedPanels = framedMultiPanel
        .frameLocator('#embedded')
        .locator('#panel-grid iframe');
      await expect(nestedPanels).toHaveCount(2);

      // Verify the fixture actually requested both provider documents and Chromium explicitly
      // blocked both responses (ERR_BLOCKED_BY_RESPONSE -> chrome-error://chromewebdata/).
      await expect
        .poll(() => ({
          glmRequested: server.observed.chatglmPageRequests > beforeAttacker.chatglmPageRequests,
          mimoRequested: server.observed.mimoPageRequests > beforeAttacker.mimoPageRequests,
          glmBlocked: blockedFrameFailures.some(
            (entry) =>
              entry.url.startsWith(`https://${CHATGLM_HOST}/`) &&
              entry.errorText.includes('ERR_BLOCKED_BY_RESPONSE')
          ),
          mimoBlocked: blockedFrameFailures.some(
            (entry) =>
              entry.url.startsWith(`https://${MIMO_HOST}/`) &&
              entry.errorText.includes('ERR_BLOCKED_BY_RESPONSE')
          ),
        }))
        .toEqual({
          glmRequested: true,
          mimoRequested: true,
          glmBlocked: true,
          mimoBlocked: true,
        });

      expect(server.observed.chatglmUserInfoAuths.length).toBe(beforeAttacker.chatglmUserInfoCount);
      expect(server.observed.mimoUserGetCalls.length).toBe(beforeAttacker.mimoUserGetCount);
      expect(server.observed.mimoHistoryListCalls.length).toBe(beforeAttacker.mimoHistoryListCount);
      await framedMultiPanel.close();

      // 3B. Even when a third-party origin frames a frameable endpoint (without XFO) on BOTH
      //     chatglm.cn and aistudio.xiaomimimo.com, mirrored CHIPS cookies must NEVER leak
      //     into either document.cookie or the HTTP Cookie header.
      const probePage = await extension.context.newPage();
      await probePage.goto(`https://${ATTACKER_HOST}/probe-host`);

      const chatglmProbeFrame = probePage.frameLocator('#probe-chatglm');
      const mimoProbeFrame = probePage.frameLocator('#probe-mimo');
      await expect(chatglmProbeFrame.locator('#probe-doc-cookie')).toHaveText('EMPTY');
      await expect(mimoProbeFrame.locator('#probe-doc-cookie')).toHaveText('EMPTY');

      expect(server.observed.chatglmProbeCookieHeaders.length).toBeGreaterThan(0);
      expect(server.observed.mimoProbeCookieHeaders.length).toBeGreaterThan(0);
      const latestGlmProbeHeader = server.observed.chatglmProbeCookieHeaders.at(-1);
      const latestMimoProbeHeader = server.observed.mimoProbeCookieHeaders.at(-1);
      expect(latestGlmProbeHeader).not.toContain('chatglm_token');
      expect(latestGlmProbeHeader).not.toContain('chatglm_refresh_token');
      expect(latestMimoProbeHeader).not.toContain('xiaomichatbot_ph');
      expect(latestMimoProbeHeader).not.toContain('userId');
      expect(latestMimoProbeHeader).not.toContain('xiaomichatbot_serviceToken');
      await probePage.close();

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

  test('preserves legacy HTTPS-only grants for Zhipu and HTTPS custom web providers without http:// permission', async () => {
    const server = await startAuthTlsFixtureServer();
    // Simulate legacy upgrade: ONLY https:// origins granted, NO http:// origins!
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(
        ...OPTIONAL_PROVIDER_CONFIGS.chatglm.origins,
        `https://${MIMO_HOST}/*`
      );
    });

    const hostRules = [
      `MAP ${CHATGLM_HOST} 127.0.0.1:${server.port}`,
      `MAP ${MIMO_HOST} 127.0.0.1:${server.port}`,
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

      // Both panels must remain enabled, embedded, and framed cleanly without http:// grants
      const panelFrames = mpPage.locator('#panel-grid iframe');
      await expect(panelFrames).toHaveCount(2);
      await expect(panelFrames.nth(0).contentFrame().locator('#chatglm-auth-state')).toHaveText(
        'Logged out (Guest)'
      );
      await expect(panelFrames.nth(1).contentFrame().locator('#mimo-auth-state')).toHaveText(
        'Sign in'
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
      await extensionCopy.cleanup();
      await server.close();
    }
  });

  test('provider cleanup expires only CHIPS partitioned mirrors and preserves top-level browser login cookies in real Chromium', async () => {
    const server = await startAuthTlsFixtureServer();
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(
        ...OPTIONAL_PROVIDER_CONFIGS.chatglm.origins,
        `http://${CHATGLM_HOST}/*`,
        `https://${MIMO_HOST}/*`,
        `https://*.${MIMO_PARENT_DOMAIN}/*`,
        `http://*.${MIMO_PARENT_DOMAIN}/*`
      );
    });

    const hostRules = [
      `MAP ${CHATGLM_HOST} 127.0.0.1:${server.port}`,
      `MAP ${MIMO_HOST} 127.0.0.1:${server.port}`,
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

      // 1. Log in on top-level browser tabs for both Zhipu and Xiaomi MiMo
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

      // 2. Register MiMo custom provider and open Multi-Panel so cookies mirror into CHIPS
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

      // Verify CHIPS partitioned mirrors exist before disabling providers, AND verify that
      // http://*.xiaomimimo.com/* + https://*.xiaomimimo.com/* allows getAll({ url: "http://aistudio.xiaomimimo.com/" })
      // to return BOTH host-only and parent-domain .xiaomimimo.com non-Secure cookies.
      const beforeCleanup = await extension.serviceWorker.evaluate(
        async ({ glmHost, mimoHost }) => {
          const partitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };
          const [glmPart, mimoPart, mimoHttpQuery] = await Promise.all([
            chrome.cookies.getAll({ url: `https://${glmHost}/`, partitionKey }),
            chrome.cookies.getAll({ url: `https://${mimoHost}/`, partitionKey }),
            chrome.cookies.getAll({ url: `http://${mimoHost}/` }),
          ]);
          return {
            glmPartNames: glmPart.map((c) => c.name).sort(),
            mimoPartSummary: mimoPart
              .map(({ name, domain, hostOnly }) => ({ name, domain, hostOnly }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            mimoHttpTopNames: mimoHttpQuery
              .filter((c) => !c.partitionKey)
              .map((c) => c.name)
              .sort(),
          };
        },
        { glmHost: CHATGLM_HOST, mimoHost: MIMO_HOST }
      );
      expect(beforeCleanup.glmPartNames).toEqual(['chatglm_refresh_token', 'chatglm_token']);
      expect(beforeCleanup.mimoHttpTopNames).toEqual([
        'mimo_host_pref',
        'userId',
        'xiaomichatbot_ph',
        'xiaomichatbot_serviceToken',
      ]);
      expect(beforeCleanup.mimoPartSummary).toEqual([
        { name: 'mimo_host_pref', domain: MIMO_HOST, hostOnly: true },
        { name: 'userId', domain: `.${MIMO_PARENT_DOMAIN}`, hostOnly: false },
        { name: 'xiaomichatbot_ph', domain: `.${MIMO_PARENT_DOMAIN}`, hostOnly: false },
      ]);

      // 3. Disable both providers (keeping host permissions) and trigger cleanup reconciliation
      await mpPage.evaluate(async () => {
        await chrome.storage.sync.set({ enabledProviders: ['chatgpt'] });
        await chrome.runtime.sendMessage({ action: 'syncOptionalProviderAccess' });
      });

      // 4. Assert (a) CHIPS partitioned mirrors are completely GONE,
      //    AND (b) unpartitioned top-level browser cookies (including all 3 .xiaomimimo.com cookies) are STILL INTACT!
      const afterCleanup = await extension.serviceWorker.evaluate(
        async ({ glmHost, mimoHost }) => {
          const partitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` };
          const [glmPart, mimoPart, glmTop, mimoTop, stored] = await Promise.all([
            chrome.cookies.getAll({ url: `https://${glmHost}/`, partitionKey }),
            chrome.cookies.getAll({ url: `https://${mimoHost}/`, partitionKey }),
            chrome.cookies.getAll({ url: `https://${glmHost}/` }),
            chrome.cookies.getAll({ url: `https://${mimoHost}/` }),
            chrome.storage.local.get([
              'mirroredEmbeddedFrameCookies',
              'pendingEmbeddedFrameCookieCleanups',
            ]),
          ]);
          return {
            glmPartNames: glmPart.map((c) => c.name),
            mimoPartNames: mimoPart.map((c) => c.name),
            glmTopNames: glmTop.filter((c) => !c.partitionKey).map((c) => c.name).sort(),
            mimoTopNames: mimoTop.filter((c) => !c.partitionKey).map((c) => c.name).sort(),
            mirrored: stored.mirroredEmbeddedFrameCookies || {},
            pending: stored.pendingEmbeddedFrameCookieCleanups || {},
          };
        },
        { glmHost: CHATGLM_HOST, mimoHost: MIMO_HOST }
      );

      expect(afterCleanup.glmPartNames).toEqual([]);
      expect(afterCleanup.mimoPartNames).toEqual([]);
      expect(afterCleanup.mirrored).toEqual({});
      expect(afterCleanup.pending).toEqual({});
      expect(afterCleanup.glmTopNames).toEqual(['chatglm_refresh_token', 'chatglm_token']);
      expect(afterCleanup.mimoTopNames).toEqual([
        'mimo_host_pref',
        'userId',
        'xiaomichatbot_ph',
        'xiaomichatbot_serviceToken',
      ]);

      // 5. Verify in real top-level browser tabs that both sites are STILL logged in!
      server.observed.chatglmGuestCalls = 0;
      const verifyZhipuTopTab = await extension.context.newPage();
      await verifyZhipuTopTab.goto(`https://${CHATGLM_HOST}/`);
      await expect(verifyZhipuTopTab.locator('#chatglm-auth-state')).toHaveText(
        'Logged in: ZhipuLoggedInUser'
      );
      expect(server.observed.chatglmGuestCalls).toBe(0);
      await verifyZhipuTopTab.close();

      const verifyMimoTopTab = await extension.context.newPage();
      await verifyMimoTopTab.goto(`https://${MIMO_HOST}/`);
      await expect(verifyMimoTopTab.locator('#mimo-auth-state')).toHaveText('Logged in: MiMoUser');
      await verifyMimoTopTab.close();

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
      await extensionCopy.cleanup();
      await server.close();
    }
  });

  test('confirms Chromium blocks parent-domain .xiaomimimo.com cookie access when only host-only https:// + http:// grants are held', async () => {
    const server = await startAuthTlsFixtureServer();
    // Grant ONLY exact subdomain origins (NO *.xiaomimimo.com parent-domain companion origins)
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`https://${MIMO_HOST}/*`, `http://${MIMO_HOST}/*`);
    });

    const hostRules = `MAP ${MIMO_HOST} 127.0.0.1:${server.port}`;

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
      const mimoTab = await extension.context.newPage();
      await mimoTab.goto(`https://${MIMO_HOST}/sts-login`);
      await expect(mimoTab.locator('#sts-done')).toHaveText('STS Login Complete');
      await mimoTab.goto(`https://${MIMO_HOST}/`);
      await expect(mimoTab.locator('#mimo-auth-state')).toHaveText('Logged in: MiMoUser');
      await mimoTab.close();

      const visibility = await extension.serviceWorker.evaluate(
        async ({ mimoHost, parentDomain }) => {
          const [byHttpUrl, byHttpsUrl, allCookies] = await Promise.all([
            chrome.cookies.getAll({ url: `http://${mimoHost}/` }),
            chrome.cookies.getAll({ url: `https://${mimoHost}/` }),
            chrome.cookies.getAll({}),
          ]);
          const parentNames = (list) =>
            list
              .filter((c) => c.domain === `.${parentDomain}` || c.domain === parentDomain)
              .map((c) => c.name)
              .sort();
          return {
            byHttpUrlHostNames: byHttpUrl
              .filter((c) => c.domain === mimoHost)
              .map((c) => c.name)
              .sort(),
            byHttpUrlParentNames: parentNames(byHttpUrl),
            byHttpsUrlParentNames: parentNames(byHttpsUrl),
            allParentNames: parentNames(allCookies),
          };
        },
        { mimoHost: MIMO_HOST, parentDomain: MIMO_PARENT_DOMAIN }
      );

      // Exact root-cause proof in real Chromium: host-only cookie IS visible,
      // but ALL parent-domain .xiaomimimo.com cookies are hidden without *.xiaomimimo.com!
      expect(visibility.byHttpUrlHostNames).toEqual(['mimo_host_pref']);
      expect(visibility.byHttpUrlParentNames).toEqual([]);
      expect(visibility.byHttpsUrlParentNames).toEqual([]);
      expect(visibility.allParentNames).toEqual([]);
    } finally {
      await extension.close();
      await extensionCopy.cleanup();
      await server.close();
    }
  });
});
