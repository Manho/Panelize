import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { launchExtension } from '../e2e/extension-harness.js';
import {
  LIVE_HEADLESS,
  LIVE_IGNORED_DEFAULT_ARGS,
  LIVE_SEND_ENABLED,
  LIVE_USER_DATA_DIR,
  configureLiveProviders,
  getSelectedProviders,
  prepareLiveExtension,
  readContentScriptSelectorTable,
} from './live-harness.js';

const SEND_BUTTON_SELECTORS = readContentScriptSelectorTable('SEND_BUTTON_SELECTORS');
const NEW_CHAT_BUTTON_SELECTORS = readContentScriptSelectorTable('NEW_CHAT_BUTTON_SELECTORS');
const providers = getSelectedProviders();
const providerIds = providers.map((provider) => provider.id);

/**
 * Smoke checks against the real provider sites, using the real extension and
 * the same flow a user follows: type into the unified input, press Fill, and
 * look at what landed in the provider panel. Run `npm run test:live:login`
 * first. Not part of CI: results depend on logins and on the sites themselves.
 */
test.describe('Live provider smoke', () => {
  test.setTimeout(LIVE_SEND_ENABLED ? 150000 : 90000);

  let extension;
  let page;
  let panelFrame;
  let currentProviderId;

  test.beforeAll(async () => {
    const extensionPath = await prepareLiveExtension();
    extension = await launchExtension({
      extensionPath,
      userDataDir: LIVE_USER_DATA_DIR,
      headless: LIVE_HEADLESS,
      ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
      viewport: { width: 1400, height: 900 },
      // Some sites refuse to work when the automation infobar flag is set.
      args: ['--disable-blink-features=AutomationControlled'],
    });
  });

  test.afterEach(async ({}, testInfo) => {
    if (page && testInfo.status !== testInfo.expectedStatus) {
      // Keep what is needed to update selectors or fixtures after a site change.
      await page.screenshot({ path: testInfo.outputPath(`${currentProviderId}-multi-panel.png`) }).catch(() => {});
      const html = await panelFrame?.content().catch((error) => `<!-- ${error.message} -->`);
      if (html) {
        const htmlPath = testInfo.outputPath(`${currentProviderId}-frame.html`);
        await writeFile(htmlPath, `<!-- ${panelFrame.url()} -->\n${html}`);
        await testInfo.attach(`${currentProviderId}-frame.html`, { path: htmlPath, contentType: 'text/html' });
      }
    }
    await page?.close();
    page = null;
    panelFrame = null;
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  async function openProviderPanel(providerId) {
    currentProviderId = providerId;
    await configureLiveProviders(extension.serviceWorker, providerIds, {
      panelOrder: [providerId, ...providerIds.filter((id) => id !== providerId)],
    });
    page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    const iframe = page.locator('#panel-grid iframe');
    await expect(iframe).toHaveCount(1);
    panelFrame = await (await iframe.elementHandle()).contentFrame();
    await panelFrame.waitForLoadState('load', { timeout: 45000 });
  }

  function composerContains(token) {
    return panelFrame.evaluate((text) => (
      [...document.querySelectorAll('textarea, input, [contenteditable]:not([contenteditable="false"])')]
        .some((element) => (element.value ?? element.textContent ?? '').includes(text))
    ), token).catch(() => false);
  }

  function firstMatchingSelector(selectors = []) {
    return panelFrame.evaluate((candidates) => candidates.find((selector) => {
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    }) ?? null, selectors).catch(() => null);
  }

  for (const provider of providers) {
    test(`${provider.id}: fill reaches the composer and controls are found`, async () => {
      await openProviderPanel(provider.id);
      const token = `panelize-live-${provider.id}-${Date.now()}`;

      await page.fill('#unified-input', token);
      await page.click('#fill-input-btn');

      await expect.poll(() => composerContains(token), {
        timeout: 30000,
        message: `${provider.id}: filled text never reached a composer (logged out, captcha, or input selectors changed?)`,
      }).toBe(true);

      expect.soft(
        await firstMatchingSelector(SEND_BUTTON_SELECTORS[provider.id]),
        `${provider.id}: no SEND_BUTTON_SELECTORS entry matches`
      ).not.toBeNull();
      expect.soft(
        await firstMatchingSelector(NEW_CHAT_BUTTON_SELECTORS[provider.id]),
        `${provider.id}: no NEW_CHAT_BUTTON_SELECTORS entry matches (falls back to reloading the URL)`
      ).not.toBeNull();

      if (!LIVE_SEND_ENABLED) {
        return;
      }

      await page.click('#send-all-btn');
      await expect.poll(async () => (
        !(await composerContains(token))
        && await panelFrame.evaluate((text) => document.body.innerText.includes(text), token).catch(() => false)
      ), {
        timeout: 60000,
        message: `${provider.id}: the prompt was not sent into the conversation`,
      }).toBe(true);
    });
  }
});
