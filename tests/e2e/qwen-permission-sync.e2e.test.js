import { test, expect } from '@playwright/test';
import { launchExtension } from './extension-harness.js';

test.describe('Qwen optional permission sync E2E', () => {
  test.setTimeout(60000);

  let extension;
  let page;

  test.beforeAll(async () => {
    extension = await launchExtension();
    page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('options/options.html'));
    await page.waitForSelector('[data-provider-id="qwen-cn"]');
  });

  test.afterAll(async () => {
    await extension?.close();
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
