import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  createPatchedExtensionCopy,
  launchExtension,
  startFixtureServer,
} from './extension-harness.js';

const SPOOF_HOST = 'accounts.google.com.evil.tld';
const SPOOF_ORIGIN = `https://${SPOOF_HOST}`;

function renderCustomChatFixtureHtml(titleText = 'Custom WebUI Fixture') {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${titleText}</title>
  </head>
  <body>
    <h1 id="fixture-title">${titleText}</h1>
    <div id="messages"></div>
    <form id="chat-form" style="margin-top:24px;display:flex;gap:8px;align-items:center">
      <textarea
        id="composer"
        aria-label="Prompt input"
        placeholder="Ask anything..."
        style="width:360px;height:64px"
      ></textarea>
      <button
        id="send-btn"
        type="submit"
        aria-label="Send message"
        style="width:72px;height:36px"
      >Send</button>
    </form>
  </body>
</html>`;
}

async function startLocalTlsFixtureServer(titleText) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panelize-b3b-tls-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
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
      `/CN=${SPOOF_HOST}`,
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' }
  );

  const server = https.createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml(titleText));
    }
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function waitForServiceWorkerReady(extension) {
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

async function readFramedTitle(frameHandle) {
  const frame = await frameHandle.contentFrame();
  if (!frame || frame.url().startsWith('chrome-error:')) {
    return null;
  }
  return frame
    .evaluate(() => document.getElementById('fixture-title')?.textContent ?? null)
    .catch(() => null);
}

/**
 * Measures the rendered badge box and character-by-character Range rects over
 * the badge's plain-text DOM node.
 */
async function measureBadgeGlyphs(page, badgeSelector, tailSubstring) {
  return page.evaluate(
    ({ selector, tail }) => {
      const badge = document.querySelector(selector);
      if (!badge) return null;

      const textNode = badge.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        return { error: 'missing-text-node' };
      }

      const text = textNode.nodeValue || '';
      const badgeRect = badge.getBoundingClientRect();

      const charRects = [];
      let monotonicLtr = true;
      let prevLeft = -Infinity;
      for (let i = 0; i < text.length; i += 1) {
        const range = document.createRange();
        range.setStart(textNode, i);
        range.setEnd(textNode, i + 1);
        const rect = range.getBoundingClientRect();
        charRects.push({
          char: text[i],
          left: rect.left,
          right: rect.right,
          width: rect.width,
        });
        if (rect.left + 0.05 < prevLeft) {
          monotonicLtr = false;
        }
        prevLeft = rect.left;
      }

      const firstChar = charRects[0];
      const lastChar = charRects[charRects.length - 1];

      let tailRect = null;
      if (tail && text.endsWith(tail)) {
        const tailRange = document.createRange();
        tailRange.setStart(textNode, text.length - tail.length);
        tailRange.setEnd(textNode, text.length);
        const r = tailRange.getBoundingClientRect();
        tailRect = { left: r.left, right: r.right, width: r.width };
      }

      return {
        textContent: badge.textContent,
        title: badge.title,
        badgeLeft: badgeRect.left,
        badgeRight: badgeRect.right,
        badgeWidth: badgeRect.width,
        monotonicLtr,
        firstChar,
        lastChar,
        tailRect,
        lastCharInsideBadge:
          lastChar.width > 0 &&
          lastChar.left >= badgeRect.left - 0.5 &&
          lastChar.right <= badgeRect.right + 0.5,
        firstCharClippedAtStart: firstChar.left < badgeRect.left - 0.5,
      };
    },
    { selector: badgeSelector, tail: tailSubstring }
  );
}

test.describe('B3b origin badge start-truncation and host-tail/port visibility E2E', () => {
  test.setTimeout(90_000);

  test('keeps the port last character inside .panel-origin-badge below 300px and below 180px without bidi reordering, and truncates .menu-provider-name before .menu-origin-badge', async () => {
    const primaryFixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml('Loopback Port Fixture'));
    });

    const secondaryFixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml('Secondary Port Fixture'));
    });

    const primaryOrigin = `http://127.0.0.1:${primaryFixture.port}`;
    const secondaryOrigin = `http://127.0.0.1:${secondaryFixture.port}`;
    const primaryPortTail = `:${primaryFixture.port}`;
    const secondaryPortTail = `:${secondaryFixture.port}`;

    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${primaryOrigin}/*`, `${secondaryOrigin}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
      });
      await waitForServiceWorkerReady(extension);

      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt'],
          providerOrder: ['chatgpt'],
          multiPanelProviders: ['chatgpt'],
          multiPanelLayout: '1x2',
        });
      });

      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await optionsPage
        .locator('#custom-provider-name')
        .fill('My Very Long Self-Hosted Custom WebUI AI');
      await optionsPage.locator('#custom-provider-url').fill(`${primaryOrigin}/chat`);
      await optionsPage.locator('#custom-provider-add-btn').click();

      await optionsPage
        .locator('#custom-provider-name')
        .fill('Second Very Long Self-Hosted Custom WebUI');
      await optionsPage.locator('#custom-provider-url').fill(`${secondaryOrigin}/chat`);
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(
        optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]')
      ).toHaveCount(2);

      // Keep only primary custom + chatgpt in active panels so secondary appears in add-panel menu too
      await extension.serviceWorker.evaluate(async () => {
        const { customProviders } = await chrome.storage.local.get('customProviders');
        await chrome.storage.sync.set({
          multiPanelProviders: [customProviders[0].id, 'chatgpt'],
          multiPanelLayout: '1x2',
        });
      });

      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      const customPanel = mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]');
      await expect(customPanel).toHaveCount(1);
      const customIframeHandle = await customPanel.locator('iframe').elementHandle();
      await expect.poll(() => readFramedTitle(customIframeHandle), { timeout: 15_000 }).toBe(
        'Loopback Port Fixture'
      );

      const panelBadgeSelector =
        '#panel-grid .panel-item[data-custom-provider="true"] .panel-origin-badge';

      // 1. Wide panel: full origin visible, strictly LTR, exact textContent & title
      const wideMetrics = await measureBadgeGlyphs(mpPage, panelBadgeSelector, primaryPortTail);
      expect(wideMetrics.textContent).toBe(primaryOrigin);
      expect(wideMetrics.title).toBe(primaryOrigin);
      expect(wideMetrics.monotonicLtr).toBe(true);
      expect(wideMetrics.lastCharInsideBadge).toBe(true);
      expect(wideMetrics.firstCharClippedAtStart).toBe(false);

      // 2. Below 300px (240px): badge truncates at the START; port's last char stays inside visible box
      await customPanel.evaluate((el) => {
        el.style.width = '240px';
      });
      const below300Metrics = await measureBadgeGlyphs(mpPage, panelBadgeSelector, primaryPortTail);
      expect(below300Metrics.monotonicLtr).toBe(true);
      expect(below300Metrics.lastCharInsideBadge).toBe(true);
      expect(below300Metrics.firstCharClippedAtStart).toBe(true);
      expect(below300Metrics.tailRect.left).toBeGreaterThanOrEqual(below300Metrics.badgeLeft - 0.5);
      expect(below300Metrics.tailRect.right).toBeLessThanOrEqual(below300Metrics.badgeRight + 0.5);

      // 3. Below 180px (150px and 125px): port's last char stays inside the badge's visible box
      for (const narrowWidth of ['150px', '125px']) {
        await customPanel.evaluate((el, w) => {
          el.style.width = w;
        }, narrowWidth);
        const below180Metrics = await measureBadgeGlyphs(
          mpPage,
          panelBadgeSelector,
          primaryPortTail
        );
        expect(below180Metrics.monotonicLtr).toBe(true);
        expect(below180Metrics.lastCharInsideBadge).toBe(true);
        expect(below180Metrics.firstCharClippedAtStart).toBe(true);
        expect(below180Metrics.tailRect.left).toBeGreaterThanOrEqual(
          below180Metrics.badgeLeft - 0.5
        );
        expect(below180Metrics.tailRect.right).toBeLessThanOrEqual(
          below180Metrics.badgeRight + 0.5
        );
      }

      await customPanel.evaluate((el) => {
        el.style.width = '';
      });

      // 4. Menu badge (.add-panel-menu): title === origin, name truncates before badge at every width,
      // and when forced narrow, .menu-origin-badge also start-truncates keeping port tail visible
      await mpPage.locator('#add-panel-btn').click();
      await expect(mpPage.locator('.add-panel-menu')).toBeVisible();

      const menuPriorityReport = await mpPage.evaluate(() => {
        const menu = document.querySelector('.add-panel-menu');
        const item = menu.querySelector('.add-panel-item[data-custom-provider="true"]');
        const nameEl = item.querySelector('.menu-provider-name');
        const badgeEl = item.querySelector('.menu-origin-badge');

        menu.style.maxWidth = 'none';
        menu.style.width = '640px';
        const fullBadgeWidth = badgeEl.getBoundingClientRect().width;
        const fullNameWidth = nameEl.getBoundingClientRect().width;

        const violations = [];
        for (let w = 460; w >= 165; w -= 15) {
          menu.style.width = `${w}px`;
          const nw = nameEl.getBoundingClientRect().width;
          const bw = badgeEl.getBoundingClientRect().width;
          if (bw < fullBadgeWidth - 0.5 && nw > 0.5) {
            violations.push({ w, nw, bw, fullBadgeWidth });
          }
        }
        menu.style.width = '165px';
        return { fullNameWidth, fullBadgeWidth, violations };
      });
      expect(menuPriorityReport.violations).toEqual([]);

      const narrowMenuMetrics = await measureBadgeGlyphs(
        mpPage,
        '.add-panel-menu .add-panel-item[data-custom-provider="true"] .menu-origin-badge',
        secondaryPortTail
      );
      expect(narrowMenuMetrics.textContent).toBe(secondaryOrigin);
      expect(narrowMenuMetrics.title).toBe(secondaryOrigin);
      expect(narrowMenuMetrics.monotonicLtr).toBe(true);
      expect(narrowMenuMetrics.lastCharInsideBadge).toBe(true);
      expect(narrowMenuMetrics.firstCharClippedAtStart).toBe(true);
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await secondaryFixture.close();
      await primaryFixture.close();
    }
  });

  test('mapped spoofing-style HTTPS origin (https://accounts.google.com.evil.tld) keeps .evil.tld visible below 300px and below 180px', async () => {
    const tlsServer = await startLocalTlsFixtureServer('Spoofed Login Portal Fixture');
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${SPOOF_ORIGIN}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
        args: [
          `--host-resolver-rules=MAP ${SPOOF_HOST} 127.0.0.1:${tlsServer.port}`,
          '--ignore-certificate-errors',
        ],
      });
      await waitForServiceWorkerReady(extension);

      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt'],
          providerOrder: ['chatgpt'],
          multiPanelProviders: ['chatgpt'],
          multiPanelLayout: '1x2',
        });
      });

      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await optionsPage.locator('#custom-provider-name').fill('Google Workspace SSO');
      await optionsPage.locator('#custom-provider-url').fill(`${SPOOF_ORIGIN}/signin`);
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(
        optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]')
      ).toHaveCount(1);

      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      const customPanel = mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]');
      await expect(customPanel).toHaveCount(1);
      const customIframeHandle = await customPanel.locator('iframe').elementHandle();
      await expect.poll(() => readFramedTitle(customIframeHandle), { timeout: 15_000 }).toBe(
        'Spoofed Login Portal Fixture'
      );

      const panelBadgeSelector =
        '#panel-grid .panel-item[data-custom-provider="true"] .panel-origin-badge';

      for (const width of ['240px', '150px']) {
        await customPanel.evaluate((el, w) => {
          el.style.width = w;
        }, width);
        const metrics = await measureBadgeGlyphs(mpPage, panelBadgeSelector, '.evil.tld');
        expect(metrics.textContent).toBe(SPOOF_ORIGIN);
        expect(metrics.title).toBe(SPOOF_ORIGIN);
        expect(metrics.monotonicLtr).toBe(true);
        expect(metrics.lastCharInsideBadge).toBe(true);
        expect(metrics.firstCharClippedAtStart).toBe(true);
        expect(metrics.tailRect.left).toBeGreaterThanOrEqual(metrics.badgeLeft - 0.5);
        expect(metrics.tailRect.right).toBeLessThanOrEqual(metrics.badgeRight + 0.5);
      }
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await tlsServer.close();
    }
  });
});
