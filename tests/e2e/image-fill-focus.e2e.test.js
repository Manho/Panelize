import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

// Smallest valid PNG (1x1, transparent).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Gemini-like page: a Quill editor the content script pastes images into and
 * types into, plus the send button it clicks.
 */
function renderGeminiFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gemini fixture</title></head>
<body>
  <div class="input-area-container">
    <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>
    <button type="button" aria-label="Send message">Send</button>
  </div>
  <script>
    const editor = document.querySelector('.ql-editor');
    window.__fixture = { pastedImages: 0, sentTexts: [] };
    editor.addEventListener('paste', (event) => {
      window.__fixture.pastedImages += event.clipboardData?.files?.length || 0;
      event.preventDefault();
    });
    editor.addEventListener('drop', (event) => event.preventDefault());
    document.querySelector('button[aria-label="Send message"]').addEventListener('click', () => {
      window.__fixture.sentTexts.push(editor.textContent);
      editor.textContent = '';
    });
  </script>
</body>
</html>`;
}

test('Enter fill with an image keeps focus, so the next Enter sends every panel', async ({}, testInfo) => {
  test.setTimeout(60000);
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderChatgptFixture(),
    }));
    await extension.context.route('https://gemini.google.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderGeminiFixture(),
    }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt', 'gemini'], layout: '1x2' });

    const readFixture = (host) => {
      const frame = page.frames().find(candidate => candidate.url().startsWith(`https://${host}/`));
      return frame ? frame.evaluate(() => window.__fixture).catch(() => null) : null;
    };
    const activeElementLabel = () => page.evaluate(
      () => document.activeElement?.id || document.activeElement?.tagName
    );
    await expect.poll(async () => Boolean(await readFixture('gemini.google.com'))).toBe(true);
    await expect.poll(async () => Boolean(await readFixture('chatgpt.com'))).toBe(true);
    // Let the panel load grace period (3s) end, so only the fill protects focus.
    await page.waitForTimeout(3300);

    await page.locator('#image-file-input').setInputFiles({
      name: 'pixel.png', mimeType: 'image/png', buffer: PNG_BYTES,
    });
    await expect(page.locator('.image-preview-item').first()).toBeVisible();
    await page.locator('#unified-input').click();
    await page.keyboard.type('describe this');
    await page.keyboard.press('Enter');

    // The first Enter only fills when images are attached.
    await expect.poll(async () => (await readFixture('gemini.google.com'))?.pastedImages).toBe(1);
    const geminiEditor = page.frameLocator('iframe[src*="gemini"]').locator('.ql-editor');
    await expect(geminiEditor).toHaveText('describe this');
    await expect(page.locator('#send-status')).toHaveText('Filled 2 inputs');
    await page.waitForTimeout(500);

    expect(await activeElementLabel()).toBe('unified-input');

    await page.keyboard.press('Enter');

    await expect.poll(async () => (await readFixture('gemini.google.com'))?.sentTexts)
      .toEqual(['describe this']);
    await expect.poll(async () => (await readFixture('chatgpt.com'))?.sends).toBe(1);
    await page.screenshot({ path: testInfo.outputPath('image-fill-focus.png'), fullPage: true });
  } finally {
    await extension.close();
  }
});

test('clicking into a panel after an image fill keeps focus there', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://gemini.google.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderGeminiFixture(),
    }));
    const page = await openMultiPanel(extension, { providers: ['gemini'] });
    const geminiEditor = page.frameLocator('iframe').locator('.ql-editor');
    await expect(geminiEditor).toBeVisible();
    await page.waitForTimeout(3300);

    await page.locator('#image-file-input').setInputFiles({
      name: 'pixel.png', mimeType: 'image/png', buffer: PNG_BYTES,
    });
    await page.locator('#unified-input').fill('describe this');
    await page.locator('#unified-input').press('Enter');
    await expect(page.locator('#send-status')).toHaveText('Filled 1 input');

    // The focus restore timers keep running after the fill; a click in the
    // panel must stop them.
    await geminiEditor.click();
    await page.waitForTimeout(2800);

    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
    await expect(geminiEditor).toBeFocused();
  } finally {
    await extension.close();
  }
});
