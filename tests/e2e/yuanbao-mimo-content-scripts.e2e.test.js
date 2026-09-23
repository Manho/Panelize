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
    <div id="message-list"></div>
    <button data-track-id="navbar_new_chat_btn">New Chat</button>
    <script>
      window.__sendCount = 0;
      window.__newChatCount = 0;
      const editor = document.querySelector('#composer textarea');
      const send = document.querySelector('[data-track-id="home_send_btn"]');
      editor.addEventListener('input', () => {
        send.disabled = editor.value.trim() === '';
      });
      send.addEventListener('click', () => {
        window.__sendCount++;
        window.location.hash = '#/chat/fixture-id';
        document.querySelector('#message-list').innerHTML =
          '<div class="markdown-prose">Mirrored reply</div>';
        editor.value = '';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.querySelector('[data-track-id="navbar_new_chat_btn"]').addEventListener('click', () => {
        window.__newChatCount++;
        window.location.hash = '#/c';
        document.querySelector('#message-list').innerHTML = '';
        editor.value = '';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      });
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
      'http://aistudio.xiaomimimo.com/*',
      'https://yuanbao.tencent.com/*',
      'https://aistudio.xiaomimimo.com/*'
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
      const isGuest = request.url?.includes('panelizeGuest=1');
      const body = hostname === 'yuanbao.tencent.com'
        ? YUANBAO_FIXTURE
        : isGuest
          ? MIMO_FIXTURE
            .replace('<textarea placeholder="随便问问">draft</textarea>',
              '<textarea placeholder="Sign in to continue chatting"></textarea>')
            .replace('<button data-track-id="navbar_new_chat_btn">New Chat</button>',
              '<button data-track-id="navbar_new_chat_btn">New Chat</button><button id="fixture-sign-in">Sign in</button>')
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

    const providersPath = path.join(extensionDir, 'modules/providers.js');
    const providersSource = await readFile(providersPath, 'utf8');
    await writeFile(providersPath, providersSource.replace(
      "const YUANBAO_DEFAULT_URL = 'https://yuanbao.tencent.com/chat/naQivTmsDa';",
      `const YUANBAO_DEFAULT_URL = 'http://yuanbao.tencent.com:${port}/chat/naQivTmsDa';`
    ));

    const bridgePath = path.join(extensionDir, 'multi-panel/mimo-bridge.js');
    const bridgeSource = await readFile(bridgePath, 'utf8');
    await writeFile(bridgePath, bridgeSource
      .replace(
        "const MIMO_URL = 'https://aistudio.xiaomimimo.com/#/c';",
        `const MIMO_URL = 'http://aistudio.xiaomimimo.com:${port}/?panelizeGuest=1#/c';`
      ));

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

  test('MiMo connects to a signed-in top-level tab without loading the site in an iframe', async () => {
    const worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).hostname;
    await worker.evaluate(() => chrome.storage.sync.set({
      enabledProviders: ['mimo'],
      providerOrder: ['mimo'],
      multiPanelProviders: ['mimo'],
      multiPanelLayout: '1x1',
    }));

    const mimoPage = await context.newPage();
    await mimoPage.goto(`http://aistudio.xiaomimimo.com:${port}/#/c`);
    await mimoPage.evaluate(() => {
      localStorage.setItem('hasLoggedIn', 'fixture-signed-in');
      const editor = document.querySelector('#composer textarea');
      editor.value = 'private draft';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/multi-panel/multi-panel.html`);
    const bridge = panelPage.frameLocator('.panel-item iframe');
    await expect(bridge.locator('#connection')).toHaveText('Not connected');
    const panelTabId = await panelPage.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    const bridgeTabId = await bridge.locator('body').evaluate(async () => (await chrome.tabs.getCurrent())?.id);
    expect(bridgeTabId).toBe(panelTabId);
    await worker.evaluate(() => chrome.storage.sync.set({ theme: 'dark' }));
    await expect(bridge.locator('html')).toHaveAttribute('data-theme', 'dark');
    await worker.evaluate(() => chrome.storage.sync.set({ theme: 'light' }));
    await expect(bridge.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await panelPage.locator('.panel-item iframe').getAttribute('src'))
      .toBe(`chrome-extension://${extensionId}/multi-panel/mimo-bridge.html`);
    await expect.poll(() => mimoPage.evaluate(() => localStorage.getItem('hasLoggedIn')))
      .toBe('fixture-signed-in');

    const dedicatedTabPromise = context.waitForEvent('page');
    await bridge.locator('#connect').click();
    const dedicatedPage = await dedicatedTabPromise;
    await expect(dedicatedPage).toHaveURL(
      `http://aistudio.xiaomimimo.com:${port}/?panelizeGuest=1#/c`
    );
    await expect(bridge.locator('#connection')).toHaveText('Not connected');

    await panelPage.locator('#unified-input').fill(' + not yet');
    await panelPage.locator('#send-all-btn').click();
    await expect.poll(() => dedicatedPage.evaluate(() => window.__sendCount)).toBe(0);
    await expect(panelPage.locator('#send-status')).toHaveText('Failed to send');

    await dedicatedPage.evaluate(() => {
      document.querySelector('#fixture-sign-in').remove();
      document.querySelector('#composer textarea').placeholder = 'Ask me anything';
    });
    await expect(bridge.locator('#connection')).toHaveText('Connected');
    await dedicatedPage.locator('#composer textarea').fill('private dedicated draft');
    await expect(bridge.locator('#connection')).toHaveText('Not connected');
    await expect(bridge.locator('#status')).toContainText('unsent draft');
    await panelPage.locator('#unified-input').fill(' + must not mix');
    await panelPage.locator('#send-all-btn').click();
    await expect(dedicatedPage.locator('#composer textarea')).toHaveValue('private dedicated draft');
    await expect.poll(() => dedicatedPage.evaluate(() => window.__sendCount)).toBe(0);
    await dedicatedPage.locator('#composer textarea').fill('');
    await expect(bridge.locator('#connection')).toHaveText('Connected');

    await panelPage.locator('#panel-grid').evaluate(grid => {
      grid.className = 'layout-1x3';
    });
    expect(await bridge.locator('body').evaluate(body => body.scrollWidth <= body.clientWidth + 1))
      .toBe(true);

    await panelPage.locator('#unified-input').fill(' + relay');
    await panelPage.locator('#send-all-btn').click();
    await expect.poll(() => dedicatedPage.evaluate(() => window.__sendCount)).toBe(1);
    await expect(bridge.locator('#response')).toHaveText('Mirrored reply');
    await expect(mimoPage.locator('#composer textarea')).toHaveValue('private draft');
    await expect.poll(() => mimoPage.evaluate(() => window.__sendCount)).toBe(0);

    await panelPage.locator('#new-chat-btn').click();
    await expect.poll(() => dedicatedPage.evaluate(() => window.__newChatCount)).toBe(1);
    await expect(bridge.locator('#response')).toBeEmpty();

    const imageBuffer = Buffer.from(SAMPLE_IMAGE.dataUrl.split(',')[1], 'base64');
    await panelPage.locator('#image-file-input').setInputFiles([
      { name: SAMPLE_IMAGE.name, mimeType: SAMPLE_IMAGE.type, buffer: imageBuffer },
      { name: 'sample-2.png', mimeType: SAMPLE_IMAGE.type, buffer: imageBuffer },
    ]);
    await panelPage.locator('#unified-input').fill('image context');
    await panelPage.locator('#fill-input-btn').click();
    await expect(dedicatedPage.locator('[aria-label="sample.png"]')).toBeVisible();
    await expect(dedicatedPage.locator('[aria-label="sample-2.png"]')).toBeVisible();
    await expect(panelPage.locator('#send-status')).toContainText('Filled 1 input');
    await panelPage.locator('#send-all-btn').click();
    await expect.poll(() => dedicatedPage.evaluate(() => window.__sendCount)).toBe(2);
    await expect(mimoPage.locator('#composer textarea')).toHaveValue('private draft');

    await worker.evaluate(() => chrome.storage.sync.set({
      enabledProviders: ['mimo', 'yuanbao'],
      providerOrder: ['mimo', 'yuanbao'],
    }));
    const panelIframe = panelPage.locator('.panel-item iframe');
    await panelPage.locator('.switch-provider-btn').click();
    await panelPage.locator('.provider-switcher-item[data-provider-id="yuanbao"]').click();
    await expect(panelIframe).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(panelIframe).toHaveAttribute(
      'src',
      `http://yuanbao.tencent.com:${port}/chat/naQivTmsDa`
    );
    await panelPage.locator('.switch-provider-btn').click();
    await panelPage.locator('.provider-switcher-item[data-provider-id="mimo"]').click();
    await expect(panelIframe).not.toHaveAttribute('sandbox');
    await expect(panelIframe).toHaveAttribute(
      'src',
      `chrome-extension://${extensionId}/multi-panel/mimo-bridge.html`
    );

    const secondPanelPage = await context.newPage();
    await secondPanelPage.goto(`chrome-extension://${extensionId}/multi-panel/multi-panel.html`);
    const secondBridge = secondPanelPage.frameLocator('.panel-item iframe');
    await expect(secondBridge.locator('#connection')).toHaveText('Not connected');
    const secondTabPromise = context.waitForEvent('page');
    await secondBridge.locator('#connect').click();
    const secondDedicatedPage = await secondTabPromise;
    await expect(secondDedicatedPage).toHaveURL(
      `http://aistudio.xiaomimimo.com:${port}/?panelizeGuest=1#/c`
    );
    await expect(secondDedicatedPage.locator('#fixture-sign-in')).toBeVisible();
    await secondDedicatedPage.evaluate(() => {
      document.querySelector('#fixture-sign-in').remove();
      document.querySelector('#composer textarea').placeholder = 'Ask me anything';
    });
    await expect(secondBridge.locator('#connection')).toHaveText('Connected');
    await secondPanelPage.locator('#unified-input').fill('second panel only');
    await secondPanelPage.locator('#send-all-btn').click();
    await expect.poll(() => secondDedicatedPage.evaluate(() => window.__sendCount)).toBe(1);
    expect(await dedicatedPage.evaluate(() => window.__sendCount)).toBe(2);

    await secondPanelPage.close();
    await secondDedicatedPage.close();

    await worker.evaluate(() => chrome.storage.sync.set({ multiPanelLayout: '1x2' }));
    await panelPage.reload();
    await expect(panelPage.locator('.panel-item')).toHaveCount(2);
    const secondPanel = panelPage.locator('.panel-item').nth(1);
    await secondPanel.locator('.switch-provider-btn').click();
    await panelPage.locator('.provider-switcher-item[data-provider-id="mimo"]').click();
    await expect(secondPanel.locator('.panel-header-left span')).toHaveText('Yuanbao');

    await panelPage.close();
    await dedicatedPage.close();
    await mimoPage.close();
  });

  test('MiMo opens a top-level tab only after the user requests it', async () => {
    const worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).hostname;
    await worker.evaluate(() => chrome.storage.sync.set({
      enabledProviders: ['mimo'],
      providerOrder: ['mimo'],
      multiPanelProviders: ['mimo'],
      multiPanelLayout: '1x1',
    }));

    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/multi-panel/multi-panel.html`);
    const bridge = panelPage.frameLocator('.panel-item iframe');
    await expect(bridge.locator('#connection')).toHaveText('Not connected');
    expect(context.pages().some(page => page.url().startsWith(`http://aistudio.xiaomimimo.com:${port}`)))
      .toBe(false);

    const newTabPromise = context.waitForEvent('page');
    await panelPage.locator('.open-provider-top-level-btn').click();
    const mimoPage = await newTabPromise;
    await expect(mimoPage).toHaveURL(
      `http://aistudio.xiaomimimo.com:${port}/?panelizeGuest=1#/c`
    );
    await expect(bridge.locator('#connection')).toHaveText('Not connected');

    await context.route('https://account.xiaomi.com/**', route => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>MiMo sign in</title><button>Sign in</button>',
    }));
    await mimoPage.goto('https://account.xiaomi.com/fe/service/login');
    await panelPage.reload();
    const reloadedBridge = panelPage.frameLocator('.panel-item iframe');
    await expect(reloadedBridge.locator('#connection')).toHaveText('Not connected');
    const pageCount = context.pages().length;
    await reloadedBridge.locator('#connect').click();
    expect(context.pages()).toHaveLength(pageCount);

    await mimoPage.goto(`http://aistudio.xiaomimimo.com:${port}/?panelizeGuest=1#/c`);
    await mimoPage.evaluate(() => {
      document.querySelector('#fixture-sign-in').remove();
      document.querySelector('#composer textarea').placeholder = 'Ask me anything';
    });
    await expect(reloadedBridge.locator('#connection')).toHaveText('Connected');

    await mimoPage.close();
    await expect(reloadedBridge.locator('#connection')).toHaveText('Not connected');
    await expect(reloadedBridge.locator('#connect')).toHaveText('Open MiMo tab');
    await panelPage.locator('#unified-input').fill('must not send to a closed tab');
    await panelPage.locator('#send-all-btn').click();
    await expect(panelPage.locator('#send-status')).toHaveText('Failed to send');
    await panelPage.close();
  });
});
