import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function renderSimpleProviderHtml(name, extraBody = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>${name}</title></head>
<body style="margin:0;font-family:system-ui,sans-serif;padding:16px;background:#fff;color:#1a1a1a;">
  <h2 style="margin:0 0 8px;font-size:15px;">${name}</h2>
  <p style="margin:0;font-size:13px;color:#555;">Ready for comparison.</p>
  ${extraBody}
</body>
</html>`;
}

test.describe('Issue #118 UI Polish & Standalone postMessage Fix E2E', () => {
  test.setTimeout(90000);

  test('compact multi-panel bottom composer works across Light, Dark, and Narrow viewports without overflow', async () => {
    const extension = await launchExtension({ viewport: { width: 1440, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    try {
      await extension.context.route('https://chatgpt.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderSimpleProviderHtml('ChatGPT') })
      );
      await extension.context.route('https://claude.ai/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderSimpleProviderHtml('Claude') })
      );
      await extension.context.route('https://gemini.google.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderSimpleProviderHtml('Gemini') })
      );

      const page = await openMultiPanel(extension, {
        providers: ['chatgpt', 'claude', 'gemini'],
        layout: '1x3',
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // Verify compact bottom bar geometry on 1440px desktop
      const desktopMetrics = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const container = document.querySelector('.input-container').getBoundingClientRect();
        const input = document.getElementById('unified-input').getBoundingClientRect();
        const status = document.getElementById('send-status').getBoundingClientRect();
        return {
          barHeight: bar.height,
          barWidth: bar.width,
          containerWidth: container.width,
          inputWidth: input.width,
          statusWidth: status.width,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      });

      expect(desktopMetrics.barHeight).toBeLessThanOrEqual(56);
      // Full-width container without 1200px dead margins on 1440px screen
      expect(desktopMetrics.containerWidth).toBeGreaterThan(1380);
      expect(desktopMetrics.statusWidth).toBe(0);
      expect(desktopMetrics.overflowX).toBe(false);

      // Attach an image preview and verify strip renders cleanly
      await page.locator('#image-file-input').setInputFiles({
        name: 'preview.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      });
      await expect(page.locator('.image-preview-item')).toHaveCount(1);
      await page.locator('.image-preview-item .remove-image').click({ force: true });
      await expect(page.locator('.image-preview-item')).toHaveCount(0);

      // Open Prompt Library modal and verify select + search render cleanly
      await page.click('#prompt-library-btn');
      await expect(page.locator('#prompt-modal')).toBeVisible();
      await expect(page.locator('#prompt-category-filter')).toBeVisible();
      await page.click('#close-prompt-modal');
      await expect(page.locator('#prompt-modal')).toBeHidden();

      // Switch to dark theme and verify bottom bar adapts
      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({ theme: 'dark' });
      });
      await page.reload();
      await page.waitForSelector('#unified-input');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const darkScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      expect(darkScheme).toContain('dark');

      // Verify narrow viewport (390px) keeps composer usable without horizontal overflow
      await page.setViewportSize({ width: 390, height: 844 });
      const narrowMetrics = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const input = document.getElementById('unified-input').getBoundingClientRect();
        const sendBtn = document.getElementById('send-all-btn').getBoundingClientRect();
        return {
          barHeight: bar.height,
          inputWidth: input.width,
          sendRight: sendBtn.right,
          viewportWidth: window.innerWidth,
        };
      });
      expect(narrowMetrics.barHeight).toBeLessThanOrEqual(56);
      expect(narrowMetrics.inputWidth).toBeGreaterThanOrEqual(120);
      expect(narrowMetrics.sendRight).toBeLessThanOrEqual(narrowMetrics.viewportWidth);

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('Settings dropdowns, theme switching, and Prompt Library section work seamlessly in Light and Dark themes', async () => {
    const extension = await launchExtension({ viewport: { width: 1280, height: 900 } });
    const consoleErrors = [];
    const pageErrors = [];
    try {
      // Fulfill GitHub version-check endpoint in offline E2E mode so no network error is logged.
      await extension.context.route('https://api.github.com/**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ tag_name: 'v2.2.4', html_url: 'https://github.com/Manho/Panelize/releases/latest' }),
        })
      );
      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({ theme: 'light', language: 'en' });
      });

      const page = await extension.context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
        }
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      await page.goto(extension.extensionUrl('options/options.html'));
      await page.waitForSelector('#theme-select');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

      // Verify customizable base-select is active in Chromium
      const selectInfo = await page.evaluate(() => {
        const themeSelect = document.getElementById('theme-select');
        const style = getComputedStyle(themeSelect);
        return {
          appearance: style.appearance,
          width: themeSelect.getBoundingClientRect().width,
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
        };
      });
      expect(selectInfo.appearance).toBe('base-select');
      expect(selectInfo.width).toBeGreaterThanOrEqual(104);
      expect(selectInfo.colorScheme).toContain('light');

      // Open dropdown with click and verify :open state, then switch theme to dark
      await page.locator('#theme-select').click();
      await expect.poll(() =>
        page.evaluate(() => document.getElementById('theme-select').matches(':open'))
      ).toBe(true);
      await page.keyboard.press('Escape');

      await page.locator('#theme-select').selectOption('dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      const darkScheme = await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
      expect(darkScheme).toContain('dark');

      // Verify layout select updates storage cleanly
      await page.locator('#multi-panel-layout-select').selectOption('2x2');
      await expect.poll(async () =>
        extension.serviceWorker.evaluate(async () => (await chrome.storage.sync.get('multiPanelLayout')).multiPanelLayout)
      ).toBe('2x2');

      // Verify Prompt Library section controls and default prompt import flow
      const libraryCard = page.locator('.library-import-card');
      await libraryCard.scrollIntoViewIfNeeded();
      await expect(libraryCard).toBeVisible();
      await expect(page.locator('#import-default-library')).toBeVisible();
      await expect(page.locator('#import-custom-library')).toBeVisible();
      await expect(page.locator('#open-custom-prompt-guide')).toBeVisible();
      await expect(page.locator('#download-custom-prompt-template')).toBeVisible();

      await page.click('#import-default-library');
      await expect.poll(async () => Number(await page.locator('#stat-prompts').textContent())).toBeGreaterThan(0);

      // Verify no broken images on options page
      const brokenImages = await page.evaluate(() =>
        Array.from(document.querySelectorAll('img'))
          .filter((img) => getComputedStyle(img).display !== 'none' && img.naturalWidth === 0)
          .map((img) => img.src)
      );
      expect(brokenImages).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('standalone Gemini tab with child iframe produces zero postMessage origin warnings while Multi-Panel iframe keeps reporting', async () => {
    const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    const warningsAndErrors = [];
    try {
      await extension.context.route('https://gemini.google.com/**', (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get('subframe') === '1') {
          return route.fulfill({
            contentType: 'text/html',
            body: renderSimpleProviderHtml('Gemini Subframe'),
          });
        }
        return route.fulfill({
          contentType: 'text/html',
          body: renderSimpleProviderHtml(
            'Gemini Standalone',
            '<iframe id="gemini-child-frame" src="https://gemini.google.com/u/1/app?subframe=1" style="width:200px;height:80px;border:0;"></iframe>'
          ),
        });
      });

      // 1. Standalone top-level Gemini tab embedding a same-origin child iframe
      const standalonePage = await extension.context.newPage();
      standalonePage.on('console', (msg) => {
        if (msg.type() === 'warning' || msg.type() === 'error') {
          warningsAndErrors.push(msg.text());
        }
      });
      standalonePage.on('pageerror', (err) => warningsAndErrors.push(err.message));

      await standalonePage.goto('https://gemini.google.com/u/1/app', { waitUntil: 'networkidle' });
      // Trigger history pushState in both top-level and child iframe to exercise location reporting
      await standalonePage.evaluate(() => {
        history.pushState({}, '', '/u/1/app/thread-1');
      });
      const childFrame = standalonePage.frames().find((f) => f.url().includes('subframe=1'));
      expect(childFrame).toBeTruthy();
      await childFrame.evaluate(() => {
        history.pushState({}, '', '/u/1/app?subframe=1#updated');
      });
      await standalonePage.waitForTimeout(400);

      const postMessageWarnings = warningsAndErrors.filter((text) =>
        /postMessage|target origin/i.test(text)
      );
      expect(postMessageWarnings).toEqual([]);
      expect(warningsAndErrors).toEqual([]);

      // 2. Embedded Gemini panel inside Multi-Panel must still report its /u/1 account to the host
      const mpPage = await openMultiPanel(extension, { providers: ['gemini'], layout: '1x1' });
      const mpWarnings = [];
      mpPage.on('console', (msg) => {
        if (msg.type() === 'warning' || msg.type() === 'error') {
          mpWarnings.push(msg.text());
        }
      });

      await expect.poll(() =>
        mpPage.frames().some(
          (f) => f.url().startsWith('https://gemini.google.com/') && !f.url().includes('subframe=1')
        )
      ).toBe(true);
      const geminiFrame = mpPage.frames().find(
        (f) => f.url().startsWith('https://gemini.google.com/') && !f.url().includes('subframe=1')
      );
      await geminiFrame.waitForLoadState('domcontentloaded');
      await geminiFrame.evaluate(() => {
        window.location.assign('/u/1/app');
      });

      await expect(mpPage.locator('.panel-gemini-account-select')).toHaveValue('1');
      expect(mpWarnings.filter((text) => /postMessage|target origin/i.test(text))).toEqual([]);
    } finally {
      await extension.close();
    }
  });
});
