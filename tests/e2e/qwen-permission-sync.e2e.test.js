import { test, expect, chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, '../..');

test.describe('Qwen optional permission sync E2E', () => {
  test.setTimeout(60000);

  let context;
  let page;
  let userDataDir;

  test.beforeAll(async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-qwen-sync-'));
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
    page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    await page.waitForSelector('[data-provider-id="qwen-cn"]');
  });

  test.afterAll(async () => {
    await context?.close();
    await rm(userDataDir, { recursive: true, force: true });
  });

  test('preserves the synced preference when this device has no Qwen permission', async ({}, testInfo) => {
    await page.evaluate(async () => {
      await chrome.storage.sync.set({
        enabledProviders: ['chatgpt', 'qwen-cn'],
        providerOrder: ['chatgpt', 'qwen-cn'],
      });
    });

    await page.waitForTimeout(1500);
    await page.reload();
    await page.waitForSelector('[data-provider-id="qwen-cn"]');
    await page.screenshot({
      path: testInfo.outputPath('qwen-permission-sync.png'),
      fullPage: true,
    });

    const state = await page.evaluate(async () => {
      const settings = await chrome.storage.sync.get({ enabledProviders: [] });
      const item = document.querySelector('[data-provider-id="qwen-cn"]');
      const registeredScripts = await chrome.scripting.getRegisteredContentScripts();
      const dynamicRules = await chrome.declarativeNetRequest.getDynamicRules();

      return {
        enabledProviders: settings.enabledProviders,
        permissionGranted: await chrome.permissions.contains({
          origins: ['https://www.qianwen.com/*'],
        }),
        enabledPreference: item?.dataset.enabledPreference,
        hasAccess: item?.dataset.hasAccess,
        toggleActive: item?.querySelector('.toggle-switch')?.classList.contains('active'),
        qwenScriptRegistered: registeredScripts.some(({ id }) => id === 'qwen-cn-scripts'),
        qwenRuleRegistered: dynamicRules.some(({ id }) => id === 1001),
      };
    });

    expect(state).toEqual({
      enabledProviders: ['chatgpt', 'qwen-cn'],
      permissionGranted: false,
      enabledPreference: 'true',
      hasAccess: 'false',
      toggleActive: false,
      qwenScriptRegistered: false,
      qwenRuleRegistered: false,
    });
  });
});
