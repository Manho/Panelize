import { test, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserLaunchOptions } from './browser-launch-options.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SOURCE_EXTENSION_PATH = path.resolve(__dirname, '../..');

const SAMPLE_IMAGE = {
  id: 'e2e-image',
  name: 'sample.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
};

const YUANBAO_FIXTURE = `<!doctype html>
<html>
  <body>
    <div id="composer">
      <div class="chat-command-editor-specail ql-container">
        <div class="ql-editor" contenteditable="true" data-placeholder="Send Message"><p>draft</p></div>
      </div>
      <button data-new-input-control="add-tools-trigger" aria-label="Add">Add</button>
      <div id="previews"></div>
      <div id="yuanbao-send-btn" role="button" aria-label="Send"
           class="SendButton_sendButton__test SendButton_disabled__test SendButton_sendNot__test">
        <svg width="18" height="18" viewBox="0 0 48 48"></svg>Send
      </div>
    </div>
    <div role="button" aria-label="新建对话">新建对话</div>
    <script>
      window.__sendCount = 0;
      window.__newChatCount = 0;
      const editor = document.querySelector('.ql-editor');
      const send = document.querySelector('#yuanbao-send-btn');
      editor.addEventListener('input', () => {
        if (send.getAttribute('aria-label') !== 'Stop Answering') {
          send.className = 'SendButton_sendButton__test';
        }
      });
      send.addEventListener('click', () => window.__sendCount++);
      document.querySelector('[aria-label="新建对话"]').addEventListener(
        'click',
        () => window.__newChatCount++
      );
      document.querySelector('[data-new-input-control="add-tools-trigger"]').addEventListener('click', () => {
        if (document.querySelector('#upload-image')) return;
        const upload = document.createElement('button');
        upload.id = 'upload-image';
        upload.setAttribute('role', 'menuitem');
        upload.textContent = 'Upload Image';
        upload.style.position = 'absolute';
        upload.style.top = '8px';
        document.body.append(upload);
        upload.addEventListener('click', () => {
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.accept = 'image/*';
          input.addEventListener('change', () => {
            const file = input.files[0];
            const item = document.createElement('div');
            item.className = 'FileList_inputFileListItem__fixture';
            const image = document.createElement('img');
            image.alt = file.name;
            image.src = 'https://cdn.example/' + file.name;
            item.append(image);
            document.querySelector('#previews').append(item);
          });
          document.body.append(input);
        });
      });
    </script>
  </body>
</html>`;

function postPanelMessage(page, payload) {
  return page.evaluate((data) => {
    window.postMessage({ context: 'multi-panel', ...data }, '*');
  }, payload);
}

test.describe('Yuanbao production content scripts', () => {
  test.setTimeout(60000);

  let context;
  let server;
  let extensionDir;
  let userDataDir;
  let port;

  test.beforeAll(async () => {
    extensionDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-provider-extension-'));
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-provider-profile-'));

    await cp(SOURCE_EXTENSION_PATH, extensionDir, {
      recursive: true,
      filter: (source) => ![
        '.git',
        'node_modules',
        'test-results',
        'playwright-report',
      ].some((segment) => source.split(path.sep).includes(segment)),
    });

    const manifestPath = path.join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions.push(
      'http://yuanbao.tencent.com/*'
    );
    manifest.content_scripts.push(
      {
        matches: ['http://yuanbao.tencent.com/*'],
        js: [
          'content-scripts/button-finder-utils.js',
          'content-scripts/enter-behavior-utils.js',
          'content-scripts/enter-behavior-yuanbao.js',
          'content-scripts/text-injection-all-providers.js',
          'content-scripts/focus-toggle.js',
        ],
        run_at: 'document_start',
        all_frames: true,
      }
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    server = http.createServer((request, response) => {
      const body = YUANBAO_FIXTURE;
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    });
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    port = server.address().port;

    context = await chromium.launchPersistentContext(
      userDataDir,
      getBrowserLaunchOptions({
        headless: false,
        args: [
          `--disable-extensions-except=${extensionDir}`,
          `--load-extension=${extensionDir}`,
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-features=HttpsUpgrades',
          '--proxy-bypass-list=*',
          '--host-resolver-rules=MAP yuanbao.tencent.com 127.0.0.1',
        ],
      }, { extension: true })
    );

    if (context.serviceWorkers().length === 0) {
      await context.waitForEvent('serviceworker');
    }
  });

  test.afterAll(async () => {
    await context?.close();
    await new Promise((resolve, reject) => {
      server?.close((error) => error ? reject(error) : resolve());
    });
    await rm(extensionDir, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });

  test('shows the retained provider list in settings', async ({}, testInfo) => {
    const extensionId = new URL(context.serviceWorkers()[0].url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options/options.html`);
    const providers = page.locator('.provider-item');
    await expect(providers).toHaveCount(13);
    await expect(page.locator('.provider-item[data-provider-id="yuanbao"]')).toBeVisible();
    expect(await providers.evaluateAll(items => items.map(item => item.dataset.providerId)))
      .toEqual(expect.arrayContaining([
        'chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'kimi', 'google',
        'doubao', 'qwen-cn', 'qwen-global', 'chatglm', 'zai-global', 'yuanbao',
      ]));
    await page.screenshot({ path: testInfo.outputPath('providers.png'), fullPage: true });
    await page.close();
  });

  const providerCases = [
    {
      name: 'Yuanbao',
      url: () => `http://yuanbao.tencent.com:${port}/chat/naQivTmsDa`,
      editor: '.ql-editor',
      send: '#yuanbao-send-btn',
      preview: 'img[alt="sample.png"]',
    },
  ];

  for (const providerCase of providerCases) {
    test(`runs text, keyboard, new-chat, and image flows for ${providerCase.name}`, async () => {
      const page = await context.newPage();
      await page.goto(providerCase.url());
      await page.waitForSelector(providerCase.editor);

      await postPanelMessage(page, {
        type: 'INJECT_TEXT',
        text: ' + extension',
        autoSubmit: false,
      });
      await expect(page.locator(providerCase.editor)).toContainText('extension');
      await expect(page.locator(providerCase.send)).toBeEnabled();

      await page.locator(providerCase.editor).focus();
      await page.keyboard.press('Shift+Enter');
      await expect(page.locator(`${providerCase.editor} p`)).toHaveCount(2);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.__sendCount)).toBe(1);

      await postPanelMessage(page, { type: 'NEW_CHAT' });
      await expect.poll(() => page.evaluate(() => window.__newChatCount)).toBe(1);

      await postPanelMessage(page, {
        type: 'INJECT_TEXT_WITH_IMAGES',
        images: [SAMPLE_IMAGE],
        text: '',
        autoSubmit: false,
        requestId: 'fixture-fill',
      });
      await expect(page.locator(providerCase.preview)).toBeVisible();

      await page.close();
    });
  }

  test('Yuanbao generation keeps its stop control untouched by Enter and auto-submit', async () => {
    const page = await context.newPage();
    await page.goto(`http://yuanbao.tencent.com:${port}/chat/naQivTmsDa`);
    const editor = page.locator('.ql-editor');
    await expect(editor).toBeVisible();
    await page.locator('#yuanbao-send-btn').evaluate(button => {
      button.className = 'SendButton_sendButton__test SendButton_sendStop__test';
      button.setAttribute('aria-label', 'Stop Answering');
      button.querySelector('svg').remove();
    });
    await editor.focus();
    await page.keyboard.press('Enter');
    await postPanelMessage(page, {
      type: 'INJECT_TEXT',
      text: ' + queued',
      autoSubmit: true,
    });
    await page.waitForTimeout(950);
    expect(await page.evaluate(() => window.__sendCount)).toBe(0);
    await expect(editor).toContainText('queued');
    await page.close();
  });
});
