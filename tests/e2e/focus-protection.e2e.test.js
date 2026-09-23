import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

// Mirrors LOAD_GRACE_PERIOD in multi-panel.js: panels keep focus protection
// for this long after their iframe fires `load`.
const LOAD_GRACE_PERIOD_MS = 3000;
const PROVIDER_HOSTS = {
  chatgpt: 'chatgpt.com',
  gemini: 'gemini.google.com',
  grok: 'grok.com',
};

/**
 * Focus protection runs against the real multi-panel page and the real content
 * script. Provider sites are replaced by fixture pages that autofocus their
 * composer the way live SPAs do, so every assertion exercises production code.
 */
test.describe('Focus protection E2E', () => {
  test.setTimeout(45000);

  let extension;
  let page;
  let fixtureConfigByHost = {};

  test.beforeAll(async () => {
    extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    for (const host of Object.values(PROVIDER_HOSTS)) {
      await extension.context.route(`https://${host}/**`, (route) => route.fulfill({
        contentType: 'text/html',
        body: renderChatgptFixture(fixtureConfigByHost[host]),
      }));
    }
  });

  test.afterEach(async () => {
    await page?.close();
    page = null;
    fixtureConfigByHost = {};
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  async function openPanels(configByProvider, layout = '1x1') {
    const providers = Object.keys(configByProvider);
    fixtureConfigByHost = Object.fromEntries(
      providers.map((providerId) => [PROVIDER_HOSTS[providerId], configByProvider[providerId]])
    );
    page = await openMultiPanel(extension, { providers, layout });
    await Promise.all(providers.map((providerId) => waitForFixtureReady(providerId)));
  }

  function providerFrame(providerId) {
    const host = PROVIDER_HOSTS[providerId];
    return page.frames().find((frame) => new URL(frame.url()).host === host);
  }

  async function waitForFixtureReady(providerId) {
    await expect.poll(async () => {
      const frame = providerFrame(providerId);
      return frame ? frame.evaluate(() => Boolean(window.__fixture)).catch(() => false) : false;
    }).toBe(true);
  }

  async function fixtureState(providerId) {
    return providerFrame(providerId).evaluate(() => window.__fixture);
  }

  async function waitForSteals(providerId, reason, count) {
    await expect.poll(async () => {
      const state = await fixtureState(providerId);
      return state.steals.filter((steal) => steal.reason === reason).length;
    }, { timeout: 20000 }).toBe(count);
    // Let the multi-panel blur handler and requestAnimationFrame refocus settle.
    await page.waitForTimeout(300);
  }

  async function activeElementLabel() {
    return page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  }

  async function waitForLoadGracePeriod() {
    await page.waitForTimeout(LOAD_GRACE_PERIOD_MS + 300);
  }

  async function stealFocusFromProvider(providerId) {
    await providerFrame(providerId).evaluate(() => {
      document.getElementById('prompt-textarea').focus();
    });
  }

  test('control: a loaded provider panel can take focus once protection ends', async () => {
    await openPanels({ chatgpt: {} });
    await waitForLoadGracePeriod();
    await page.click('#unified-input');

    await stealFocusFromProvider('chatgpt');

    // Without this, every "focus stays on the unified input" assertion below
    // could pass simply because the fixture iframe is unable to take focus.
    await expect.poll(activeElementLabel).toBe('IFRAME');
  });

  test('keeps the unified input focused while a panel autofocuses during load', async () => {
    await openPanels({ chatgpt: { loadStealDelays: [300, 800, 1500] } });
    await expect.poll(activeElementLabel).toBe('unified-input');

    await page.keyboard.type('hello world', { delay: 80 });
    await waitForSteals('chatgpt', 'load', 3);

    expect(await activeElementLabel()).toBe('unified-input');
    await expect(page.locator('#unified-input')).toHaveValue('hello world');
  });

  test('keeps focus while several panels autofocus at different times', async () => {
    await openPanels({
      chatgpt: { loadStealDelays: [200] },
      gemini: { loadStealDelays: [700] },
      grok: { loadStealDelays: [1400] },
    }, '1x3');
    await page.click('#unified-input');

    await Promise.all([
      waitForSteals('chatgpt', 'load', 1),
      waitForSteals('gemini', 'load', 1),
      waitForSteals('grok', 'load', 1),
    ]);

    expect(await activeElementLabel()).toBe('unified-input');
  });

  test('lets the user click into a panel after loading finishes', async () => {
    await openPanels({ chatgpt: {} });
    await waitForLoadGracePeriod();
    await page.click('#unified-input');

    await page.frameLocator('iframe').locator('#prompt-textarea').click();
    await page.waitForTimeout(500);

    expect(await activeElementLabel()).toBe('IFRAME');
  });

  test('re-enables protection when a panel is refreshed', async () => {
    await openPanels({ chatgpt: {} });
    await waitForLoadGracePeriod();

    fixtureConfigByHost[PROVIDER_HOSTS.chatgpt] = { loadStealDelays: [400, 1000] };
    await page.click('.refresh-panel-btn');
    await page.click('#unified-input');
    await waitForFixtureReady('chatgpt');
    await waitForSteals('chatgpt', 'load', 2);

    expect(await activeElementLabel()).toBe('unified-input');
  });

  test('new chat restore beats delayed composer autofocus', async () => {
    await openPanels({ chatgpt: { newChatStealDelays: [100, 300, 900] } });
    await waitForLoadGracePeriod();
    await page.click('#unified-input');

    await page.click('#new-chat-btn');
    await waitForSteals('chatgpt', 'new-chat', 3);

    expect((await fixtureState('chatgpt')).newChats).toBe(1);
    expect(await activeElementLabel()).toBe('unified-input');
  });

  test('clicking elsewhere cancels the new chat focus restore', async () => {
    await openPanels({ chatgpt: { newChatStealDelays: [900] } });
    await waitForLoadGracePeriod();
    await page.click('#unified-input');

    await page.click('#new-chat-btn');
    await page.waitForTimeout(150);
    await page.click('.panel-header-left span');
    await waitForSteals('chatgpt', 'new-chat', 1);

    // The restore timers at 1000-1500ms must not pull focus back.
    await page.waitForTimeout(800);
    expect(await activeElementLabel()).toBe('IFRAME');
  });

  test('send all keeps focus while ChatGPT streams, then releases it', async () => {
    test.setTimeout(60000);
    await openPanels({
      chatgpt: { sendStealDelays: [100, 1000, 4000, 9000, 12500], busyAfterSendMs: 13000 },
    });
    await waitForLoadGracePeriod();

    await page.fill('#unified-input', 'hello');
    await page.click('#send-all-btn');
    await waitForSteals('chatgpt', 'send', 5);

    expect((await fixtureState('chatgpt')).sentTexts).toEqual(['hello']);
    expect(await activeElementLabel()).toBe('unified-input');

    // Once the stop button is gone the content script reports IDLE and the
    // panel may take focus again.
    await providerFrame('chatgpt').waitForSelector('[data-testid="stop-button"]', { state: 'detached' });
    await page.waitForTimeout(1200);
    await stealFocusFromProvider('chatgpt');
    await expect.poll(activeElementLabel).toBe('IFRAME');
  });

  test('Enter send keeps the unified input focused', async () => {
    await openPanels({ chatgpt: { sendStealDelays: [100, 1200, 4200] } });
    await waitForLoadGracePeriod();

    await page.click('#unified-input');
    await page.keyboard.type('hello');
    await page.keyboard.press('Enter');
    await waitForSteals('chatgpt', 'send', 3);

    expect((await fixtureState('chatgpt')).sentTexts).toEqual(['hello']);
    expect(await activeElementLabel()).toBe('unified-input');
  });

  test('sending after fill triggers provider send buttons and keeps focus', async () => {
    await openPanels({ chatgpt: { sendStealDelays: [100, 1000, 2500] } });
    await waitForLoadGracePeriod();

    await page.fill('#unified-input', 'filled first');
    await page.click('#fill-input-btn');
    await expect(page.frameLocator('iframe').locator('#prompt-textarea')).toHaveText('filled first');

    await page.fill('#unified-input', '');
    await page.click('#send-all-btn');
    await waitForSteals('chatgpt', 'send', 3);

    expect((await fixtureState('chatgpt')).sentTexts).toEqual(['filled first']);
    expect(await activeElementLabel()).toBe('unified-input');
  });

  test('clicking elsewhere cancels the send focus restore', async () => {
    await openPanels({ chatgpt: { sendStealDelays: [1000] } });
    await waitForLoadGracePeriod();

    await page.fill('#unified-input', 'hello');
    await page.click('#send-all-btn');
    await page.waitForTimeout(150);
    await page.click('.panel-header-left span');
    await waitForSteals('chatgpt', 'send', 1);

    // Restore timers at 1500ms and later must not pull focus back.
    await page.waitForTimeout(1500);
    expect(await activeElementLabel()).toBe('IFRAME');
  });

  test('clicking inside a provider panel cancels the send focus restore', async () => {
    // Known bug: the unified input blur handler refocuses synchronously when
    // the click moves focus into the iframe, and the provider's
    // USER_INTERACTION message only arrives a few ms later. The restore loop
    // is cancelled, but the user's first click has already been undone.
    // Remove this marker once multi-panel.js defers that refocus.
    test.fail(true, 'First click into a panel during send focus restore is pulled back');

    await openPanels({ chatgpt: {} });
    await waitForLoadGracePeriod();

    await page.fill('#unified-input', 'hello');
    await page.click('#send-all-btn');
    await expect.poll(async () => (await fixtureState('chatgpt')).sends).toBe(1);

    // A trusted click inside the iframe makes the content script report
    // PANELIZE_PROVIDER_USER_INTERACTION, which must stop the restore loop.
    await page.frameLocator('iframe').locator('#prompt-textarea').click();
    await page.waitForTimeout(2800);

    expect(await activeElementLabel()).toBe('IFRAME');
  });
});
