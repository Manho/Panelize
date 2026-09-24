import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';
import { renderTemporaryChatFixture } from './fixtures/temporary-chat-fixture.js';

const PROVIDER_HOSTS = {
  chatgpt: 'chatgpt.com',
  gemini: 'gemini.google.com',
  grok: 'grok.com',
  kimi: 'www.kimi.com',
};

// Mirrors TEMP_CHAT_RETRY_DELAYS in multi-panel.js.
const TEMP_CHAT_RETRY_DELAYS = [1200, 2500, 4000];
const RETRY_WINDOW_MS = TEMP_CHAT_RETRY_DELAYS.at(-1) + 800;

/**
 * Temporary chat runs against the real multi-panel page and the real content
 * script. Fixture provider pages expose the controls the content script
 * clicks, so retries, reloads and URL changes all come from production code.
 */
test.describe('Temporary chat E2E', () => {
  test.setTimeout(45000);

  let extension;
  let page;
  let requestedUrls = [];
  let fixtureOptions = {};

  test.beforeAll(async () => {
    extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    for (const [providerId, host] of Object.entries(PROVIDER_HOSTS)) {
      await extension.context.route(`https://${host}/**`, (route) => {
        requestedUrls.push(route.request().url());
        route.fulfill({
          contentType: 'text/html',
          body: providerId === 'chatgpt'
            ? renderChatgptFixture()
            : renderTemporaryChatFixture(providerId, fixtureOptions),
        });
      });
    }
  });

  test.afterEach(async () => {
    await page?.close();
    page = null;
    requestedUrls = [];
    fixtureOptions = {};
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  async function openPanel(providerId, options = {}) {
    fixtureOptions = options;
    page = await openMultiPanel(extension, { providers: [providerId] });
    await waitForFixtureReady(providerId);
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

  async function messageCount(providerId, type) {
    const state = await fixtureState(providerId);
    return state.messages.filter((message) => message.type === type).length;
  }

  async function geminiTemporaryChatOn() {
    return providerFrame('gemini').evaluate(() => (
      document.querySelector('[data-test-id="temp-chat-button"]')?.classList.contains('temp-chat-on') === true
    ));
  }

  const temporaryChatButton = () => page.locator('#temporary-chat-btn');

  test('retries Gemini activation until the toggle renders, then stops', async () => {
    // The toggle appears after the first retry window (1200ms + 1200ms poll)
    // has given up, so exactly the second retry succeeds.
    await openPanel('gemini', { tempButtonDelayMs: 2600 });
    await page.click('#unified-input');

    await temporaryChatButton().click();
    await expect.poll(geminiTemporaryChatOn, { timeout: 10000 }).toBe(true);
    await page.waitForTimeout(RETRY_WINDOW_MS - 2600);

    const state = await fixtureState('gemini');
    expect(state.newChatClicks).toBe(1);
    expect(state.tempChatClicks).toBe(1);
    expect(await messageCount('gemini', 'ENABLE_TEMP_CHAT')).toBe(2);
    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'true');
    await expect(temporaryChatButton()).toBeEnabled();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('unified-input');
  });

  test('only starts a new chat for providers without temporary chat', async () => {
    await openPanel('kimi');

    await temporaryChatButton().click();
    await page.waitForTimeout(RETRY_WINDOW_MS);

    const state = await fixtureState('kimi');
    expect(state.newChatClicks).toBe(1);
    expect(await messageCount('kimi', 'ENABLE_TEMP_CHAT')).toBe(0);
    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'true');
    await expect(temporaryChatButton()).toBeEnabled();
  });

  test('turning temporary chat off reloads Gemini on its normal URL', async () => {
    await openPanel('gemini');
    await temporaryChatButton().click();
    await expect.poll(geminiTemporaryChatOn).toBe(true);
    await expect(temporaryChatButton()).toBeEnabled();

    await temporaryChatButton().click();

    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => requestedUrls).toEqual([
      'https://gemini.google.com/',
      'https://gemini.google.com/',
    ]);
    await waitForFixtureReady('gemini');
    expect(await geminiTemporaryChatOn()).toBe(false);
  });

  test('turning temporary chat off starts another new chat for unsupported providers', async () => {
    await openPanel('kimi');
    await temporaryChatButton().click();
    await expect(temporaryChatButton()).toBeEnabled();

    await temporaryChatButton().click();

    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => (await fixtureState('kimi')).newChatClicks).toBe(2);
    expect(requestedUrls).toHaveLength(1);
  });

  test('new chat re-enables Gemini temporary chat without a reload', async () => {
    await openPanel('gemini', { tempButtonDelayMs: 300 });
    await temporaryChatButton().click();
    await expect.poll(geminiTemporaryChatOn).toBe(true);
    await expect(page.locator('#new-chat-btn')).toBeEnabled();

    await page.click('#new-chat-btn');
    // The fixture's in-page new chat resets the toggle; the retry turns it back on.
    await expect.poll(async () => (await fixtureState('gemini')).newChatClicks).toBe(2);
    await expect.poll(geminiTemporaryChatOn, { timeout: 10000 }).toBe(true);

    expect((await fixtureState('gemini')).tempChatClicks).toBe(2);
    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'true');
    expect(requestedUrls).toHaveLength(1);
  });

  test('new chat keeps ChatGPT on the temporary chat URL', async () => {
    await openPanel('chatgpt');

    await temporaryChatButton().click();
    await expect.poll(() => requestedUrls).toEqual([
      'https://chatgpt.com/',
      'https://chatgpt.com/?temporary-chat=true',
    ]);
    await expect(page.locator('#new-chat-btn')).toBeEnabled();

    await page.click('#new-chat-btn');

    await expect.poll(() => requestedUrls).toEqual([
      'https://chatgpt.com/',
      'https://chatgpt.com/?temporary-chat=true',
      'https://chatgpt.com/?temporary-chat=true',
    ]);
    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'true');
  });

  test('new chat re-activates Grok private mode in page', async () => {
    await openPanel('grok');

    await temporaryChatButton().click();
    await expect.poll(() => providerFrame('grok')?.url()).toBe('https://grok.com/c#private');
    await waitForFixtureReady('grok');
    await expect(page.locator('#new-chat-btn')).toBeEnabled();

    await page.click('#new-chat-btn');

    await expect.poll(async () => (await fixtureState('grok')).newChatClicks).toBe(1);
    await expect.poll(async () => (await fixtureState('grok')).tempChatClicks, { timeout: 10000 }).toBe(1);
    expect(providerFrame('grok').url()).toBe('https://grok.com/c#private');
    expect(requestedUrls).toEqual(['https://grok.com/', 'https://grok.com/c']);
    await expect(temporaryChatButton()).toHaveAttribute('aria-pressed', 'true');
  });

  test('a second new chat restarts the Gemini retry cycle', async () => {
    // The toggle never renders, so every scheduled retry reaches the page.
    await openPanel('gemini', { tempButtonDelayMs: 60000 });

    await temporaryChatButton().click();
    await page.click('#new-chat-btn');
    // The button stays disabled for 1s after a click.
    await expect(page.locator('#new-chat-btn')).toBeEnabled();
    const lastNewChatAt = Date.now();
    await page.click('#new-chat-btn');
    await page.waitForTimeout(RETRY_WINDOW_MS);

    const state = await fixtureState('gemini');
    const enableTimes = state.messages
      .filter((message) => message.type === 'ENABLE_TEMP_CHAT')
      .map((message) => message.at - lastNewChatAt)
      .filter((offset) => offset >= 0);

    expect(state.newChatClicks).toBe(3);
    // Only the last cycle's retries arrive after its click; the earlier
    // cycle's 2500ms and 4000ms retries were cancelled.
    expect(enableTimes).toHaveLength(TEMP_CHAT_RETRY_DELAYS.length);
    expect(Math.min(...enableTimes)).toBeGreaterThanOrEqual(TEMP_CHAT_RETRY_DELAYS[0] - 150);
  });
});
