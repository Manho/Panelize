import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
} from './extension-harness.js';

const SW_PROVIDER_HOST = 'sw-custom-ai.test';
const SW_PROVIDER_ORIGIN = `https://${SW_PROVIDER_HOST}`;
const THIRD_PARTY_HOST = 'third-party-sw.test';
const THIRD_PARTY_ORIGIN = `https://${THIRD_PARTY_HOST}`;
const CUSTOM_PROVIDER_ID = 'custom-5ebe11a999';
const CUSTOM_FRAME_RULE_ID = 10000;

function renderServiceWorkerScript() {
  // Mirrors Workbox / Perplexity HTML navigation caching:
  // caches /spa/index.html (with X-Frame-Options: DENY and CSP frame-ancestors 'self')
  // in CacheStorage ('pplx-html-v2') and serves cached responses on subsequent navigations.
  return `
const CACHE_NAME = 'pplx-html-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isHtmlNavigationRoute(request) {
  const url = new URL(request.url);
  if (url.searchParams.has('q') || url.pathname === '/new-tab-page') {
    return false;
  }
  if (/\\/[^/?]+\\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== '/spa/index.html') {
    return false;
  }
  const accept = request.headers.get('accept') || '';
  return request.destination === 'document' || accept.includes('text/html');
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || !isHtmlNavigationRoute(event.request)) {
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const appShellRequest = new Request(new URL('/spa/index.html', self.location.origin).href);
    const cached = await cache.match(appShellRequest);
    const networkPromise = fetch(appShellRequest)
      .then((response) => {
        if (response && response.ok && response.headers.get('x-ppl-sw') === '1') {
          cache.put(appShellRequest, response.clone());
        }
        return response;
      })
      .catch(() => null);

    if (cached) {
      event.waitUntil(networkPromise);
      return cached;
    }

    const fresh = await networkPromise;
    return fresh || new Response('Offline', { status: 503 });
  })());
});
`;
}

function renderProviderHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>SW Cached Custom AI</title>
  </head>
  <body>
    <h1 id="fixture-ready">Perplexity SW Fixture Ready</h1>
    <div id="messages"></div>
    <form id="chat-form" style="margin-top:24px;display:flex;gap:8px;align-items:center">
      <textarea
        id="composer"
        aria-label="Ask anything"
        placeholder="Ask anything..."
        style="width:360px;height:64px"
      ></textarea>
      <button
        id="send-btn"
        type="submit"
        aria-label="Submit"
        style="width:72px;height:36px"
      >Send</button>
    </form>
    <script>
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {});
      }
      const form = document.getElementById('chat-form');
      const composer = document.getElementById('composer');
      const messages = document.getElementById('messages');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const prompt = composer.value.trim();
        if (!prompt) return;
        const reply = document.createElement('div');
        reply.className = 'assistant-reply';
        reply.textContent = 'SW Reply: ' + prompt;
        messages.appendChild(reply);
        composer.value = '';
      });
    </script>
  </body>
</html>`;
}

function renderThirdPartyFramingPage() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Third Party Framing Probe</title></head>
  <body>
    <iframe id="frame-main" src="${SW_PROVIDER_ORIGIN}/"></iframe>
    <iframe id="frame-probe" src="${SW_PROVIDER_ORIGIN}/robots.txt?q=1&__panelize_sw_recover=1"></iframe>
    <script>
      window.loadedCount = 0;
      document.querySelectorAll('iframe').forEach((frame) => {
        frame.addEventListener('load', () => { window.loadedCount += 1; }, { once: true });
      });
    </script>
  </body>
</html>`;
}

async function startSwTlsServer() {
  const certDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-sw-tls-'));
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
      '-days',
      '1',
      '-subj',
      `/CN=${SW_PROVIDER_HOST}`,
      '-addext',
      `subjectAltName=DNS:${SW_PROVIDER_HOST},DNS:${THIRD_PARTY_HOST}`,
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' }
  );

  const server = https.createServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certPath),
    },
    (req, res) => {
      const host = (req.headers.host || '').split(':')[0];
      if (host === THIRD_PARTY_HOST) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderThirdPartyFramingPage());
        return;
      }

      const parsedUrl = new URL(req.url || '/', SW_PROVIDER_ORIGIN);
      if (parsedUrl.pathname === '/service-worker.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderServiceWorkerScript());
        return;
      }

      if (parsedUrl.pathname === '/robots.txt') {
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "frame-ancestors 'self'",
        });
        res.end('User-agent: *\nAllow: /\n');
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy':
          "default-src 'self' 'unsafe-inline'; frame-ancestors 'self' https://onedrive.live.com",
        'x-ppl-sw': '1',
      });
      res.end(renderProviderHtml());
    }
  );

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(certDir, { recursive: true, force: true });
    },
  };
}

async function waitForExtensionReady(extension) {
  await expect
    .poll(
      async () => {
        extension.serviceWorker =
          extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
        return extension.serviceWorker
          .evaluate(() =>
            Boolean(
              chrome.storage?.local &&
                chrome.storage?.sync &&
                chrome.declarativeNetRequest?.getDynamicRules &&
                chrome.scripting?.getRegisteredContentScripts
            )
          )
          .catch(() => false);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

async function readRenderedFrameText(frameHandle, selector) {
  const frame = await frameHandle.contentFrame();
  if (!frame || frame.url().startsWith('chrome-error:')) {
    return null;
  }
  return frame
    .evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector)
    .catch(() => null);
}

test.describe('Custom web AI Service Worker poisoned CacheStorage framing recovery', () => {
  test.setTimeout(60_000);

  test('recovers automatically from pre-poisoned Service Worker CacheStorage while preserving session state and blocking third-party framing', async () => {
    const server = await startSwTlsServer();
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${SW_PROVIDER_ORIGIN}/*`);
    });

    const hostRules = [
      `MAP ${SW_PROVIDER_HOST} 127.0.0.1:${server.port}`,
      `MAP ${THIRD_PARTY_HOST} 127.0.0.1:${server.port}`,
    ].join(',');

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
        args: [`--host-resolver-rules=${hostRules}`, '--ignore-certificate-errors'],
      });
      await waitForExtensionReady(extension);

      // 1. Visit the provider in a normal top-level tab (keeping it open!) to install the
      //    Service Worker, populate CacheStorage ('pplx-html-v2') with X-Frame-Options: DENY
      //    and CSP frame-ancestors 'self', and store cookies + localStorage.
      const topTab = await extension.context.newPage();
      await topTab.goto(`${SW_PROVIDER_ORIGIN}/`, { waitUntil: 'networkidle' });
      await topTab.evaluate(async () => {
        localStorage.setItem('pplx_session_marker', 'keep-logged-in');
        document.cookie = 'pplx_auth=keep-cookie; path=/; SameSite=None; Secure';
        await navigator.serviceWorker.ready;
      });
      await topTab.reload({ waitUntil: 'networkidle' });

      const poisonedState = await topTab.evaluate(async () => {
        const cache = await caches.open('pplx-html-v2');
        const keys = await cache.keys();
        const cachedRes = keys.length > 0 ? await cache.match(keys[0]) : null;
        return {
          controllerActive: Boolean(navigator.serviceWorker.controller),
          cachedUrls: keys.map((req) => req.url),
          xfo: cachedRes?.headers.get('x-frame-options') ?? null,
          csp: cachedRes?.headers.get('content-security-policy') ?? null,
        };
      });
      expect(poisonedState.controllerActive).toBe(true);
      expect(poisonedState.cachedUrls).toEqual([`${SW_PROVIDER_ORIGIN}/spa/index.html`]);
      expect(poisonedState.xfo).toBe('DENY');
      expect(poisonedState.csp).toContain("frame-ancestors 'self'");

      // 2. Seed custom web provider in storage and open Multi-Panel immediately
      //    (also exercising Multi-Panel's startup access sync before iframe load).
      await extension.serviceWorker.evaluate(
        async ({ providerId, origin, frameRuleId }) => {
          await chrome.storage.local.set({
            customProviders: [
              {
                id: providerId,
                name: 'Perplexity',
                url: `${origin}/`,
                frameRuleId,
                createdAt: 1700000000000,
              },
            ],
          });
        },
        {
          providerId: CUSTOM_PROVIDER_ID,
          origin: SW_PROVIDER_ORIGIN,
          frameRuleId: CUSTOM_FRAME_RULE_ID,
        }
      );

      const mpPage = await openMultiPanel(extension, {
        providers: [CUSTOM_PROVIDER_ID],
        layout: '1x1',
      });

      const customPanel = mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]');
      await expect(customPanel).toHaveCount(1);
      const iframeHandle = await customPanel.locator('iframe').elementHandle();

      // 3. Multi-Panel recovers automatically and renders the live framed app!
      await expect
        .poll(() => readRenderedFrameText(iframeHandle, '#fixture-ready'), { timeout: 15_000 })
        .toBe('Perplexity SW Fixture Ready');

      // No leftover recovery probe iframes in DOM
      await expect(mpPage.locator('iframe[data-panelize-sw-probe="true"]')).toHaveCount(0);

      // 4. Cookies and localStorage on the provider origin are 100% preserved
      const preservedSession = await (await iframeHandle.contentFrame()).evaluate(() => ({
        localStorageMarker: localStorage.getItem('pplx_session_marker'),
        cookie: document.cookie,
      }));
      expect(preservedSession).toEqual({
        localStorageMarker: 'keep-logged-in',
        cookie: 'pplx_auth=keep-cookie',
      });

      // 5. Broadcast Fill & Send works end-to-end inside the recovered panel
      await mpPage.locator('#unified-input').fill('Why did Service Worker cache block framing?');
      await mpPage.locator('#send-all-btn').click();
      await expect(customPanel.frameLocator('iframe').locator('.assistant-reply')).toHaveText(
        'SW Reply: Why did Service Worker cache block framing?'
      );

      // 6. Visit 2 & Visit 3: clicking Refresh on the panel AND reloading Multi-Panel
      //    both keep working cleanly even while topTab remains open!
      await customPanel.locator('.refresh-panel-btn').click();
      await expect
        .poll(() => readRenderedFrameText(iframeHandle, '#fixture-ready'), { timeout: 15_000 })
        .toBe('Perplexity SW Fixture Ready');

      await mpPage.reload({ waitUntil: 'domcontentloaded' });
      const reloadedIframeHandle = await mpPage
        .locator('#panel-grid .panel-item[data-custom-provider="true"] iframe')
        .elementHandle();
      await expect
        .poll(() => readRenderedFrameText(reloadedIframeHandle, '#fixture-ready'), {
          timeout: 15_000,
        })
        .toBe('Perplexity SW Fixture Ready');

      // 7. Security invariant: a third-party website still CANNOT frame either '/' or '/robots.txt'
      const thirdPartyPage = await extension.context.newPage();
      await thirdPartyPage.goto(`${THIRD_PARTY_ORIGIN}/`, { waitUntil: 'domcontentloaded' });
      await expect.poll(() => thirdPartyPage.evaluate(() => window.loadedCount)).toBe(2);

      const thirdPartyMainHandle = await thirdPartyPage.locator('#frame-main').elementHandle();
      const thirdPartyProbeHandle = await thirdPartyPage.locator('#frame-probe').elementHandle();
      expect(await readRenderedFrameText(thirdPartyMainHandle, '#fixture-ready')).toBeNull();
      expect(await readRenderedFrameText(thirdPartyProbeHandle, 'pre')).toBeNull();
      const probeFrame = await thirdPartyProbeHandle.contentFrame();
      expect(
        !probeFrame || probeFrame.url() === '' || probeFrame.url().startsWith('chrome-error:')
      ).toBe(true);
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await server.close();
    }
  });
});
