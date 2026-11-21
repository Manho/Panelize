import { test, expect } from '@playwright/test';
import { getTabUrls, launchExtension, openMultiPanel } from './extension-harness.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

function renderGeminiAccountFixture(urlString) {
  const parsed = new URL(urlString);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gemini ${parsed.pathname}</title></head>
<body>
  <header>
    <div id="current-path">${parsed.pathname}${parsed.search}</div>
    <a id="switch-account-u1" href="https://gemini.google.com/u/1/app?pageId=none" target="_blank">Switch to account 1</a>
    <a id="external-help" href="https://support.google.com/gemini" target="_blank">Help</a>
  </header>
  <div class="input-area-container">
    <div class="ql-editor" contenteditable="true" role="textbox" aria-label="Enter a prompt here"></div>
    <button type="button" aria-label="Send message">Send</button>
  </div>
</body>
</html>`;
}

function renderDeepSeekFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DeepSeek fixture</title></head>
<body>
  <!-- Inline-edit / hidden textarea earlier in DOM order -->
  <textarea id="stale-inline-edit" name="user query" style="display:none">old turn</textarea>
  <main id="deepseek-composer" class="_77cefa5">
    <textarea id="deepseek-editor" placeholder="Message DeepSeek" rows="2"></textarea>
    <input id="deepseek-file" type="file" multiple accept=".png,.jpg,.jpeg,.webp" style="display:none" />
    <div id="deepseek-previews"></div>
    <button id="deepseek-clear-user" type="button">User Clear</button>
    <div role="button" tabindex="0" id="deepseek-send"
      class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m ds-button--disabled">
      Send
    </div>
  </main>
  <script>
    const editor = document.getElementById('deepseek-editor');
    const fileInput = document.getElementById('deepseek-file');
    const previews = document.getElementById('deepseek-previews');
    const sendBtn = document.getElementById('deepseek-send');
    const clearBtn = document.getElementById('deepseek-clear-user');

    window.__fixture = {
      reactStateText: '',
      uploadedFiles: [],
      sentPayloads: [],
    };

    // Emulate React's controlled textarea _valueTracker
    let tracked = '';
    editor._valueTracker = {
      getValue: () => tracked,
      setValue: (val) => { tracked = String(val); },
    };

    function syncSendButton() {
      const hasContent = window.__fixture.reactStateText.trim().length > 0 || previews.children.length > 0;
      sendBtn.classList.toggle('ds-button--disabled', !hasContent);
    }

    editor.addEventListener('input', () => {
      if (editor._valueTracker.getValue() !== editor.value) {
        editor._valueTracker.setValue(editor.value);
        window.__fixture.reactStateText = editor.value;
        setTimeout(syncSendButton, 150);
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      window.__fixture.uploadedFiles.push(file.name);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.setAttribute('aria-label', file.name);
      const img = document.createElement('img');
      img.alt = file.name;
      img.src = 'blob:https://chat.deepseek.com/' + encodeURIComponent(file.name);
      chip.appendChild(img);
      previews.appendChild(chip);
      syncSendButton();
    });

    clearBtn.addEventListener('click', () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, '');
      // Deliberately leave _valueTracker stale on the previous prompt to test tracker reset
      window.__fixture.reactStateText = '';
      previews.innerHTML = '';
      syncSendButton();
    });

    sendBtn.addEventListener('click', () => {
      if (sendBtn.classList.contains('ds-button--disabled')) return;
      window.__fixture.sentPayloads.push({
        text: window.__fixture.reactStateText,
        previewCount: previews.children.length,
      });
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(editor, '');
      editor._valueTracker.setValue('');
      window.__fixture.reactStateText = '';
      previews.innerHTML = '';
      syncSendButton();
    });
  </script>
</body>
</html>`;
}

function renderKimiFixture({ failFirstImageUpload = false } = {}) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Kimi fixture</title></head>
<body>
  <div id="chat-box">
    <div class="chat-editor">
      <div class="chat-input-editor" contenteditable="true" data-lexical-editor="true" role="textbox"></div>
      <div class="toolkit-trigger-btn" data-testid="toolkit-trigger-btn" role="button">+</div>
      <input class="hidden-input" type="file" multiple style="display:none" />
      <div id="kimi-previews"></div>
      <div class="send-button-container disabled">
        <div class="send-icon-inner">Send</div>
      </div>
    </div>
  </div>
  <script>
    const editor = document.querySelector('.chat-input-editor');
    const fileInput = document.querySelector('input.hidden-input');
    const previews = document.getElementById('kimi-previews');
    const sendContainer = document.querySelector('.send-button-container');
    let failNextUpload = ${failFirstImageUpload ? 'true' : 'false'};

    window.__fixture = {
      allowUploadSuccess: !failNextUpload,
      uploadedFiles: [],
      sentPayloads: [],
      prematureDisabledClicks: 0,
    };

    function syncSendState() {
      const hasReadyText = (editor.textContent || '').trim().length > 0;
      const hasReadyImage = previews.querySelectorAll('.image-thumbnail.success').length > 0;
      sendContainer.classList.toggle('disabled', !(hasReadyText || hasReadyImage));
    }

    // Emulate Lexical paste handling all multiline text atomically and enabling send asynchronously
    editor.addEventListener('paste', (event) => {
      const text = event.clipboardData?.getData('text/plain');
      if (typeof text === 'string' && text.length > 0) {
        event.preventDefault();
        Promise.resolve().then(() => {
          editor.textContent = (editor.textContent || '') + text;
          setTimeout(syncSendState, 250);
        });
      }
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      window.__fixture.uploadedFiles.push(file.name);
      const thumb = document.createElement('div');
      const status = window.__fixture.allowUploadSuccess ? 'success' : 'error';
      thumb.className = 'image-thumbnail middle ' + status;
      const wrapper = document.createElement('div');
      wrapper.className = 'image-wrapper image-detail';
      const img = document.createElement('img');
      img.className = 'image-main';
      img.src = status === 'success'
        ? 'https://www.kimi.com/apiv2-files/sign-obj/' + encodeURIComponent(file.name)
        : 'https://statics.moonshot.cn/kimi-upload-error/' + encodeURIComponent(file.name);
      wrapper.appendChild(img);
      thumb.appendChild(wrapper);
      previews.appendChild(thumb);
      syncSendState();
    });

    sendContainer.addEventListener('click', () => {
      if (sendContainer.classList.contains('disabled')) {
        window.__fixture.prematureDisabledClicks += 1;
        return;
      }
      window.__fixture.sentPayloads.push({
        text: editor.textContent,
        previewCount: previews.querySelectorAll('.image-thumbnail.success').length,
      });
      editor.textContent = '';
      previews.innerHTML = '';
      syncSendState();
    });
  </script>
</body>
</html>`;
}

test('Gemini multi-account selector and in-frame /u/1/app account link stay inside Panelize without opening a new tab', async ({}, testInfo) => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  try {
    await extension.context.route(/^https:\/\/gemini\.google\.com(\/|$)/, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: renderGeminiAccountFixture(route.request().url()),
      })
    );

    const page = await openMultiPanel(extension, { providers: ['gemini'], layout: '1x1' });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const accountSelect = page.locator('.panel-gemini-account-select');
    await expect(accountSelect).toBeVisible();
    await expect(accountSelect).toHaveValue('');

    const panelFrame = page.frameLocator('iframe');
    await expect(panelFrame.locator('#current-path')).toHaveText('/');

    const tabCountBeforeClick = (await getTabUrls(page)).length;

    // Clicking a target="_blank" /u/1/app?pageId=none link inside Gemini navigates in-frame instead of spawning an external tab
    await panelFrame.locator('#switch-account-u1').click();
    await expect(panelFrame.locator('#current-path')).toHaveText('/u/1/app?pageId=none');
    await expect(accountSelect).toHaveValue('1');
    expect((await getTabUrls(page)).length).toBe(tabCountBeforeClick);

    // Switching the header dropdown to /u/2 navigates the panel iframe to /u/2/app
    await accountSelect.selectOption('2');
    await expect(panelFrame.locator('#current-path')).toHaveText('/u/2/app');

    // Also verify narrow/mobile viewport rendering of header controls
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(accountSelect).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('gemini-multi-account-mobile.png'), fullPage: true });

    expect(pageErrors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('Send All delivers full 10-line prompts to Kimi & DeepSeek and re-populates cleared DeepSeek on Send All retry', async ({}, testInfo) => {
  test.setTimeout(90000);
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  try {
    await extension.context.route('https://chat.deepseek.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: renderDeepSeekFixture() })
    );
    await extension.context.route('https://www.kimi.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: renderKimiFixture({ failFirstImageUpload: true }) })
    );

    const page = await openMultiPanel(extension, { providers: ['deepseek', 'kimi'], layout: '1x2' });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const readProviderState = (host) => {
      const frame = page.frames().find((candidate) => candidate.url().startsWith(`https://${host}/`));
      return frame ? frame.evaluate(() => window.__fixture).catch(() => null) : null;
    };

    await expect.poll(async () => Boolean(await readProviderState('chat.deepseek.com'))).toBe(true);
    await expect.poll(async () => Boolean(await readProviderState('www.kimi.com'))).toBe(true);

    // Part 1: 10-line plain-text Send All -> both DeepSeek and Kimi must receive all 10/10 lines and auto-submit cleanly
    const tenLines = Array.from({ length: 10 }, (_, idx) => `Step ${idx + 1}: Verify full prompt delivery`).join('\n');
    await page.locator('#unified-input').fill(tenLines);
    await page.locator('#send-all-btn').click();

    await expect.poll(async () => (await readProviderState('chat.deepseek.com'))?.sentPayloads).toEqual([
      { text: tenLines, previewCount: 0 },
    ]);
    await expect.poll(async () => (await readProviderState('www.kimi.com'))?.sentPayloads).toEqual([
      { text: tenLines, previewCount: 0 },
    ]);
    expect((await readProviderState('www.kimi.com')).prematureDisabledClicks).toBe(0);

    // Part 2: Image + prompt fill where Kimi fails on Pass 1, user deletes DeepSeek's prompt, and clicks Send All again
    await page.locator('#image-file-input').setInputFiles({
      name: 'diagram.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });
    await expect(page.locator('.image-preview-item').first()).toBeVisible();
    await page.locator('#unified-input').fill('Compare architecture diagram');
    await page.locator('#send-all-btn').click();

    // Pass 1 settles with DeepSeek filled and Kimi failed (preview-timeout)
    await expect(page.locator('#send-status')).toHaveText('Filled 1/2; 1 failed', { timeout: 15000 });
    expect((await readProviderState('chat.deepseek.com')).reactStateText).toBe('Compare architecture diagram');

    // User deletes the prompt & preview inside DeepSeek, then Kimi becomes healthy and user clicks Send All again
    const deepseekFrame = page.frameLocator('iframe[src*="deepseek"]');
    await deepseekFrame.locator('#deepseek-clear-user').click();
    expect((await readProviderState('chat.deepseek.com')).reactStateText).toBe('');

    const kimiFrameObj = page.frames().find((candidate) => candidate.url().startsWith('https://www.kimi.com/'));
    await kimiFrameObj.evaluate(() => {
      document.getElementById('kimi-previews').innerHTML = '';
      window.__fixture.allowUploadSuccess = true;
    });

    await page.locator('#send-all-btn').click();
    await expect(page.locator('#send-status')).toHaveText('Filled 2 inputs', { timeout: 15000 });

    // Cleared DeepSeek must be re-populated with both the prompt and image, not left null!
    expect((await readProviderState('chat.deepseek.com')).reactStateText).toBe('Compare architecture diagram');

    // Clicking Send All now triggers send across both filled panels
    await page.locator('#send-all-btn').click();
    await expect.poll(async () => (await readProviderState('chat.deepseek.com'))?.sentPayloads.at(-1)).toEqual({
      text: 'Compare architecture diagram',
      previewCount: 1,
    });
    await expect.poll(async () => (await readProviderState('www.kimi.com'))?.sentPayloads.at(-1)).toEqual({
      text: 'Compare architecture diagram',
      previewCount: 1,
    });

    await page.screenshot({ path: testInfo.outputPath('deepseek-kimi-send-all-desktop.png'), fullPage: true });
    expect(pageErrors).toEqual([]);
  } finally {
    await extension.close();
  }
});
