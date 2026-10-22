import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';
import {
  RATING_PROMPT_REVIEW_URL,
  RATING_PROMPT_STORAGE_KEY
} from '../../modules/rating-prompt.js';

const readRatingState = (extension) => extension.serviceWorker.evaluate(
  async (key) => (await chrome.storage.local.get(key))[key],
  RATING_PROMPT_STORAGE_KEY
);

async function openWithRatingState(extension, state) {
  await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html', body: renderChatgptFixture({ composer: 'current' }),
  }));
  if (state) {
    await extension.serviceWorker.evaluate(
      (items) => chrome.storage.local.set(items),
      { [RATING_PROMPT_STORAGE_KEY]: state }
    );
  }
  const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
  await expect(page.frameLocator('iframe')
    .locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();
  return page;
}

async function sendAll(page, text) {
  await page.locator('#unified-input').fill(text);
  await page.locator('#send-all-btn').click();
  await expect(page.locator('#send-status')).toHaveText(/Sent to 1 AI/);
}

test('the rating banner appears on the 20th Send All and "Later" snoozes it for 50 sends', async ({}, testInfo) => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openWithRatingState(extension, { sendCount: 18, nextPromptAt: 20, dismissed: false });
    const banner = page.locator('#rating-banner');
    await expect(banner).toBeHidden();

    await sendAll(page, 'Rating prompt send 19');
    await expect.poll(async () => (await readRatingState(extension))?.sendCount).toBe(19);
    await expect(banner).toBeHidden();

    await sendAll(page, 'Rating prompt send 20');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Enjoying Panelize? Rate it on the Chrome Web Store');
    await page.screenshot({ path: testInfo.outputPath('rating-banner.png') });

    await page.locator('#rating-later-btn').click();
    await expect(banner).toBeHidden();
    await expect.poll(() => readRatingState(extension))
      .toEqual({ sendCount: 20, nextPromptAt: 70, dismissed: false });

    await page.reload();
    await expect(page.locator('#panel-grid iframe')).toHaveCount(1);
    await expect(banner).toBeHidden();
  } finally {
    await extension.close();
  }
});

test('"Rate" opens the store reviews page and never shows the banner again', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openWithRatingState(extension, { sendCount: 20, nextPromptAt: 20, dismissed: false });
    const banner = page.locator('#rating-banner');
    await expect(banner).toBeVisible();

    // The store page is never loaded; only the requested URL is checked.
    await extension.context.route('https://chromewebstore.google.com/**', route => route.fulfill({
      contentType: 'text/html', body: '<title>store</title>',
    }));
    const storePage = extension.context.waitForEvent('page');
    await page.locator('#rating-rate-btn').click();
    await (await storePage).waitForURL(RATING_PROMPT_REVIEW_URL);

    await expect(banner).toBeHidden();
    await expect.poll(async () => (await readRatingState(extension))?.dismissed).toBe(true);
  } finally {
    await extension.close();
  }
});

test('"Don\'t ask again" hides the banner for good', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openWithRatingState(extension, { sendCount: 25, nextPromptAt: 20, dismissed: false });
    const banner = page.locator('#rating-banner');
    await expect(banner).toBeVisible();

    await page.locator('#rating-never-btn').click();
    await expect(banner).toBeHidden();
    await expect.poll(async () => (await readRatingState(extension))?.dismissed).toBe(true);

    await sendAll(page, 'Rating prompt after opting out');
    await expect.poll(async () => (await readRatingState(extension))?.sendCount).toBe(26);
    await expect(banner).toBeHidden();
  } finally {
    await extension.close();
  }
});
