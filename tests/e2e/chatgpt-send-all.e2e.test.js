import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

test('Send All supports the current ChatGPT composer without a legacy id', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    // Keep the fixture behavior, but use the attributes observed on the live composer.
    const fixture = renderChatgptFixture()
      .replace('data-type="unified-composer"', 'data-type="unified-composer" data-chatgpt-composer')
      .replace('id="prompt-textarea"', 'data-composer-markdown')
      .replace("document.getElementById('prompt-textarea')", "document.querySelector('[data-composer-markdown]')");
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: fixture,
    }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const editor = page.frameLocator('iframe').locator('[data-composer-markdown]');
    await expect(editor).toBeVisible();
    await page.locator('#unified-input').fill('Panelize current composer regression');
    await page.locator('#send-all-btn').click();
    const frame = page.frames().find(frame => frame.url().startsWith('https://chatgpt.com/'));
    await expect.poll(() => frame.evaluate(() => window.__fixture.sentTexts))
      .toEqual(['Panelize current composer regression']);
    await expect(editor).toHaveText('');
    await page.screenshot({ path: 'test-results/chatgpt-send-all.png', fullPage: true });
  } finally {
    await extension.close();
  }
});
