import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../..');

test.describe('Layout options E2E', () => {
  let context;
  let page;
  let userDataDir;

  test.beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-layout-options-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    const extensionId = new URL(serviceWorker.url()).host;
    await serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        enabledProviders: [],
        providerOrder: [],
        multiPanelProviders: [],
        multiPanelLayout: '1x3',
      });
    });

    page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/multi-panel/multi-panel.html`);
    await page.waitForSelector('#layout-btn');
  });

  test.afterAll(async () => {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
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
