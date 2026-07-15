import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../..');

test.describe('Claude model selection E2E', () => {
  test.setTimeout(60000);

  let context;
  let extensionId;
  let userDataDir;

  test.beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-claude-model-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1200, height: 900 },
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
    extensionId = new URL(serviceWorker.url()).host;

    await context.route('https://claude.ai/**', async route => {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><body>Claude test frame</body></html>',
      });
    });
  });

  test.afterAll(async () => {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  });

  test('persists and synchronizes the global selector with responsive themes', async ({}, testInfo) => {
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const panelUrl = `chrome-extension://${extensionId}/multi-panel/multi-panel.html`;

    await pageA.goto(panelUrl);
    await pageA.evaluate(async () => {
      await chrome.storage.sync.set({
        claudeModelMode: 'default',
        enabledProviders: ['claude'],
        multiPanelLayout: '1x1',
        multiPanelProviders: ['claude'],
        providerOrder: ['claude'],
        theme: 'light',
      });
    });
    await pageA.reload();
    await pageB.goto(panelUrl);

    const selectorA = pageA.locator('.panel-claude-model-select');
    const selectorB = pageB.locator('.panel-claude-model-select');
    await expect(selectorA).toHaveValue('default');
    await expect(selectorB).toHaveValue('default');
    await expect(selectorA.locator('option')).toHaveText([
      'Claude default',
      'Opus 4.8',
      'Sonnet 5',
      'Haiku 4.5',
    ]);
    await expect(pageA.locator('.embedded-model-limit-notice')).toBeVisible();

    await selectorA.selectOption('opus-4-8');
    await expect(selectorA).toHaveValue('opus-4-8');
    await expect(selectorB).toHaveValue('opus-4-8');
    await expect.poll(async () => pageA.evaluate(async () => (
      await chrome.storage.sync.get('claudeModelMode')
    ).claudeModelMode)).toBe('opus-4-8');

    await pageB.reload();
    await expect(pageB.locator('.panel-claude-model-select')).toHaveValue('opus-4-8');
    await pageA.screenshot({
      path: testInfo.outputPath('claude-model-selector-1x1-light.png'),
      fullPage: true,
    });

    await pageA.evaluate(async () => {
      await chrome.storage.sync.set({
        theme: 'dark',
      });
    });
    await pageA.reload();
    await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(pageA.locator('.panel-claude-model-select')).toHaveCSS('background-repeat', 'no-repeat');
    await pageA.screenshot({
      path: testInfo.outputPath('claude-model-selector-1x1-dark.png'),
      fullPage: true,
    });

    await pageA.evaluate(async () => {
      await chrome.storage.sync.set({
        multiPanelLayout: '1x10',
        theme: 'light',
      });
    });
    await pageA.reload();
    await expect(pageA.locator('#panel-grid')).toHaveClass(/layout-1x10/);
    await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(pageA.locator('.panel-claude-model-select')).toBeVisible();
    await pageA.screenshot({
      path: testInfo.outputPath('claude-model-selector-1x10-light.png'),
      fullPage: true,
    });

    await pageA.evaluate(async () => {
      await chrome.storage.sync.set({ theme: 'dark' });
    });
    await pageA.reload();
    await expect(pageA.locator('#panel-grid')).toHaveClass(/layout-1x10/);
    await expect(pageA.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(pageA.locator('.panel-claude-model-select')).toBeVisible();
    await expect(pageA.locator('.panel-claude-model-select')).toHaveCSS('background-repeat', 'no-repeat');
    await pageA.screenshot({
      path: testInfo.outputPath('claude-model-selector-1x10-dark.png'),
      fullPage: true,
    });

    await pageA.locator('.panel-claude-model-select').selectOption('default');
    await expect(pageB.locator('.panel-claude-model-select')).toHaveValue('default');

    await pageA.close();
    await pageB.close();
  });
});
