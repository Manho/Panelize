import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

test('switching between Tab Mode and Popup Mode preserves live chat state without reloading', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://chatgpt.com/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: renderChatgptFixture({ composer: 'current' })
    }));

    // Keep another tab open in the initial normal window so it stays alive after popout.
    const companionTab = await extension.context.newPage();
    await companionTab.goto('about:blank');

    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const panel = page.frameLocator('iframe');
    const editor = panel.locator('[data-composer-placement="thread"] [data-composer-markdown]');
    await expect(editor).toBeVisible();

    const getProviderFrame = () =>
      page.frames().find((candidate) => candidate.url().startsWith('https://chatgpt.com/'));

    const initialMeta = await page.evaluate(async () => {
      window.__panelizeHostSessionToken = 'host-session-alive';
      const [win, tab] = await Promise.all([
        chrome.windows.getCurrent(),
        chrome.tabs.getCurrent()
      ]);
      return { windowId: win.id, windowType: win.type, tabId: tab.id };
    });
    expect(initialMeta.windowType).toBe('normal');

    const providerFrame = getProviderFrame();
    expect(providerFrame).toBeTruthy();
    await providerFrame.evaluate(() => {
      window.__providerChatSessionToken = 'iframe-session-alive';
    });

    // Turn 1: send a message before switching modes, plus keep an unsent draft in the unified input.
    await page.locator('#unified-input').fill('First turn before popup');
    await page.locator('#send-all-btn').click();
    await expect.poll(async () => (await getProviderFrame()?.evaluate(() => window.__fixture?.sentTexts)) ?? null)
      .toEqual(['First turn before popup']);

    await page.locator('#unified-input').fill('Draft preserved across mode switch');

    // Switch Tab Mode -> Popup Mode
    await page.locator('#toggle-open-mode-btn').click();

    await expect.poll(async () => page.evaluate(async () => {
      const win = await chrome.windows.getCurrent();
      return win.type;
    })).toBe('popup');

    const popupState = await page.evaluate(async () => {
      const [win, tab, syncSettings, sessionState, localState] = await Promise.all([
        chrome.windows.getCurrent(),
        chrome.tabs.getCurrent(),
        chrome.storage.sync.get({ openMode: null }),
        chrome.storage.session.get('preservedState'),
        chrome.storage.local.get('preservedState')
      ]);
      return {
        hostToken: window.__panelizeHostSessionToken,
        windowType: win.type,
        windowId: win.id,
        tabId: tab.id,
        openMode: syncSettings.openMode,
        toggleIcon: document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent,
        draft: document.getElementById('unified-input')?.value,
        hasSessionPreservedState: Boolean(sessionState.preservedState),
        hasLocalPreservedState: Boolean(localState.preservedState)
      };
    });

    expect(popupState.hostToken).toBe('host-session-alive');
    expect(popupState.windowType).toBe('popup');
    expect(popupState.tabId).toBe(initialMeta.tabId);
    expect(popupState.openMode).toBe('popup');
    expect(popupState.toggleIcon).toBe('tab');
    expect(popupState.draft).toBe('Draft preserved across mode switch');
    expect(popupState.hasSessionPreservedState).toBe(false);
    expect(popupState.hasLocalPreservedState).toBe(false);

    const frameStateInPopup = await getProviderFrame().evaluate(() => ({
      token: window.__providerChatSessionToken,
      sentTexts: window.__fixture.sentTexts
    }));
    expect(frameStateInPopup).toEqual({
      token: 'iframe-session-alive',
      sentTexts: ['First turn before popup']
    });

    // Turn 2: continue chatting inside Popup Mode
    await page.locator('#unified-input').fill('Second turn inside popup');
    await page.locator('#send-all-btn').click();
    await expect.poll(async () => (await getProviderFrame()?.evaluate(() => window.__fixture?.sentTexts)) ?? null)
      .toEqual(['First turn before popup', 'Second turn inside popup']);

    // Switch Popup Mode -> Tab Mode
    await page.locator('#toggle-open-mode-btn').click();

    await expect.poll(async () => page.evaluate(async () => {
      const win = await chrome.windows.getCurrent();
      return win.type;
    })).toBe('normal');

    const backInTabState = await page.evaluate(async () => {
      const [win, tab, syncSettings] = await Promise.all([
        chrome.windows.getCurrent(),
        chrome.tabs.getCurrent(),
        chrome.storage.sync.get({ openMode: null })
      ]);
      return {
        hostToken: window.__panelizeHostSessionToken,
        windowType: win.type,
        windowId: win.id,
        tabId: tab.id,
        openMode: syncSettings.openMode,
        toggleIcon: document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent
      };
    });

    expect(backInTabState.hostToken).toBe('host-session-alive');
    expect(backInTabState.windowType).toBe('normal');
    expect(backInTabState.windowId).toBe(initialMeta.windowId);
    expect(backInTabState.tabId).toBe(initialMeta.tabId);
    expect(backInTabState.openMode).toBe('tab');
    expect(backInTabState.toggleIcon).toBe('open_in_new');

    const frameStateBackInTab = await getProviderFrame().evaluate(() => ({
      token: window.__providerChatSessionToken,
      sentTexts: window.__fixture.sentTexts
    }));
    expect(frameStateBackInTab).toEqual({
      token: 'iframe-session-alive',
      sentTexts: ['First turn before popup', 'Second turn inside popup']
    });

    // Turn 3: continue chatting after returning to Tab Mode
    await page.locator('#unified-input').fill('Third turn back in tab');
    await page.locator('#send-all-btn').click();
    await expect.poll(async () => (await getProviderFrame()?.evaluate(() => window.__fixture?.sentTexts)) ?? null)
      .toEqual([
        'First turn before popup',
        'Second turn inside popup',
        'Third turn back in tab'
      ]);
  } finally {
    await extension.close();
  }
});

test('returning from Popup Mode to Tab Mode creates a normal window without reload when no normal window exists', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://chatgpt.com/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: renderChatgptFixture({ composer: 'current' })
    }));

    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const panel = page.frameLocator('iframe');
    await expect(panel.locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();

    const getProviderFrame = () =>
      page.frames().find((candidate) => candidate.url().startsWith('https://chatgpt.com/'));

    await page.evaluate(() => {
      window.__panelizeHostSessionToken = 'solo-popup-alive';
    });
    await getProviderFrame().evaluate(() => {
      window.__providerChatSessionToken = 'solo-iframe-alive';
    });

    // Switch to Popup Mode
    await page.locator('#toggle-open-mode-btn').click();
    await expect.poll(async () => page.evaluate(async () => (await chrome.windows.getCurrent()).type))
      .toBe('popup');

    // Close every remaining normal window so none exist
    await page.evaluate(async () => {
      const normalWindows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      for (const win of normalWindows) {
        await chrome.windows.remove(win.id);
      }
    });

    // Switch back to Tab Mode with zero normal windows open
    await page.locator('#toggle-open-mode-btn').click();
    await expect.poll(async () => page.evaluate(async () => (await chrome.windows.getCurrent()).type))
      .toBe('normal');

    const result = await page.evaluate(async () => ({
      hostToken: window.__panelizeHostSessionToken,
      windowType: (await chrome.windows.getCurrent()).type,
      toggleIcon: document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent
    }));
    const frameToken = await getProviderFrame().evaluate(() => window.__providerChatSessionToken);

    expect(result).toEqual({
      hostToken: 'solo-popup-alive',
      windowType: 'normal',
      toggleIcon: 'open_in_new'
    });
    expect(frameToken).toBe('solo-iframe-alive');
  } finally {
    await extension.close();
  }
});
