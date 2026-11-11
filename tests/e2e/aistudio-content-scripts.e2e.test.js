import { test, expect } from '@playwright/test';
import { OPTIONAL_PROVIDER_CONFIGS } from '../../modules/optional-provider-access.js';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
} from './extension-harness.js';

const SAMPLE_IMAGE = {
  id: 'e2e-aistudio-image',
  name: 'sample.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
};

// Live AI Studio persists temporary mode in aiStudioUserPreference: ?temporary=true turns it on,
// a bare /prompts/new_chat keeps the last mode, and only ?temporary=false turns it off.
let aiStudioStickyTemporary = false;

function renderAiStudioFixture(requestUrl) {
  const url = new URL(requestUrl);
  const temporaryParam = url.searchParams.get('temporary');
  if (temporaryParam === 'true') {
    aiStudioStickyTemporary = true;
  } else if (temporaryParam === 'false') {
    aiStudioStickyTemporary = false;
  }
  const isTemporary = aiStudioStickyTemporary;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Google AI Studio Fixture</title>
  </head>
  <body>
    <div class="toolbar">
      <button type="button" data-test-incognito-toggle aria-label="Toggle temporary chat" mattooltip="Toggle temporary chat">Temp</button>
      <button type="button" data-test-clear="outside" aria-label="New chat" mattooltip="New chat">Clear</button>
    </div>
    ${isTemporary ? '<ms-incognito-mode-indicator><div class="incognito-banner">You\'re in a temporary chat</div></ms-incognito-mode-indicator>' : ''}
    <ms-chunk-editor class="ng-star-inserted">
      <section class="chunk-editor-main">
        <ms-chat-turn>
          <ms-autosize-textarea>
            <textarea
              id="turn-edit-textarea"
              class="textarea"
              placeholder="Edit prompt"
              rows="2"
              style="width:320px;height:48px"
            ></textarea>
          </ms-autosize-textarea>
        </ms-chat-turn>
        <footer class="ng-star-inserted">
          <ms-prompt-box>
            <div class="prompt-box-container" msfilecopypaste>
              <div class="text-wrapper">
                <ms-autosize-textarea>
                  <textarea
                    class="textarea"
                    formcontrolname="promptText"
                    aria-label="Enter a prompt"
                    placeholder="Start typing a prompt"
                    rows="3"
                    style="width:320px;height:64px"
                  ></textarea>
                </ms-autosize-textarea>
              </div>
              <div id="previews"></div>
              <ms-add-media-button>
                <button type="button" aria-label="Insert assets such as images, videos, files, or audio" mattooltip="Insert assets such as images, videos, files, or audio">Add</button>
              </ms-add-media-button>
              <ms-run-button>
                <button
                  id="aistudio-run-btn"
                  ms-button
                  type="submit"
                  class="ms-button-primary ctrl-enter-submits"
                  aria-disabled="false"
                  mattooltip="Send prompt (⌘ + Enter)"
                  aria-label="Run"
                  style="width:88px;height:36px"
                >
                  <span class="run-button-label">Run</span>
                  <span class="material-symbols-outlined">arrow_upward</span>
                </button>
              </ms-run-button>
            </div>
          </ms-prompt-box>
        </footer>
      </section>
    </ms-chunk-editor>
    <script>
      window.__sendCount = 0;
      window.__clearButtonClicks = 0;
      window.__tempToggleClicks = 0;
      window.__pastedFileNames = [];

      const runBtn = document.getElementById('aistudio-run-btn');
      const clearBtn = document.querySelector('button[data-test-clear="outside"]');
      const tempToggleBtn = document.querySelector('button[data-test-incognito-toggle]');
      const promptBox = document.querySelector('ms-prompt-box [msfilecopypaste]');

      runBtn.addEventListener('click', () => {
        window.__sendCount += 1;
      });
      clearBtn.addEventListener('click', () => {
        window.__clearButtonClicks += 1;
      });
      tempToggleBtn.addEventListener('click', () => {
        window.__tempToggleClicks += 1;
      });
      promptBox.addEventListener('paste', (event) => {
        const files = Array.from(event.clipboardData?.files || []);
        for (const file of files) {
          window.__pastedFileNames.push(file.name);
          const img = document.createElement('img');
          img.alt = file.name;
          img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=';
          document.getElementById('previews').append(img);
        }
      });
    </script>
  </body>
</html>`;
}

/**
 * Opens the fixture framed inside an extension page so the content script
 * accepts postMessage commands from the extension origin.
 */
async function openFramedFixture(extension, url) {
  const page = await extension.context.newPage();
  await page.goto(extension.extensionUrl('options/options.html'));
  await page.evaluate((src) => {
    document.body.replaceChildren();
    const iframe = document.createElement('iframe');
    iframe.id = 'fixture-frame';
    iframe.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0';
    iframe.src = src;
    document.body.append(iframe);
  }, url);
  const frame = await (await page.waitForSelector('#fixture-frame')).contentFrame();
  await frame.waitForLoadState('domcontentloaded');
  await frame.waitForSelector('ms-prompt-box textarea[formcontrolname="promptText"]');
  return { page, frame };
}

function postPanelMessage(page, payload) {
  return page.evaluate((data) => {
    document.getElementById('fixture-frame').contentWindow
      .postMessage({ context: 'multi-panel', ...data }, '*');
  }, payload);
}

async function ensureAiStudioEnabledAndRegistered(extension, enabledProviders = ['aistudio']) {
  await extension.serviceWorker.evaluate(async (providers) => {
    await chrome.storage.sync.set({
      enabledProviders: providers,
      providerOrder: providers,
      multiPanelProviders: providers,
    });
  }, enabledProviders);

  const shouldBeRegistered = enabledProviders.includes('aistudio');
  await expect.poll(async () => {
    return extension.serviceWorker.evaluate(async () => {
      const scripts = await chrome.scripting.getRegisteredContentScripts();
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      return {
        scriptRegistered: scripts.some(({ id }) => id === 'aistudio-scripts'),
        ruleRegistered: rules.some(({ id }) => id === 1005),
      };
    });
  }).toEqual({
    scriptRegistered: shouldBeRegistered,
    ruleRegistered: shouldBeRegistered,
  });
}

test.describe('Google AI Studio production content scripts', () => {
  test.setTimeout(60000);

  let extension;
  let extensionCopy;
  let requestedUrls = [];

  test.beforeAll(async () => {
    extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(...OPTIONAL_PROVIDER_CONFIGS.aistudio.origins);
    });

    extension = await launchExtension({
      extensionPath: extensionCopy.extensionPath,
      viewport: { width: 1280, height: 800 },
    });

    await extension.context.route('https://aistudio.google.com/**', (route) => {
      const url = route.request().url();
      requestedUrls.push(url);
      route.fulfill({
        contentType: 'text/html; charset=utf-8',
        body: renderAiStudioFixture(url),
      });
    });

    await ensureAiStudioEnabledAndRegistered(extension, ['aistudio']);
  });

  test.beforeEach(async () => {
    requestedUrls = [];
    aiStudioStickyTemporary = false;
    await ensureAiStudioEnabledAndRegistered(extension, ['aistudio']);
    await extension.serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        enterKeyBehavior: {
          enabled: true,
          preset: 'default',
          newlineModifiers: { shift: true, ctrl: false, alt: false, meta: false },
          sendModifiers: { shift: false, ctrl: false, alt: false, meta: false },
        },
      });
    });
  });

  test.afterAll(async () => {
    await extension?.close();
    await extensionCopy?.cleanup();
  });

  test('registers optional provider permissions, dynamic content scripts, and settings card for aistudio', async () => {
    const page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('options/options.html'));
    const providers = page.locator('.provider-item');
    await expect(providers).toHaveCount(14);

    const aistudioCard = page.locator('.provider-item[data-provider-id="aistudio"]');
    await expect(aistudioCard).toBeVisible();
    await expect(aistudioCard).toHaveAttribute('data-has-access', 'true');
    await expect(aistudioCard.locator('.toggle-switch')).toHaveClass(/active/);

    const scriptDetails = await extension.serviceWorker.evaluate(async () => {
      const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: ['aistudio-scripts'] });
      const permissionGranted = await chrome.permissions.contains({
        origins: [
          'https://aistudio.google.com/*',
          'https://alkalimakersuite-pa.clients6.google.com/*',
        ],
      });
      return {
        permissionGranted,
        matches: scripts[0]?.matches || [],
        js: scripts[0]?.js || [],
      };
    });

    expect(scriptDetails).toEqual({
      permissionGranted: true,
      matches: ['https://aistudio.google.com/*'],
      js: [
        'content-scripts/button-finder-utils.js',
        'content-scripts/enter-behavior-utils.js',
        'content-scripts/enter-behavior-aistudio.js',
        'content-scripts/text-injection-all-providers.js',
        'content-scripts/focus-toggle.js',
      ],
    });

    // Disabling aistudio unregisters the content script and frame rule; re-enabling restores them.
    await ensureAiStudioEnabledAndRegistered(extension, ['chatgpt']);
    await ensureAiStudioEnabledAndRegistered(extension, ['aistudio']);

    await page.close();
  });

  test('loads normal URL /prompts/new_chat?temporary=false and switches to ?temporary=true and back on Privacy Mode toggle', async () => {
    const page = await openMultiPanel(extension, { providers: ['aistudio'] });
    const tempBtn = page.locator('#temporary-chat-btn');

    await expect.poll(() => requestedUrls).toEqual([
      'https://aistudio.google.com/prompts/new_chat?temporary=false',
    ]);

    const panelFrame = () => page.frames().find(
      (frame) => URL.canParse(frame.url()) && new URL(frame.url()).host === 'aistudio.google.com'
    );
    await expect.poll(() => panelFrame()?.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');

    // Toggle Privacy Mode ON -> switches iframe to ?temporary=true
    await tempBtn.click();
    await expect(tempBtn).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => panelFrame()?.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=true');
    await expect(page.frameLocator('#panel-grid iframe').locator('ms-incognito-mode-indicator')).toBeVisible();
    await expect(tempBtn).toBeEnabled();

    // Toggle Privacy Mode OFF -> must opt out explicitly because AI Studio keeps temporary mode sticky
    await tempBtn.click();
    await expect(tempBtn).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => panelFrame()?.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    await expect(page.frameLocator('#panel-grid iframe').locator('ms-incognito-mode-indicator')).toHaveCount(0);

    await page.close();
  });

  test('injects prompt text, pastes multimodal images, and clicks ms-run-button when idle while refusing when in Stop/.spin state', async () => {
    const { page, frame } = await openFramedFixture(
      extension,
      'https://aistudio.google.com/prompts/new_chat'
    );
    const editor = frame.locator('ms-prompt-box textarea[formcontrolname="promptText"]');
    const runBtn = frame.locator('#aistudio-run-btn');

    await postPanelMessage(page, {
      type: 'INJECT_TEXT',
      text: 'Summarize Gemini 2.5 architecture',
      autoSubmit: false,
    });
    await expect(editor).toHaveValue('Summarize Gemini 2.5 architecture');
    expect(await frame.evaluate(() => window.__sendCount)).toBe(0);

    await postPanelMessage(page, { type: 'CLEAR_INPUT' });
    await expect(editor).toHaveValue('');

    await postPanelMessage(page, {
      type: 'INJECT_TEXT',
      text: 'Run this prompt now',
      autoSubmit: true,
    });
    await expect(editor).toHaveValue('Run this prompt now');
    await expect.poll(() => frame.evaluate(() => window.__sendCount)).toBe(1);

    await postPanelMessage(page, { type: 'CLEAR_INPUT' });
    await expect(editor).toHaveValue('');

    // Multimodal image paste into ms-prompt-box [msfilecopypaste]
    await postPanelMessage(page, {
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: 'Inspect this diagram',
      autoSubmit: false,
      requestId: 'aistudio-image-e2e',
    });
    await expect(frame.locator('img[alt="sample.png"]')).toBeVisible();
    await expect(editor).toHaveValue('Inspect this diagram');

    await postPanelMessage(page, { type: 'CLEAR_INPUT' });
    await expect(editor).toHaveValue('');

    // Switch ms-run-button to active generation Stop/.spin state and verify guard
    await runBtn.evaluate((button) => {
      button.setAttribute('aria-label', 'Stop');
      button.setAttribute('mattooltip', 'Cancel generation');
      button.innerHTML = `
        <span class="run-button-label">Stop</span>
        <span class="material-symbols-outlined spin">progress_activity</span>
      `;
    });

    await editor.focus();
    await page.keyboard.press('Enter');
    await postPanelMessage(page, {
      type: 'INJECT_TEXT',
      text: 'Queued while streaming',
      autoSubmit: true,
    });
    await postPanelMessage(page, {
      type: 'TRIGGER_SEND',
    });
    await page.waitForTimeout(800);

    expect(await frame.evaluate(() => window.__sendCount)).toBe(1);
    await expect(editor).toHaveValue('Queued while streaming');

    await page.close();
  });

  test('navigates directly on NEW_CHAT to /prompts/new_chat (normal) vs /prompts/new_chat?temporary=true (privacy mode)', async () => {
    const { page, frame } = await openFramedFixture(
      extension,
      'https://aistudio.google.com/prompts/saved-conversation-123'
    );

    // Normal mode NEW_CHAT -> /prompts/new_chat?temporary=false without clicking clear button modal trigger
    await postPanelMessage(page, {
      type: 'NEW_CHAT',
      temporaryChat: false,
    });
    await expect.poll(() => frame.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    await frame.waitForSelector('ms-prompt-box textarea[formcontrolname="promptText"]');
    expect(await frame.evaluate(() => window.__clearButtonClicks)).toBe(0);

    // Privacy mode NEW_CHAT -> /prompts/new_chat?temporary=true
    await postPanelMessage(page, {
      type: 'NEW_CHAT',
      temporaryChat: true,
    });
    await expect.poll(() => frame.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=true');
    await frame.waitForSelector('ms-incognito-mode-indicator');
    expect(await frame.evaluate(() => window.__clearButtonClicks)).toBe(0);

    // Subsequent NEW_CHAT while already in temporary chat stays in ?temporary=true
    await postPanelMessage(page, {
      type: 'NEW_CHAT',
    });
    await expect.poll(() => frame.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=true');
    await frame.waitForSelector('ms-incognito-mode-indicator');

    // Explicit temporaryChat: false opts out of sticky temporary mode
    await postPanelMessage(page, {
      type: 'NEW_CHAT',
      temporaryChat: false,
    });
    await expect.poll(() => frame.url()).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    await expect.poll(() => frame.locator('ms-incognito-mode-indicator').count()).toBe(0);

    await page.close();
  });

  test('customizes Enter and Shift+Enter behavior on ms-prompt-box textarea without intercepting turn-edit textareas', async () => {
    const { page, frame } = await openFramedFixture(
      extension,
      'https://aistudio.google.com/prompts/new_chat'
    );
    const editor = frame.locator('ms-prompt-box textarea[formcontrolname="promptText"]');
    const turnEdit = frame.locator('#turn-edit-textarea');

    // Pressing Enter inside a turn-edit ms-autosize-textarea outside ms-prompt-box must not click Run
    await turnEdit.fill('Turn line 1');
    await turnEdit.focus();
    await page.keyboard.press('Enter');
    await expect(turnEdit).toHaveValue('Turn line 1\n');
    expect(await frame.evaluate(() => window.__sendCount)).toBe(0);

    await editor.fill('Line 1');
    await editor.focus();

    // Default preset: Shift+Enter inserts newline, plain Enter clicks Run
    await page.keyboard.press('Shift+Enter');
    await expect(editor).toHaveValue('Line 1\n');
    expect(await frame.evaluate(() => window.__sendCount)).toBe(0);

    await page.keyboard.press('Enter');
    await expect.poll(() => frame.evaluate(() => window.__sendCount)).toBe(1);

    // Switch to swapped preset: plain Enter inserts newline, Shift+Enter clicks Run
    await extension.serviceWorker.evaluate(async () => {
      await chrome.storage.sync.set({
        enterKeyBehavior: {
          enabled: true,
          preset: 'swapped',
          newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
          sendModifiers: { shift: true, ctrl: false, alt: false, meta: false },
        },
      });
    });
    await page.waitForTimeout(150);

    await editor.fill('Swapped line');
    await editor.focus();
    await page.keyboard.press('Enter');
    await expect(editor).toHaveValue('Swapped line\n');
    expect(await frame.evaluate(() => window.__sendCount)).toBe(1);

    await page.keyboard.press('Shift+Enter');
    await expect.poll(() => frame.evaluate(() => window.__sendCount)).toBe(2);

    await page.close();
  });
});
