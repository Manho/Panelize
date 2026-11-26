import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

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
      policyReports: [],
    };
    if (typeof ReportingObserver === 'function') {
      new ReportingObserver((reports) => {
        for (const report of reports) {
          window.__fixture.policyReports.push({
            type: report.type,
            featureId: report.body?.featureId || null,
            message: report.body?.message || null,
          });
        }
      }, { types: ['permissions-policy-violation', 'feature-policy-violation'], buffered: true }).observe();
    }
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

function renderDeepSeekFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DeepSeek policy fixture</title></head>
<body>
  <main>
    <textarea id="deepseek-editor" placeholder="Message DeepSeek" rows="2"></textarea>
    <div role="button" tabindex="0" id="deepseek-send" class="ds-button">Send</div>
  </main>
  <script>
    const editor = document.getElementById('deepseek-editor');
    window.__fixture = { sentTexts: [] };
    document.getElementById('deepseek-send').addEventListener('click', () => {
      window.__fixture.sentTexts.push(editor.value);
      editor.value = '';
    });
  </script>
</body>
</html>`;
}

const POLICY_WARNING_PATTERN = /focus-without-user-activation|permissions policy violation|blocked focus call|unrecognized feature|origin trial controlled feature/i;

test.describe('focus-without-user-activation policy guard E2E', () => {
  test.setTimeout(60000);

  test('injects text and images into cross-origin provider iframes without emitting focus-without-user-activation violations when Blink enforces the policy', async () => {
    const extension = await launchExtension({
      viewport: { width: 1280, height: 800 },
      args: ['--enable-blink-features=BlockingFocusWithoutUserActivation'],
    });
    try {
      await extension.context.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'Permissions-Policy': 'focus-without-user-activation=()' },
          body: renderGeminiFixture(),
        })
      );
      await extension.context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: { 'Permissions-Policy': 'focus-without-user-activation=()' },
          body: renderDeepSeekFixture(),
        })
      );

      const page = await openMultiPanel(extension, {
        providers: ['gemini', 'deepseek'],
        layout: '1x2',
      });

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

      const geminiEditor = page.frameLocator('iframe[src*="gemini"]').locator('.ql-editor');
      const deepseekEditor = page.frameLocator('iframe[src*="deepseek"]').locator('#deepseek-editor');
      await expect(geminiEditor).toBeVisible();
      await expect(deepseekEditor).toBeVisible();

      // Fill text into both contenteditable (Gemini) and textarea (DeepSeek) without activating either iframe.
      // Note: do NOT call frame.evaluate() before filling, as CDP Runtime.evaluate activates userGesture.
      await page.fill('#unified-input', 'guarded cross-origin prompt');
      await page.click('#fill-input-btn');

      await expect(geminiEditor).toHaveText('guarded cross-origin prompt');
      await expect(deepseekEditor).toHaveValue('guarded cross-origin prompt');

      // Also exercise image paste + fill on Gemini while the iframe still has no user activation.
      await page.locator('#image-file-input').setInputFiles({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      });
      await expect(page.locator('.image-preview-item').first()).toBeVisible();
      await page.fill('#unified-input', ' with image');
      await page.click('#fill-input-btn');

      await expect(geminiEditor).toContainText('with image');
      await page.waitForTimeout(300);

      // Inspect iframe state AFTER all unactivated injections have completed.
      const geminiFrame = page.frames().find((f) => f.url().startsWith('https://gemini.google.com/'));
      const fixture = await geminiFrame.evaluate(() => window.__fixture);

      expect(fixture.bootPolicy).toEqual({
        hasFeature: true,
        allowsFocus: false,
        isActiveAtBoot: false,
      });
      expect(fixture.pastedImages).toBe(1);
      expect(fixture.policyReports).toEqual([]);
      expect(policyConsoleMessages).toEqual([]);
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
