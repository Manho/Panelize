import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isHeadedRun } from './browser-launch-options.js';
import {
  REPO_EXTENSION_PATH,
  launchExtension,
  openMultiPanel,
  withExternalHostsBlocked,
} from './extension-harness.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

const POLICY_WARNING_PATTERN = /focus-without-user-activation|permissions policy violation|blocked focus call|unrecognized feature|origin trial controlled feature/i;

function resolveBrandedChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const command of ['google-chrome', 'google-chrome-stable']) {
    try {
      const resolved = execFileSync('which', [command], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (resolved && existsSync(resolved)) {
        return resolved;
      }
    } catch {
      // Binary not on PATH.
    }
  }

  return null;
}

function renderGeminiFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gemini policy fixture</title></head>
<body>
  <div class="input-area-container">
    <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>
    <button type="button" aria-label="Send message">Send</button>
  </div>
  <script>
    const editor = document.querySelector('.ql-editor');
    const fp = document.featurePolicy;
    const features = fp?.features?.() || [];
    const hasFeature = features.includes('focus-without-user-activation');
    window.__fixture = {
      pastedImages: 0,
      sentTexts: [],
      bootPolicy: {
        hasFeature,
        allowsFocus: hasFeature ? fp.allowsFeature('focus-without-user-activation') : null,
        isActiveAtBoot: navigator.userActivation?.isActive ?? null,
      },
    };
    editor.addEventListener('paste', (event) => {
      window.__fixture.pastedImages += event.clipboardData?.files?.length || 0;
      event.preventDefault();
    });
    document.querySelector('button[aria-label="Send message"]').addEventListener('click', () => {
      window.__fixture.sentTexts.push(editor.textContent);
      editor.textContent = '';
    });
  </script>
</body>
</html>`;
}

async function launchBrandedChromeWithExtension(brandedChromePath, extensionPath = REPO_EXTENSION_PATH) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-branded-chrome-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: brandedChromePath,
    headless: !isHeadedRun(),
    viewport: { width: 1280, height: 800 },
    args: [
      '--enable-unsafe-extension-debugging',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...withExternalHostsBlocked([]),
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });

  const browserCdp = await context.browser().newBrowserCDPSession();
  const { id: extensionId } = await browserCdp.send('Extensions.loadUnpacked', {
    path: extensionPath,
  });

  const isExtensionWorker = (worker) => worker.url().startsWith('chrome-extension://');
  let serviceWorker = context.serviceWorkers().filter(isExtensionWorker).at(-1);
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker', isExtensionWorker);
  }

  return {
    context,
    serviceWorker,
    extensionId,
    extensionUrl: (relativePath) => `chrome-extension://${extensionId}/${relativePath}`,
    async close() {
      await browserCdp.detach().catch(() => {});
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

test.describe('focus-without-user-activation policy guard E2E', () => {
  test.setTimeout(60000);

  test('emits zero focus-without-user-activation violations on branded Google Chrome when injecting into a sandboxed Gemini panel iframe', async () => {
    const brandedChromePath = resolveBrandedChromePath();
    test.skip(
      !brandedChromePath,
      'Requires branded Google Chrome (158+) to emit sandboxed focus-without-user-activation violations'
    );

    const extension = await launchBrandedChromeWithExtension(brandedChromePath);
    try {
      // Enable Developer Mode and extension error collection before opening Multi-Panel
      // so any real Chrome extension runtime error is recorded just like chrome://extensions/?errors=...
      const extensionsPage = await extension.context.newPage();
      await extensionsPage.goto('chrome://extensions/');
      await extensionsPage.evaluate(async (id) => {
        await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
        await chrome.developerPrivate.updateExtensionConfiguration({
          extensionId: id,
          errorCollection: true,
        });
      }, extension.extensionId);

      // Plain Gemini fixture with NO Permissions-Policy header: the real Multi-Panel iframe
      // `sandbox` attribute triggers Chrome's `focus-without-user-activation` policy.
      await extension.context.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: renderGeminiFixture(),
        })
      );

      await extension.serviceWorker.evaluate(async (settings) => {
        await chrome.storage.sync.set(settings);
      }, {
        enabledProviders: ['gemini'],
        providerOrder: ['gemini'],
        multiPanelProviders: ['gemini'],
        multiPanelLayout: '1x1',
      });

      const page = await extension.context.newPage();
      const policyConsoleMessages = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if (POLICY_WARNING_PATTERN.test(text)) {
          policyConsoleMessages.push({
            type: msg.type(),
            text,
            url: msg.location()?.url || '',
            line: msg.location()?.lineNumber ?? null,
          });
        }
      });

      await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
      // Wait for the panel iframe to finish loading from the host page without touching the
      // iframe via frameLocator/evaluate first (CDP evaluation activates userGesture).
      await page.waitForFunction(() => {
        const iframes = document.querySelectorAll('#panel-grid iframe');
        const loadings = Array.from(document.querySelectorAll('#panel-grid .panel-loading'));
        return (
          iframes.length === 1 &&
          loadings.length === 1 &&
          loadings.every((el) => el.classList.contains('hidden'))
        );
      });

      // Fill text into the sandboxed Gemini iframe without user activation.
      await page.fill('#unified-input', 'guarded branded chrome prompt');
      await page.click('#fill-input-btn');
      await expect(page.locator('#send-status')).toHaveText('Filled 1 input');

      // Exercise image paste + text fill while the iframe still has no user activation.
      await page.locator('#image-file-input').setInputFiles({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      });
      await expect(page.locator('.image-preview-item').first()).toBeVisible();
      await page.fill('#unified-input', ' with image');
      await page.click('#fill-input-btn');
      await expect(page.locator('#send-status')).toHaveText('Filled 1 input');
      await page.waitForTimeout(200);

      // Inspect iframe state and chrome://extensions runtime errors AFTER all fills finish.
      const geminiFrame = page.frames().find((f) => f.url().startsWith('https://gemini.google.com/'));
      const frameResult = await geminiFrame.evaluate(() => ({
        fixture: window.__fixture,
        editorText: document.querySelector('.ql-editor')?.textContent || '',
      }));

      const runtimeErrors = await extensionsPage.evaluate(async (id) => {
        const info = await chrome.developerPrivate.getExtensionInfo(id);
        return (info.runtimeErrors || []).map((err) => ({
          message: err.message,
          source: err.source,
          severity: err.severity,
        }));
      }, extension.extensionId);

      const policyRuntimeErrors = runtimeErrors.filter((err) =>
        POLICY_WARNING_PATTERN.test(err.message || '')
      );

      expect(frameResult.fixture.bootPolicy).toEqual({
        hasFeature: true,
        allowsFocus: false,
        isActiveAtBoot: false,
      });
      expect(frameResult.editorText).toContain('guarded branded chrome prompt');
      expect(frameResult.editorText).toContain('with image');
      expect(frameResult.fixture.pastedImages).toBe(1);
      expect(policyConsoleMessages).toEqual([]);
      expect(policyRuntimeErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('emits zero Unrecognized feature or policy warnings on default Chromium without the Blink flag', async () => {
    const extension = await launchExtension({
      viewport: { width: 1280, height: 800 },
    });
    try {
      await extension.context.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: renderGeminiFixture(),
        })
      );

      const page = await openMultiPanel(extension, {
        providers: ['gemini'],
        layout: '1x1',
      });

      const policyConsoleMessages = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if (POLICY_WARNING_PATTERN.test(text)) {
          policyConsoleMessages.push({ type: msg.type(), text });
        }
      });

      const geminiEditor = page.frameLocator('iframe[src*="gemini"]').locator('.ql-editor');
      await expect(geminiEditor).toBeVisible();

      await page.fill('#unified-input', 'standard chromium fill');
      await page.click('#fill-input-btn');

      await expect(geminiEditor).toHaveText('standard chromium fill');
      await page.waitForTimeout(300);

      expect(policyConsoleMessages).toEqual([]);
    } finally {
      await extension.close();
    }
  });
});
