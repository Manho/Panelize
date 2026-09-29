import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

test('Send All supports the current ChatGPT composer without a legacy id', async ({}, testInfo) => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderChatgptFixture({ composer: 'current' }),
    }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const panel = page.frameLocator('iframe');
    const editor = panel.locator('[data-composer-placement="thread"] [data-composer-markdown]');
    await expect(editor).toBeVisible();

    const readFixture = () => {
      const frame = page.frames().find(candidate => candidate.url().startsWith('https://chatgpt.com/'));
      return frame ? frame.evaluate(() => window.__fixture).catch(() => null) : null;
    };

    await page.locator('#unified-input').fill('Panelize current composer regression');
    await page.locator('#send-all-btn').click();

    await expect.poll(async () => (await readFixture())?.sentTexts)
      .toEqual(['Panelize current composer regression']);
    expect((await readFixture()).straySends).toEqual([]);
    await expect(editor).toHaveText('');
    await expect(panel.locator('[data-composer-placement="home"] [data-composer-markdown]')).toHaveText('');
    await page.screenshot({ path: testInfo.outputPath('chatgpt-send-all.png'), fullPage: true });
  } finally {
    await extension.close();
  }
});
