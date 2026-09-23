import { test, expect } from '@playwright/test';
import { launchExtension } from './extension-harness.js';

test.describe('Layout options E2E', () => {
  test.setTimeout(60000);

  let extension;
  let page;

  test.beforeAll(async () => {
    extension = await launchExtension();
    const { serviceWorker } = extension;

    await serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        enabledProviders: [],
        providerOrder: [],
        multiPanelProviders: [],
        multiPanelLayout: '1x3',
      });
    });

    page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    await page.waitForSelector('#layout-btn');
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  test('shows and applies the 1x12 and 2x6 layouts', async ({}, testInfo) => {
    await page.click('#layout-btn');
    await expect(page.locator('#layout-modal')).toBeVisible();
    await expect(page.locator('[data-layout="1x12"]')).toBeVisible();
    await expect(page.locator('[data-layout="2x6"]')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('layout-options.png'),
      fullPage: true,
    });

    await page.locator('[data-layout="2x6"]').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('layout-options-2x6.png'),
      fullPage: true,
    });

    await page.click('[data-layout="2x6"]');
    await expect(page.locator('#panel-grid')).toHaveClass(/layout-2x6/);

    await page.click('#layout-btn');
    await page.click('[data-layout="1x12"]');
    await expect(page.locator('#panel-grid')).toHaveClass(/layout-1x12/);
  });
});
