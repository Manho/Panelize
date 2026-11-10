import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

// A page on an unrelated origin that holds a window reference to ChatGPT,
// either as a popup it opened or as a frame it embeds, and messages it the
// way the Multi-Panel page does.
const THIRD_PARTY_URL = 'https://third-party.test/';
const THIRD_PARTY_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Third party</title></head>
<body>
  <button id="open" type="button">Open</button>
  <iframe id="frame" width="900" height="500"></iframe>
  <script>
    document.getElementById('open').addEventListener('click', () => {
      window.popup = window.open('https://chatgpt.com/');
    });
    window.postPanelMessages = (target, text) => {
      const messages = [
        { type: 'INJECT_TEXT', text, autoSubmit: true },
        { type: 'INJECT_TEXT_WITH_IMAGES', text, images: [], autoSubmit: true, requestId: 'third-party' },
        { type: 'TRIGGER_SEND', requestId: 'third-party' },
        { type: 'NEW_CHAT' },
      ];
      messages.forEach((message) => target.postMessage({ ...message, context: 'multi-panel' }, '*'));
    };
  </script>
</body></html>`;

// Long enough for an accepted INJECT_TEXT with autoSubmit to reach Send.
const SETTLE_MS = 2500;

async function routeFixtures(context) {
  await context.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html', body: renderChatgptFixture({ composer: 'current' }),
  }));
  await context.route(`${THIRD_PARTY_URL}**`, route => route.fulfill({
    contentType: 'text/html', body: THIRD_PARTY_PAGE,
  }));
}

function readFixture(frameOrPage) {
  return frameOrPage.evaluate(() => ({
    ...window.__fixture,
    composerText: document.querySelector('[data-composer-placement="thread"] [data-composer-markdown]')
      ?.textContent ?? null,
  }));
}

function expectUntouched(state) {
  expect(state.sentTexts).toEqual([]);
  expect(state.sends).toBe(0);
  expect(state.newChats).toBe(0);
  expect(state.straySends).toEqual([]);
  expect(state.composerText).toBe('');
}

test('a third-party page cannot type or send prompts in a ChatGPT tab it opened', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await routeFixtures(extension.context);
    const page = await extension.context.newPage();
    await page.goto(THIRD_PARTY_URL);

    const [popup] = await Promise.all([
      extension.context.waitForEvent('page'),
      page.locator('#open').click(),
    ]);
    await popup.waitForLoadState('load');
    await expect(popup.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();

    await page.evaluate(() => window.postPanelMessages(window.popup, 'Third-party prompt via window.open'));
    await popup.waitForTimeout(SETTLE_MS);
    expectUntouched(await readFixture(popup));

    // The same fixture still accepts Send All from the real Multi-Panel page.
    const multiPanel = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const panel = multiPanel.frameLocator('#panel-grid iframe');
    await expect(panel.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();
    await multiPanel.locator('#unified-input').fill('Prompt from Multi-Panel');
    await multiPanel.locator('#send-all-btn').click();
    const panelFrame = () => multiPanel.frames().find(frame => frame.url().startsWith('https://chatgpt.com/'));
    await expect.poll(async () => (await readFixture(panelFrame()))?.sentTexts)
      .toEqual(['Prompt from Multi-Panel']);

    expectUntouched(await readFixture(popup));
  } finally {
    await extension.close();
  }
});

test('a third-party page cannot type or send prompts in a ChatGPT frame it embeds', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await routeFixtures(extension.context);
    const page = await extension.context.newPage();
    await page.goto(THIRD_PARTY_URL);
    await page.evaluate(() => { document.getElementById('frame').src = 'https://chatgpt.com/'; });
    const frame = page.frameLocator('#frame');
    await expect(frame.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();
    const chatgptFrame = page.frames().find(candidate => candidate.url().startsWith('https://chatgpt.com/'));

    await page.evaluate(() => window.postPanelMessages(
      document.getElementById('frame').contentWindow,
      'Third-party prompt via iframe'
    ));
    await page.waitForTimeout(SETTLE_MS);
    expectUntouched(await readFixture(chatgptFrame));
  } finally {
    await extension.close();
  }
});

test('Send All reaches a ChatGPT panel once after it moves to the other ChatGPT origin', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await routeFixtures(extension.context);
    await extension.context.route('https://chat.openai.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderChatgptFixture({ composer: 'current' }),
    }));
    const multiPanel = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const panel = multiPanel.frameLocator('#panel-grid iframe');
    await expect(panel.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();

    const frameOn = (origin) => multiPanel.frames().find(frame => frame.url().startsWith(`${origin}/`));
    await frameOn('https://chatgpt.com').evaluate(() => { window.location.href = 'https://chat.openai.com/'; });
    await expect.poll(() => Boolean(frameOn('https://chat.openai.com'))).toBe(true);
    await expect(panel.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();

    await multiPanel.locator('#unified-input').fill('Prompt after redirect');
    await multiPanel.locator('#send-all-btn').click();
    await expect.poll(async () => (await readFixture(frameOn('https://chat.openai.com')))?.sentTexts)
      .toEqual(['Prompt after redirect']);
    await multiPanel.waitForTimeout(SETTLE_MS);
    const state = await readFixture(frameOn('https://chat.openai.com'));
    expect(state.sentTexts).toEqual(['Prompt after redirect']);
    // Multi-Panel posts to both ChatGPT origins; the browser delivers only
    // the one matching the frame, so the prompt is sent exactly once.
    expect(state.sends).toBe(1);
    expect(state.straySends).toEqual([]);
  } finally {
    await extension.close();
  }
});
