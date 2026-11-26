import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
  startFixtureServer,
} from './extension-harness.js';

const SCREENSHOT_DIR = '/tmp/panelize-item5-screenshots';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);
const PDF_BYTES = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'utf8');
const DOCX_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const TXT_CONTENT = 'Quarter,Revenue,Growth\nQ1,120000,12%\nQ2,148000,23%\n';
const TXT_BYTES = Buffer.from(TXT_CONTENT, 'utf8');

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function renderDeepSeekDocFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DeepSeek Doc Fixture</title></head>
<body>
  <main id="deepseek-composer">
    <textarea id="deepseek-editor" placeholder="Message DeepSeek" rows="2"></textarea>
    <input id="deepseek-file" type="file" multiple accept="image/*,.pdf,.docx,.txt,.csv,.md" style="display:none" />
    <div id="deepseek-previews"></div>
    <button id="deepseek-clear-user" type="button">Clear</button>
    <div role="button" tabindex="0" id="deepseek-send" class="ds-button">Send</div>
  </main>
  <script>
    const editor = document.getElementById('deepseek-editor');
    const fileInput = document.getElementById('deepseek-file');
    const previews = document.getElementById('deepseek-previews');
    window.__fixture = { uploadedFiles: [], sentTexts: [] };

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      window.__fixture.uploadedFiles.push({ name: file.name, type: file.type, size: file.size });
      const chip = document.createElement('div');
      chip.className = 'ds-file-card';
      chip.dataset.fileName = file.name;
      chip.textContent = file.name;
      previews.appendChild(chip);
    });

    document.getElementById('deepseek-clear-user').addEventListener('click', () => {
      editor.value = '';
      previews.innerHTML = '';
    });

    document.getElementById('deepseek-send').addEventListener('click', () => {
      window.__fixture.sentTexts.push(editor.value);
    });
  </script>
</body>
</html>`;
}

function renderKimiDocFixture({ failFirstDocUpload = false } = {}) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Kimi Doc Fixture</title></head>
<body>
  <div id="chat-box">
    <div class="chat-editor">
      <div class="chat-input-editor" contenteditable="true" role="textbox"></div>
      <input class="hidden-input" type="file" multiple style="display:none" />
      <div id="kimi-previews"></div>
      <div class="send-button-container">Send</div>
    </div>
  </div>
  <script>
    const fileInput = document.querySelector('input.hidden-input');
    const previews = document.getElementById('kimi-previews');
    window.__fixture = {
      allowUploadSuccess: ${failFirstDocUpload ? 'false' : 'true'},
      uploadedFiles: [],
    };

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;
      window.__fixture.uploadedFiles.push({ name: file.name, type: file.type, size: file.size });
      const card = document.createElement('div');
      card.className = window.__fixture.allowUploadSuccess ? 'file-card success' : 'file-card error';
      card.dataset.fileName = file.name;
      card.textContent = file.name;
      previews.appendChild(card);
    });
  </script>
</body>
</html>`;
}

function renderGoogleSearchFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Google Search Fixture</title></head>
<body style="font-family: sans-serif; padding: 16px;">
  <h3>Google Search</h3>
  <input name="q" style="width: 90%; padding: 8px;" placeholder="Search Google" />
</body>
</html>`;
}

function renderImageOnlyCustomWebFixture() {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Image-Only Custom Web</title></head>
<body style="font-family: sans-serif; padding: 16px;">
  <h3>Image-Only Custom AI</h3>
  <form id="custom-composer">
    <div id="custom-previews"></div>
    <input id="custom-img-only" type="file" accept="image/*" multiple style="display:none" />
    <textarea id="custom-input" rows="3" style="width: 90%;" placeholder="Ask anything..."></textarea>
    <button type="button" id="custom-send" aria-label="Send">Send</button>
  </form>
  <script>
    window.__customFixture = { uploaded: [] };
    document.getElementById('custom-img-only').addEventListener('change', (e) => {
      for (const f of Array.from(e.target.files || [])) {
        window.__customFixture.uploaded.push(f.name);
        const img = document.createElement('img');
        img.src = 'data:image/png;base64,iVBORw0KGgo=';
        img.alt = f.name;
        document.getElementById('custom-previews').appendChild(img);
      }
    });
  </script>
</body>
</html>`;
}

test.describe('Document upload E2E (Issue #118 Item #5)', () => {
  test.setTimeout(90_000);

  test('renders aligned mixed PNG+PDF+DOCX+TXT chips in Light, Dark, and 390px narrow viewports, rejects unsupported files, and removes chips cleanly', async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    try {
      await extension.context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderDeepSeekDocFixture() })
      );
      await extension.context.route('https://www.kimi.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderKimiDocFixture() })
      );

      const page = await openMultiPanel(extension, {
        providers: ['deepseek', 'kimi'],
        layout: '1x2',
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // Verify unified attach_file button icon
      await expect(page.locator('#image-upload-btn .material-symbols-outlined')).toHaveText('attach_file');

      // Attach mixed PNG + PDF + DOCX + TXT files
      await page.locator('#image-file-input').setInputFiles([
        { name: 'architecture-diagram.png', mimeType: 'image/png', buffer: PNG_BYTES },
        { name: 'quarterly-report-2026.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
        {
          name: 'product-spec-v2.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buffer: DOCX_BYTES,
        },
        { name: 'metrics-summary.txt', mimeType: 'text/plain', buffer: TXT_BYTES },
      ]);

      await expect(page.locator('#image-preview-container .image-preview-item')).toHaveCount(1);
      await expect(page.locator('#image-preview-container .attachment-doc-chip')).toHaveCount(3);

      // Verify equal 48px height alignment between image thumb and document chips
      const heights = await page.evaluate(() => {
        const imgRect = document.querySelector('.image-preview-item')?.getBoundingClientRect();
        const chipRects = [...document.querySelectorAll('.attachment-doc-chip')].map((el) =>
          Math.round(el.getBoundingClientRect().height)
        );
        return { imgHeight: Math.round(imgRect?.height || 0), chipHeights: chipRects };
      });
      expect(heights.imgHeight).toBe(48);
      expect(heights.chipHeights).toEqual([48, 48, 48]);

      await page.locator('#unified-input').fill('Compare the diagram and summarize all attached documents.');

      // 1) Light theme desktop screenshot
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.setAttribute('data-theme', 'light');
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'doc-preview-light.png') });

      // 2) Dark theme desktop screenshot
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'dark');
        document.body.setAttribute('data-theme', 'dark');
      });
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'doc-preview-dark.png') });

      // 3) 390px narrow viewport screenshot + zero horizontal overflow check
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-theme', 'light');
        document.body.setAttribute('data-theme', 'light');
      });
      await page.setViewportSize({ width: 390, height: 844 });
      const noHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1
      );
      expect(noHorizontalOverflow).toBe(true);
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'doc-preview-narrow.png') });

      // Drop an unsupported .zip file -> rejection toast, count unchanged
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.evaluate(() => {
        const wrapper = document.querySelector('.input-wrapper');
        const dt = new DataTransfer();
        dt.items.add(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', { type: 'application/zip' }));
        wrapper.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      });
      await expect(page.locator('.panelize-toast').last()).toContainText('archive.zip');
      await expect(page.locator('#image-preview-container .attachment-doc-chip')).toHaveCount(3);

      // Remove one document chip cleanly
      await page.locator('#image-preview-container .attachment-doc-chip .attachment-doc-remove').first().click();
      await expect(page.locator('#image-preview-container .attachment-doc-chip')).toHaveCount(2);

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('recovers partial document upload failure via Retry Failed and Send All cleared-panel fallback', async () => {
    const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    try {
      await extension.context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderDeepSeekDocFixture() })
      );
      await extension.context.route('https://www.kimi.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderKimiDocFixture({ failFirstDocUpload: true }) })
      );

      const page = await openMultiPanel(extension, {
        providers: ['deepseek', 'kimi'],
        layout: '1x2',
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      const readState = (host) => {
        const frame = page.frames().find((f) => f.url().startsWith(`https://${host}/`));
        return frame ? frame.evaluate(() => window.__fixture).catch(() => null) : null;
      };
      await expect.poll(async () => Boolean(await readState('chat.deepseek.com'))).toBe(true);
      await expect.poll(async () => Boolean(await readState('www.kimi.com'))).toBe(true);

      await page.locator('#image-file-input').setInputFiles({
        name: 'paper.pdf',
        mimeType: 'application/pdf',
        buffer: PDF_BYTES,
      });
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);
      await page.locator('#unified-input').fill('Analyze paper.pdf');
      await page.locator('#send-all-btn').click();

      // Pass 1: DeepSeek succeeds, Kimi fails -> Retry Failed activated
      await expect(page.locator('#send-status')).toHaveText('Filled 1/2; 1 failed', { timeout: 20000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'true');
      expect((await readState('chat.deepseek.com')).uploadedFiles.map((f) => f.name)).toEqual(['paper.pdf']);

      // User clears DeepSeek panel manually while Kimi recovers
      await page.frameLocator('iframe[src*="deepseek"]').locator('#deepseek-clear-user').click();
      const kimiFrame = page.frames().find((f) => f.url().startsWith('https://www.kimi.com/'));
      await kimiFrame.evaluate(() => {
        document.getElementById('kimi-previews').innerHTML = '';
        window.__fixture.allowUploadSuccess = true;
      });

      // Clicking Send All re-populates cleared DeepSeek via fallbackAttachments AND finishes Kimi
      await page.locator('#send-all-btn').click();
      await expect(page.locator('#send-status')).toHaveText('Filled 2 inputs', { timeout: 20000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'false');
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(0);
      expect((await readState('chat.deepseek.com')).uploadedFiles).toHaveLength(2);
      expect((await readState('www.kimi.com')).uploadedFiles.at(-1)?.name).toBe('paper.pdf');

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('handles Skipped tri-state (Google Search + image-only Custom Web + Custom API PDF) without Retry Failed and inlines Custom API plain-text documents', async () => {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const apiRequests = [];

    const fixtureServer = await startFixtureServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/custom-web') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(renderImageOnlyCustomWebFixture());
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const body = JSON.parse(await readRequestBody(req));
        apiRequests.push(body);
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Q2 revenue grew 23% to 148000.' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    const serverOrigin = `http://127.0.0.1:${fixtureServer.port}`;
    const patched = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions = [...(manifest.host_permissions || []), `${serverOrigin}/*`];
    });

    const extension = await launchExtension({
      extensionPath: patched.extensionPath,
      viewport: { width: 1280, height: 800 },
    });
    const pageErrors = [];

    try {
      await extension.context.route('https://www.google.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderGoogleSearchFixture() })
      );

      // Register both a Custom API provider and an image-only Custom Web provider via Options UI
      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await optionsPage.waitForSelector('#custom-provider-name');

      // 1) Add Custom API provider
      await optionsPage.locator('#custom-provider-kind-api').check();
      await optionsPage.locator('#custom-provider-name').fill('Local API');
      await optionsPage.locator('#custom-provider-url').fill(`${serverOrigin}/v1`);
      await optionsPage.locator('#custom-provider-model').fill('qwen-test');
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]')).toHaveCount(1);
      const apiProviderId = await optionsPage
        .locator('#provider-list .provider-item[data-custom-provider="true"]')
        .first()
        .getAttribute('data-provider-id');

      // 2) Add image-only Custom Web provider
      await optionsPage.locator('#custom-provider-kind-web-local').check();
      await optionsPage.locator('#custom-provider-name').fill('ImageOnly Web');
      await optionsPage.locator('#custom-provider-url').fill(`${serverOrigin}/custom-web`);
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]')).toHaveCount(2);
      const webProviderId = await optionsPage
        .locator('#provider-list .provider-item[data-custom-provider="true"]')
        .nth(1)
        .getAttribute('data-provider-id');
      await optionsPage.close();

      await extension.serviceWorker.evaluate(async (settings) => {
        await chrome.storage.sync.set(settings);
      }, {
        googleProviderMode: 'search',
      });

      const page = await openMultiPanel(extension, {
        providers: ['google', webProviderId, apiProviderId],
        layout: '1x3',
        enabledProviders: ['google', webProviderId, apiProviderId],
      });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // Wait for all 3 panel frames to initialize
      const apiFrame = page.frameLocator('iframe[src*="api-panel/api-panel.html"]');
      await expect(apiFrame.locator('#api-model-badge')).toHaveText('qwen-test', { timeout: 10000 });

      // Part A: Pure PDF with empty text across all 3 panels -> ALL panels return skipped ->
      // attachments MUST stay intact and #fill-input-btn MUST NOT become Retry Failed!
      await page.locator('#image-file-input').setInputFiles({
        name: 'binary-only.pdf',
        mimeType: 'application/pdf',
        buffer: PDF_BYTES,
      });
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);
      await page.locator('#send-all-btn').click();

      await expect(page.locator('#send-status')).toHaveText('Skipped: unsupported document', { timeout: 10000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'false');
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);

      // Remove binary-only.pdf before mixed test
      await page.locator('.attachment-doc-chip .attachment-doc-remove').click();
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(0);

      // Part B: Mixed TXT + PDF + text prompt ->
      // Custom API stages TXT Doc Chip + skips PDF (shows inline notice),
      // Google Search + ImageOnly Web inject text + skip docs, zero Retry Failed!
      await page.locator('#image-file-input').setInputFiles([
        { name: 'metrics.csv', mimeType: 'text/csv', buffer: TXT_BYTES },
        { name: 'appendix.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
      ]);
      await page.locator('#unified-input').fill('What was Q2 revenue growth?');
      await page.locator('#send-all-btn').click();

      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'false');
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(0, { timeout: 10000 });
      await expect(apiFrame.locator('#staged-images .staged-doc-chip')).toHaveCount(1);
      await expect(apiFrame.locator('#staged-notice')).toBeVisible();
      await expect(apiFrame.locator('#staged-notice')).toContainText('appendix.pdf');

      // Capture screenshot showing Skipped feedback + Custom API TXT chip & PDF skip notice
      await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'doc-skipped-and-api-inline.png') });

      // Now click Send All (empty unified input triggers send) -> Custom API sends inlined CSV content!
      await page.locator('#send-all-btn').click();
      await expect.poll(() => apiRequests.length, { timeout: 10000 }).toBe(1);

      const sentContent = apiRequests[0].messages[0].content;
      expect(sentContent).toContain('[Attached file: metrics.csv]');
      expect(sentContent).toContain('Q2,148000,23%');
      expect(sentContent).toContain('What was Q2 revenue growth?');
      await expect(apiFrame.locator('.turn-user .turn-doc-chip')).toHaveCount(1);
      await expect(apiFrame.locator('.turn-assistant .turn-markdown')).toContainText('Q2 revenue grew 23%');

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
      await patched.cleanup();
      await fixtureServer.close();
    }
  });

  test('Open Mode switch with a large PDF document does not throw storage quota errors', async () => {
    const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    try {
      await extension.context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: renderDeepSeekDocFixture() })
      );

      const companionTab = await extension.context.newPage();
      await companionTab.goto('about:blank');

      const page = await openMultiPanel(extension, { providers: ['deepseek'], layout: '1x1' });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      // Attach a valid 6 MB PDF document (exceeds 4 MB storage handoff guard) + small TXT
      const largePdfBuffer = Buffer.alloc(6 * 1024 * 1024, 0x20);
      largePdfBuffer.write('%PDF-1.7\n', 0, 'ascii');
      await page.locator('#image-file-input').setInputFiles([
        { name: 'large-paper.pdf', mimeType: 'application/pdf', buffer: largePdfBuffer },
        { name: 'small-notes.txt', mimeType: 'text/plain', buffer: TXT_BYTES },
      ]);
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(2);
      await page.locator('#unified-input').fill('Draft with large PDF');

      // Switch Tab Mode -> Popup Mode -> Tab Mode without error
      await page.locator('#toggle-open-mode-btn').click();
      await expect.poll(async () => page.evaluate(async () => (await chrome.windows.getCurrent()).type))
        .toBe('popup');

      await page.locator('#toggle-open-mode-btn').click();
      await expect.poll(async () => page.evaluate(async () => (await chrome.windows.getCurrent()).type))
        .toBe('normal');

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });

  test('Gemini Hydrogen E2E: confirms deferred @defer(on idle) uploads via ProcessFile 200 and middle-truncated chips without false failure, while rejecting genuine failures', async () => {
    const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
    const pageErrors = [];
    const renderGeminiFixture = () => `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Gemini Hydrogen Fixture</title></head>
<body>
  <input-container>
    <input-area-v2>
      <div class="input-area">
        <div class="text-input-field with-toolbox-drawer">
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
          <button id="gemini-upload-tools" type="button" aria-label="Upload &amp; tools">+</button>
          <button id="gemini-send" type="button" aria-label="Send message">Send</button>
        </div>
      </div>
    </input-area-v2>
  </input-container>
  <div id="sent-turns"></div>
  <script>
    window.__geminiFixture = { mode: 'deferred', processFileStatus: 200, uploaded: [], sent: [] };
    const textField = document.querySelector('.text-input-field');
    const editor = document.querySelector('.ql-editor');
    const uploadBtn = document.getElementById('gemini-upload-tools');

    const middleTruncate = (name) => {
      const stem = name.replace(/\\.[^.]+$/, '');
      return stem.length <= 20 ? stem : stem.slice(0, 10) + '...' + stem.slice(-10);
    };

    uploadBtn.addEventListener('click', () => {
      if (document.querySelector('.cdk-overlay-pane')) return;
      const overlay = document.createElement('div');
      overlay.className = 'cdk-overlay-pane';
      overlay.innerHTML = '<div role="menu" class="mat-mdc-menu-panel"></div>';
      const menu = overlay.querySelector('[role="menu"]');

      const docInput = document.createElement('input');
      docInput.type = 'file';
      docInput.multiple = true;
      docInput.className = 'hidden-file-input';
      docInput.accept = '.txt,.pdf,.doc,.docx';

      const imgInput = document.createElement('input');
      imgInput.type = 'file';
      imgInput.multiple = true;
      imgInput.className = 'hidden-file-input ng-star-inserted';
      imgInput.accept = 'image/*,video/*';

      const onFile = async (input) => {
        const file = input.files && input.files[0];
        if (!file) return;
        window.__geminiFixture.uploaded.push(file.name);
        textField.classList.add('with-file-preview');
        let wrapper = textField.querySelector('.attachment-preview-wrapper');
        if (!wrapper) {
          wrapper = document.createElement('div');
          wrapper.className = 'attachment-preview-wrapper';
          wrapper.innerHTML = '<!----><!---->';
          textField.prepend(wrapper);
        }
        const res = await fetch('/_/BardChatUi/data/assistant.lamda.BardFrontendService/ProcessFile?bl=test&file=' + encodeURIComponent(file.name), {
          method: 'POST',
          body: file.name,
        });
        if (window.__geminiFixture.mode === 'deferred' || !res.ok) {
          return;
        }
        let container = wrapper.querySelector('uploader-file-preview-container');
        if (!container) {
          container = document.createElement('uploader-file-preview-container');
          wrapper.append(container);
        }
        const chip = document.createElement('uploader-file-preview');
        chip.className = 'file-preview-chip ng-star-inserted';
        const label = middleTruncate(file.name);
        chip.innerHTML = '<span>TXT</span><span class="gem-attachment-text">' + label + '</span><button type="button" aria-label="close ' + label + '">x</button>';
        container.append(chip);
      };

      docInput.addEventListener('change', () => { void onFile(docInput); });
      imgInput.addEventListener('change', () => { void onFile(imgInput); });
      menu.append(docInput, imgInput);
      document.body.append(overlay);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelector('.cdk-overlay-pane')?.remove();
      }
    });

    document.getElementById('gemini-send').addEventListener('click', () => {
      window.__geminiFixture.sent.push({
        text: editor.textContent,
        files: [...window.__geminiFixture.uploaded],
      });
    });
  </script>
</body>
</html>`;

    try {
      await extension.context.route('https://gemini.google.com/**', async (route) => {
        const url = route.request().url();
        if (url.includes('BardFrontendService/ProcessFile')) {
          const status = url.includes('file=broken-upload.txt') ? 500 : 200;
          await route.fulfill({ status, contentType: 'application/json', body: ')]}\'\n[]' });
          return;
        }
        await route.fulfill({ contentType: 'text/html', body: renderGeminiFixture() });
      });

      const page = await openMultiPanel(extension, { providers: ['gemini'], layout: '1x1' });
      page.on('pageerror', (err) => pageErrors.push(err.message));

      const getGeminiFrame = () => page.frames().find((f) => f.url().startsWith('https://gemini.google.com/'));
      await expect.poll(async () => Boolean(await getGeminiFrame()?.evaluate(() => window.__geminiFixture).catch(() => null))).toBe(true);

      // 1) Deferred preview container (fresh page): mixed PNG + long-named TXT + text -> MUST succeed via ProcessFile 200!
      await page.locator('#image-file-input').setInputFiles([
        { name: 'diagram.png', mimeType: 'image/png', buffer: PNG_BYTES },
        { name: 'very-long-quarterly-engineering-architecture-report-2026-final.txt', mimeType: 'text/plain', buffer: TXT_BYTES },
      ]);
      await expect(page.locator('.image-preview-item')).toHaveCount(1);
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);
      await page.locator('#unified-input').fill('Summarize both attached files.');
      await page.locator('#send-all-btn').click();

      await expect(page.locator('#send-status')).toHaveText('Filled 1 input', { timeout: 10000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'false');
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(0);

      // Click Send All (empty input triggers send) -> both files & text submitted!
      await page.locator('#send-all-btn').click();
      await expect.poll(async () => (await getGeminiFrame().evaluate(() => window.__geminiFixture.sent)).length).toBe(1);
      const sentState = await getGeminiFrame().evaluate(() => window.__geminiFixture.sent[0]);
      expect(sentState.text).toContain('Summarize both attached files.');
      expect(sentState.files).toEqual([
        'diagram.png',
        'very-long-quarterly-engineering-architecture-report-2026-final.txt',
      ]);

      // 2) Warm preview container with middle-truncated rejection-word filename -> MUST succeed!
      await getGeminiFrame().evaluate(() => {
        window.__geminiFixture.mode = 'warm';
        document.querySelector('.ql-editor').textContent = '';
      });
      await page.locator('#image-file-input').setInputFiles([
        { name: 'fix-gemini-file-text-false-failure-summary.txt', mimeType: 'text/plain', buffer: TXT_BYTES },
      ]);
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);
      await page.locator('#unified-input').fill('Check truncated failure-word filename.');
      await page.locator('#send-all-btn').click();
      await expect(page.locator('#send-status')).toHaveText('Filled 1 input', { timeout: 10000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'false');
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(0);

      // 3) Genuine failure (deferred + ProcessFile 500 for broken-upload.txt) -> MUST fail with Retry Failed!
      await getGeminiFrame().evaluate(() => {
        window.__geminiFixture.mode = 'deferred';
        document.querySelector('.attachment-preview-wrapper')?.remove();
        document.querySelector('.text-input-field')?.classList.remove('with-file-preview');
        document.querySelector('.ql-editor').textContent = '';
      });
      await page.locator('#image-file-input').setInputFiles([
        { name: 'broken-upload.txt', mimeType: 'text/plain', buffer: TXT_BYTES },
      ]);
      await expect(page.locator('.attachment-doc-chip')).toHaveCount(1);
      await page.locator('#unified-input').fill('Should report failure.');
      await page.locator('#send-all-btn').click();
      await expect(page.locator('#send-status')).toHaveText('Fill failed: 1/1 panels failed', { timeout: 15000 });
      await expect(page.locator('#fill-input-btn')).toHaveAttribute('data-retry-failed', 'true');

      expect(pageErrors).toEqual([]);
    } finally {
      await extension.close();
    }
  });
});
