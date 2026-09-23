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
           class="SendButton_sendButton__test SendButton_disabled__test SendButton_sendNot__test">Send</div>
    </div>
    <div role="button" aria-label="新建对话">新建对话</div>
    <script>
      window.__sendCount = 0;
      window.__newChatCount = 0;
      const editor = document.querySelector('.ql-editor');
      const send = document.querySelector('#yuanbao-send-btn');
      editor.addEventListener('input', () => {
        send.className = 'SendButton_sendButton__test';
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

const MIMO_FIXTURE = `<!doctype html>
<html>
  <body>
    <textarea id="unrelated">leave me alone</textarea>
    <div class="relative border" id="composer">
      <textarea placeholder="随便问问">draft</textarea>
      <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/bmp,text/plain">
      <div id="previews"></div>
      <button data-track-id="home_send_btn" data-state="open" disabled>
        <svg viewBox="0 0 19 16"></svg>Send
      </button>
    </div>
    <button data-track-id="navbar_new_chat_btn">New Chat</button>
    <script>
      window.__sendCount = 0;
      window.__newChatCount = 0;
      const editor = document.querySelector('#composer textarea');
      const send = document.querySelector('[data-track-id="home_send_btn"]');
      editor.addEventListener('input', () => {
        send.disabled = editor.value.trim() === '';
      });
      send.addEventListener('click', () => window.__sendCount++);
      document.querySelector('[data-track-id="navbar_new_chat_btn"]').addEventListener(
        'click',
        () => window.__newChatCount++
      );
      document.querySelector('input[type="file"]').addEventListener('change', (event) => {
        const file = event.target.files[0];
        const preview = document.createElement('button');
        preview.setAttribute('aria-label', file.name);
        preview.textContent = file.name;
        document.querySelector('#previews').append(preview);
      });
    </script>
  </body>
</html>`;

function postPanelMessage(page, payload) {
  return page.evaluate((data) => {
    window.postMessage({ context: 'multi-panel', ...data }, '*');
  }, payload);
}

test.describe('Yuanbao and MiMo production content scripts', () => {
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
      'http://yuanbao.tencent.com/*',
      'http://aistudio.xiaomimimo.com/*'
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
      },
      {
        matches: ['http://aistudio.xiaomimimo.com/*'],
        js: [
          'content-scripts/button-finder-utils.js',
          'content-scripts/enter-behavior-utils.js',
          'content-scripts/enter-behavior-mimo.js',
          'content-scripts/text-injection-all-providers.js',
          'content-scripts/focus-toggle.js',
        ],
        run_at: 'document_start',
        all_frames: true,
      }
    );
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    server = http.createServer((request, response) => {
      const hostname = (request.headers.host || '').split(':')[0];
      const body = hostname === 'yuanbao.tencent.com'
        ? YUANBAO_FIXTURE
        : MIMO_FIXTURE;
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
          '--host-resolver-rules=MAP yuanbao.tencent.com 127.0.0.1,MAP aistudio.xiaomimimo.com 127.0.0.1',
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

  const providerCases = [
    {
      name: 'Yuanbao',
      url: () => `http://yuanbao.tencent.com:${port}/chat/naQivTmsDa`,
      editor: '.ql-editor',
      send: '#yuanbao-send-btn',
      preview: 'img[alt="sample.png"]',
    },
    {
      name: 'MiMo',
      url: () => `http://aistudio.xiaomimimo.com:${port}/#/c`,
      editor: '#composer textarea',
      send: '[data-track-id="home_send_btn"]',
      preview: '[aria-label="sample.png"]',
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
      if (providerCase.name === 'MiMo') {
        await expect(page.locator(providerCase.editor)).toHaveValue(/extension/);
        await expect(page.locator('#unrelated')).toHaveValue('leave me alone');
      } else {
        await expect(page.locator(providerCase.editor)).toContainText('extension');
      }
      await expect(page.locator(providerCase.send)).toBeEnabled();

      await page.locator(providerCase.editor).focus();
      await page.keyboard.press('Shift+Enter');
      if (providerCase.name === 'Yuanbao') {
        await expect(page.locator(`${providerCase.editor} p`)).toHaveCount(2);
      } else {
        await expect(page.locator(providerCase.editor)).toHaveValue(/\n/);
      }
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

  test('MiMo generation keeps its stop control untouched by Enter and auto-submit', async () => {
    const page = await context.newPage();
    await page.goto(`http://aistudio.xiaomimimo.com:${port}/#/c`);
    const editor = page.locator('#composer textarea');
    await expect(editor).toBeVisible();
    await page.locator('[data-track-id="home_send_btn"] svg')
      .evaluate(svg => svg.setAttribute('viewBox', '0 0 24 24'));
    await editor.focus();
    await page.keyboard.press('Enter');
    await postPanelMessage(page, {
      type: 'INJECT_TEXT',
      text: ' + queued',
      autoSubmit: true,
    });
    await page.waitForTimeout(950);
    expect(await page.evaluate(() => window.__sendCount)).toBe(0);
    await expect(editor).toHaveValue(/queued/);
    await page.close();
  });
});
