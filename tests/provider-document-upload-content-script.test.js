import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN, dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

const chatgptComposerSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/chatgpt-composer.js'),
  'utf8'
);
const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function makePdfAttachment(id = 'doc-pdf-1', name = 'paper.pdf') {
  const bytes = new TextEncoder().encode('%PDF-1.7\n1 0 obj\nendobj\n').buffer;
  return {
    id,
    kind: 'document',
    name,
    type: 'application/pdf',
    ext: '.pdf',
    size: bytes.byteLength,
    isPlainText: false,
    bytes,
  };
}

function makeDocxAttachment(id = 'doc-docx-1', name = 'spec.docx') {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).buffer;
  return {
    id,
    kind: 'document',
    name,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ext: '.docx',
    size: bytes.byteLength,
    isPlainText: false,
    bytes,
  };
}

function makeTxtAttachment(id = 'doc-txt-1', name = 'notes.txt') {
  const textContent = 'Hello Panelize document upload!';
  const bytes = new TextEncoder().encode(textContent).buffer;
  return {
    id,
    kind: 'document',
    name,
    type: 'text/plain',
    ext: '.txt',
    size: bytes.byteLength,
    isPlainText: true,
    bytes,
    textContent,
  };
}

function makeImageAttachment(id = 'img-1', name = 'diagram.png') {
  return {
    id,
    kind: 'image',
    name,
    type: 'image/png',
    ext: '.png',
    size: 68,
    dataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
  };
}

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 10, left: 10, right: 100, bottom: 40, width: 90, height: 30 }),
  });
}

function dispatchDocFill({
  attachments,
  text = '',
  autoSubmit = false,
  requestId = 'doc-req-1',
  retry = false,
  providerMode = null,
}) {
  const images = attachments.filter((a) => a.kind === 'image');
  dispatchMultiPanelMessage({
    type: 'INJECT_TEXT_WITH_IMAGES',
    context: 'multi-panel',
    images,
    attachments,
    text,
    autoSubmit,
    requestId,
    retry,
    ...(providerMode ? { providerMode } : {}),
  });
}

describe('provider document upload adapters (Tier A + Tier B)', () => {
  beforeAll(() => {
    window.eval(chatgptComposerSource);
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  // ===== Tier A: ChatGPT, Claude, Gemini, DeepSeek, Kimi, Grok =====

  it('ChatGPT: prefers [data-testid="file-upload-input"] matching accept and injects PDF ArrayBuffer', async () => {
    window.happyDOM.setURL('https://chatgpt.com/');
    document.body.innerHTML = `
      <form>
        <input id="img-only" type="file" accept="image/*" />
        <input id="doc-input" type="file" data-testid="file-upload-input" multiple />
        <div id="prompt-textarea" contenteditable="true"></div>
      </form>
    `;
    const uploaded = [];
    const docInput = document.getElementById('doc-input');
    docInput.addEventListener('change', () => {
      uploaded.push({ name: docInput.files[0].name, type: docInput.files[0].type, size: docInput.files[0].size });
    });

    const promptEl = document.getElementById('prompt-textarea');
    markVisible(promptEl);
    const pdf = makePdfAttachment();
    dispatchDocFill({ attachments: [pdf], text: 'Summarize PDF', requestId: 'chatgpt-pdf' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(uploaded).toEqual([{ name: 'paper.pdf', type: 'application/pdf', size: pdf.size }]);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PANELIZE_ACTION_RESULT',
        requestId: 'chatgpt-pdf',
        provider: 'chatgpt',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Claude: injects DOCX via file input after matching accept', async () => {
    window.happyDOM.setURL('https://claude.ai/new');
    document.body.innerHTML = `
      <fieldset>
        <input id="claude-file" type="file" accept=".pdf,.docx,.txt,image/*" />
        <div class="ProseMirror" contenteditable="true" role="textbox"></div>
      </fieldset>
    `;
    const uploaded = [];
    const fileInput = document.getElementById('claude-file');
    fileInput.addEventListener('change', () => uploaded.push(fileInput.files[0].name));

    dispatchDocFill({ attachments: [makeDocxAttachment()], requestId: 'claude-docx' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(uploaded).toEqual(['spec.docx']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'claude-docx',
        provider: 'claude',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-docx-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini: acknowledges a single document drop only after a filename chip appears', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <div class="input-area">
        <div id="gemini-uploads"></div>
        <div class="ql-editor" contenteditable="true"></div>
      </div>
    `;
    const editor = document.querySelector('.ql-editor');
    const pasteSpy = vi.fn();
    const dropSpy = vi.fn();
    editor.addEventListener('paste', pasteSpy);
    editor.addEventListener('drop', (e) => {
      const name = e.dataTransfer?.files?.[0]?.name;
      dropSpy(name);
      setTimeout(() => {
        const chip = document.createElement('div');
        chip.className = 'file-preview-chip';
        chip.dataset.fileName = name;
        chip.textContent = name;
        document.getElementById('gemini-uploads').append(chip);
      }, 400);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-pdf-drop' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(pasteSpy).not.toHaveBeenCalled();
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledWith('paper.pdf');
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-pdf-drop',
        provider: 'gemini',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini: reports preview-timeout when no page handler consumes the document drop', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `<div class="ql-editor" contenteditable="true"></div>`;
    const dropSpy = vi.fn();
    document.querySelector('.ql-editor').addEventListener('drop', dropSpy);

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-pdf-drop-unhandled' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'gemini-pdf-drop-unhandled' }),
      EXTENSION_ORIGIN
    );

    await vi.advanceTimersByTimeAsync(10000);
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-pdf-drop-unhandled',
        provider: 'gemini',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini: never counts a page-level "Upload failed" alert as a document preview', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <div class="input-area">
        <div id="gemini-uploads"></div>
        <div class="ql-editor" contenteditable="true"></div>
      </div>
    `;
    const editor = document.querySelector('.ql-editor');
    const dropSpy = vi.fn();
    editor.addEventListener('drop', (e) => {
      const name = e.dataTransfer?.files?.[0]?.name;
      dropSpy(name);
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.setAttribute('aria-label', `Upload failed: ${name}`);
      alert.textContent = `Upload failed: ${name}`;
      document.body.append(alert);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-pdf-drop-alert' });
    await vi.advanceTimersByTimeAsync(13000);

    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'gemini-pdf-drop-alert', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-pdf-drop-alert',
        provider: 'gemini',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini: prefers real file input for documents when present', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <div>
        <input id="gemini-file" type="file" multiple />
        <div class="ql-editor" contenteditable="true"></div>
      </div>
    `;
    const fileInput = document.getElementById('gemini-file');
    const uploaded = [];
    fileInput.addEventListener('change', () => uploaded.push(fileInput.files[0].name));

    dispatchDocFill({ attachments: [makeTxtAttachment()], requestId: 'gemini-txt-input' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(uploaded).toEqual(['notes.txt']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-txt-input',
        provider: 'gemini',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini Hydrogen: clicks Upload & tools (never Open sidebar), routes .docx + .png to accept-matched hidden-file-input, dismisses overlay with Escape, confirms extension-stripped Unicode chip, and respects retry cleared check', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <header>
        <button
          id="open-sidebar-decoy"
          type="button"
          aria-label="Open sidebar"
          data-test-id="side-nav-sparkle-button"
          class="mdc-icon-button mat-mdc-icon-button"
        >
          <mat-icon fonticon="menu"></mat-icon>
        </button>
      </header>
      <main>
        <input-container>
          <div id="gemini-hydrogen-previews"></div>
          <div class="xap-uploader-dropzone" file-drop-zone>
            <div class="ql-editor" contenteditable="true" role="textbox"></div>
          </div>
          <uploader>
            <button
              id="gemini-upload-tools"
              type="button"
              aria-label="Upload & tools"
              class="mdc-icon-button mat-mdc-icon-button"
            >
              <mat-icon fonticon="add"></mat-icon>
            </button>
          </uploader>
        </input-container>
      </main>
    `;

    const sidebarBtn = document.getElementById('open-sidebar-decoy');
    const uploadToolsBtn = document.getElementById('gemini-upload-tools');
    const editor = document.querySelector('.ql-editor');
    const previewsHost = document.getElementById('gemini-hydrogen-previews');
    [sidebarBtn, uploadToolsBtn, editor].forEach(markVisible);

    const sidebarClickSpy = vi.fn();
    sidebarBtn.addEventListener('click', sidebarClickSpy);

    const docUploads = [];
    const imgUploads = [];
    const uploadToolsClickSpy = vi.fn();

    uploadToolsBtn.addEventListener('click', () => {
      uploadToolsClickSpy();
      if (document.querySelector('.cdk-overlay-pane')) return;
      const overlay = document.createElement('div');
      overlay.className = 'cdk-overlay-pane';
      overlay.innerHTML = `
        <div role="menu" class="mat-mdc-menu-panel">
          <button type="button" data-test-id="local-images-files-uploader-button">Upload files</button>
        </div>
      `;
      const docInput1 = document.createElement('input');
      docInput1.type = 'file';
      docInput1.multiple = true;
      docInput1.className = 'hidden-file-input';
      docInput1.accept = '.txt,.pdf,.doc,.docx,.md,.csv,.json,.yaml,.yml,.xml,.tsv';
      docInput1.addEventListener('change', () => {
        const file = docInput1.files[0];
        docUploads.push(file.name);
        const stem = file.name.replace(/\.[^.]+$/, '');
        const chip = document.createElement('uploader-file-preview');
        chip.className = 'file-preview-chip ng-star-inserted';
        chip.innerHTML = `
          <span>DOCX</span>
          <span class="gem-attachment-text gds-body-s">${stem}</span>
          <button type="button" aria-label="close ${stem}"></button>
        `;
        previewsHost.append(chip);
      });

      const imgInput = document.createElement('input');
      imgInput.type = 'file';
      imgInput.multiple = true;
      imgInput.className = 'hidden-file-input ng-star-inserted';
      imgInput.accept = 'image/*,video/*';
      imgInput.addEventListener('change', () => {
        const file = imgInput.files[0];
        imgUploads.push(file.name);
        const chip = document.createElement('uploader-file-preview');
        chip.className = 'file-preview-chip ng-star-inserted';
        chip.innerHTML = `<img src="blob:https://gemini.google.com/${encodeURIComponent(file.name)}" alt="Preview" />`;
        previewsHost.append(chip);
      });

      const docInput2 = document.createElement('input');
      docInput2.type = 'file';
      docInput2.multiple = true;
      docInput2.className = 'hidden-file-input ng-star-inserted';
      docInput2.accept = '.txt,.pdf,.doc,.docx';

      overlay.append(docInput1, imgInput, docInput2);
      document.body.append(overlay);
    });

    const onEscape = (event) => {
      if (event.key === 'Escape') {
        document.querySelector('.cdk-overlay-pane')?.remove();
      }
    };
    document.addEventListener('keydown', onEscape);

    const cjkDocx = makeDocxAttachment('doc-cjk-1', '日本中部京都红叶之旅_图文行程(1).docx');
    const pngImg = makeImageAttachment('img-1', 'diagram.png');
    try {
      dispatchDocFill({
        attachments: [cjkDocx, pngImg],
        text: 'Summarize trip and diagram',
        requestId: 'gemini-hydrogen-mixed',
      });
      await vi.advanceTimersByTimeAsync(4000);

      expect(sidebarClickSpy).not.toHaveBeenCalled();
      expect(uploadToolsClickSpy).toHaveBeenCalled();
      expect(docUploads).toEqual(['日本中部京都红叶之旅_图文行程(1).docx']);
      expect(imgUploads).toEqual(['diagram.png']);
      expect(document.querySelector('.cdk-overlay-pane')).toBeNull();
      expect(editor.textContent).toContain('Summarize trip and diagram');
      expect(window.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'gemini-hydrogen-mixed',
          provider: 'gemini',
          status: 'succeeded',
          succeededAttachmentIds: ['doc-cjk-1', 'img-1'],
        }),
        EXTENSION_ORIGIN
      );

      // Retry when editor text is cleared while extension-stripped <uploader-file-preview> chips remain must NOT re-upload.
      editor.textContent = '';
      window.parent.postMessage.mockClear();
      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        images: [],
        attachments: [],
        fallbackAttachments: [cjkDocx, pngImg],
        text: 'Summarize trip and diagram',
        autoSubmit: false,
        retry: true,
        requestId: 'gemini-hydrogen-retry-untouched',
      });
      await vi.advanceTimersByTimeAsync(1500);
      expect(docUploads).toEqual(['日本中部京都红叶之旅_图文行程(1).docx']);
      expect(imgUploads).toEqual(['diagram.png']);
      expect(window.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'gemini-hydrogen-retry-untouched',
          provider: 'gemini',
          status: 'succeeded',
          succeededAttachmentIds: ['doc-cjk-1', 'img-1'],
        }),
        EXTENSION_ORIGIN
      );

      // Once both text and preview chips are cleared, retry MUST re-upload fallbackAttachments.
      editor.textContent = '';
      previewsHost.replaceChildren();
      window.parent.postMessage.mockClear();
      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        images: [],
        attachments: [],
        fallbackAttachments: [cjkDocx],
        text: 'Restored trip prompt',
        autoSubmit: false,
        retry: true,
        requestId: 'gemini-hydrogen-retry-cleared',
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(docUploads).toEqual([
        '日本中部京都红叶之旅_图文行程(1).docx',
        '日本中部京都红叶之旅_图文行程(1).docx',
      ]);
      expect(window.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'gemini-hydrogen-retry-cleared',
          provider: 'gemini',
          status: 'succeeded',
          succeededAttachmentIds: ['doc-cjk-1'],
        }),
        EXTENSION_ORIGIN
      );
    } finally {
      document.removeEventListener('keydown', onEscape);
    }
  });

  it('Gemini Hydrogen: never counts a rejection snackbar/alert as preview evidence after hidden-file-input upload', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <button
        id="open-sidebar-decoy"
        type="button"
        aria-label="Open sidebar"
        data-test-id="side-nav-sparkle-button"
        class="mdc-icon-button mat-mdc-icon-button"
      >
        <mat-icon fonticon="menu"></mat-icon>
      </button>
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <uploader>
          <button id="gemini-upload-tools" type="button" aria-label="Upload & tools">
            <mat-icon fonticon="add"></mat-icon>
          </button>
        </uploader>
      </input-container>
    `;
    const sidebarBtn = document.getElementById('open-sidebar-decoy');
    const uploadToolsBtn = document.getElementById('gemini-upload-tools');
    [sidebarBtn, uploadToolsBtn].forEach(markVisible);

    const sidebarClickSpy = vi.fn();
    sidebarBtn.addEventListener('click', sidebarClickSpy);
    uploadToolsBtn.addEventListener('click', () => {
      if (document.querySelector('.cdk-overlay-pane')) return;
      const overlay = document.createElement('div');
      overlay.className = 'cdk-overlay-pane';
      const docInput = document.createElement('input');
      docInput.type = 'file';
      docInput.multiple = true;
      docInput.className = 'hidden-file-input';
      docInput.accept = '.txt,.pdf,.doc,.docx';
      docInput.addEventListener('change', () => {
        const stem = docInput.files[0].name.replace(/\.[^.]+$/, '');
        const snack = document.createElement('mat-snack-bar-container');
        snack.setAttribute('role', 'alert');
        snack.innerHTML = `<span class="gem-attachment-text">Upload failed: ${stem}</span>`;
        document.body.append(snack);
      });
      overlay.append(docInput);
      document.body.append(overlay);
    });

    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-1', 'hydrogen-doc.pdf')],
      requestId: 'gemini-hydrogen-rejection-alert',
    });
    await vi.advanceTimersByTimeAsync(13000);

    expect(sidebarClickSpy).not.toHaveBeenCalled();
    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'gemini-hydrogen-rejection-alert', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-hydrogen-rejection-alert',
        provider: 'gemini',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Gemini Hydrogen: falls back to div.xap-uploader-dropzone[file-drop-zone] when no file input mounts and confirms extension-stripped chip', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = `
      <input-container>
        <div id="gemini-drop-previews"></div>
        <div class="xap-uploader-dropzone" file-drop-zone>
          <div class="ql-editor" contenteditable="true" role="textbox"></div>
        </div>
      </input-container>
    `;
    const dropzone = document.querySelector('div.xap-uploader-dropzone[file-drop-zone]');
    const editor = document.querySelector('.ql-editor');
    const editorDropSpy = vi.fn((event) => event.stopPropagation());
    editor.addEventListener('drop', editorDropSpy);
    const dropzoneDropSpy = vi.fn((event) => {
      const name = event.dataTransfer?.files?.[0]?.name || '';
      const stem = name.replace(/\.[^.]+$/, '');
      const chip = document.createElement('uploader-file-preview');
      chip.className = 'file-preview-chip ng-star-inserted';
      chip.innerHTML = `<span>PDF</span><span class="gem-attachment-text gds-body-s">${stem}</span>`;
      document.getElementById('gemini-drop-previews').append(chip);
    });
    dropzone.addEventListener('drop', dropzoneDropSpy);

    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-1', 'hydrogen-doc.pdf')],
      requestId: 'gemini-hydrogen-dropzone-fallback',
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(editorDropSpy).not.toHaveBeenCalled();
    expect(dropzoneDropSpy).toHaveBeenCalledTimes(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'gemini-hydrogen-dropzone-fallback',
        provider: 'gemini',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('DeepSeek: injects PDF through composer input and confirms non-image filename preview', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    document.body.innerHTML = `
      <main id="deepseek-composer">
        <textarea placeholder="Message DeepSeek"></textarea>
        <input id="deepseek-file" type="file" multiple accept=".pdf,.docx,.txt,image/*" />
        <div id="deepseek-previews"></div>
      </main>
    `;
    const fileInput = document.getElementById('deepseek-file');
    fileInput.addEventListener('change', () => {
      const chip = document.createElement('div');
      chip.className = 'ds-file-card';
      chip.dataset.fileName = fileInput.files[0].name;
      chip.textContent = fileInput.files[0].name;
      document.getElementById('deepseek-previews').append(chip);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], text: 'Analyze this', requestId: 'deepseek-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'deepseek-pdf',
        provider: 'deepseek',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('DeepSeek: confirms live 2026-11 hashed-class .ds-animated-size-item cards across multi-document uploads and retry checks', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    document.body.innerHTML = `
      <div class="_9a2f8e4">
        <div class="aaff8b8f">
          <div class="_77cefa5 _9996a53 _1d5e44c">
            <div id="ds-live-attachments"></div>
            <div class="_020ab5b">
              <div class="_24fad49">
                <textarea class="_27c9245 ds-scroll-area ds-scroll-area--show-on-focus-within ds-scroll-area--enabled d96f2d2a" placeholder="Message DeepSeek" rows="2" autocomplete="off" name="search"></textarea>
              </div>
            </div>
            <div class="bf38813a">
              <input id="ds-live-file" type="file" multiple accept=".wxml,.pdf,.png,.txt,.md,.csv,.doc,.docx" />
            </div>
          </div>
        </div>
      </div>
    `;
    const fileInput = document.getElementById('ds-live-file');
    const attachmentsHost = document.getElementById('ds-live-attachments');
    const uploaded = [];
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      uploaded.push(file.name);
      const extLabel = file.name.split('.').pop().toUpperCase();
      const item = document.createElement('div');
      item.className = 'ds-animated-size-item';
      item.innerHTML = `
        <div class="_25c7358 dafb6286">
          <div class="cd314545">
            <div class="_158cea4">
              <div class="_967f3f9">
                <div class="e70accd6">${file.name}</div>
              </div>
              ${extLabel} 626B
            </div>
          </div>
        </div>
      `;
      attachmentsHost.append(item);
    });

    const attachments = [
      makePdfAttachment('doc-pdf-1', 'sample.pdf'),
      makeDocxAttachment('doc-docx-1', 'sample.docx'),
      makeTxtAttachment('doc-txt-1', 'sample.txt'),
    ];
    dispatchDocFill({ attachments, text: 'Summarize all three', requestId: 'deepseek-live-multi' });
    await vi.advanceTimersByTimeAsync(4000);

    expect(uploaded).toEqual(['sample.pdf', 'sample.docx', 'sample.txt']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'deepseek-live-multi',
        provider: 'deepseek',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1', 'doc-docx-1', 'doc-txt-1'],
      }),
      EXTENSION_ORIGIN
    );

    // Retry when text was cleared but live .ds-animated-size-item cards remain must NOT re-upload.
    document.querySelector('textarea').value = '';
    window.parent.postMessage.mockClear();
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      context: 'multi-panel',
      images: [],
      attachments: [],
      fallbackAttachments: attachments,
      text: 'Summarize all three',
      autoSubmit: false,
      retry: true,
      requestId: 'deepseek-live-retry-untouched',
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(uploaded).toEqual(['sample.pdf', 'sample.docx', 'sample.txt']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'deepseek-live-retry-untouched',
        provider: 'deepseek',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1', 'doc-docx-1', 'doc-txt-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('DeepSeek: rejects uploading/error .ds-animated-size-item cards and alert banners as preview evidence', async () => {
    window.happyDOM.setURL('https://chat.deepseek.com/');
    document.body.innerHTML = `
      <div class="_77cefa5 _9996a53 _1d5e44c">
        <div id="ds-live-attachments"></div>
        <div class="_020ab5b">
          <div class="_24fad49">
            <textarea class="_27c9245 ds-scroll-area" placeholder="Message DeepSeek"></textarea>
          </div>
        </div>
        <div class="bf38813a">
          <input id="ds-live-file" type="file" multiple accept=".pdf,.docx,.txt" />
        </div>
      </div>
    `;
    const fileInput = document.getElementById('ds-live-file');
    const attachmentsHost = document.getElementById('ds-live-attachments');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      const item = document.createElement('div');
      item.className = 'ds-animated-size-item';
      item.innerHTML = `
        <div class="_25c7358 uploading">
          <div class="e70accd6">${file.name}</div>
          Parsing...
        </div>
      `;
      attachmentsHost.append(item);
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = `Upload failed: ${file.name}`;
      document.body.append(alert);
    });

    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-1', 'sample.pdf')],
      requestId: 'deepseek-live-pending-reject',
    });
    await vi.advanceTimersByTimeAsync(13000);

    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'deepseek-live-pending-reject', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'deepseek-live-pending-reject',
        provider: 'deepseek',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Kimi: injects PDF through hidden multi-file input and recognizes non-image file card preview', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    document.body.innerHTML = `
      <div id="chat-box">
        <div class="chat-editor">
          <div class="chat-input-editor" contenteditable="true"></div>
          <input class="hidden-input" type="file" multiple />
          <div id="kimi-previews"></div>
        </div>
      </div>
    `;
    const fileInput = document.querySelector('input.hidden-input');
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = 'file-card success';
      card.textContent = fileInput.files[0].name;
      document.getElementById('kimi-previews').append(card);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'kimi-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf',
        provider: 'kimi',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Kimi: does not count errored or loading cards through a nested filename title', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    document.body.innerHTML = `
      <div id="chat-box">
        <div class="chat-editor">
          <div class="chat-input-editor" contenteditable="true"></div>
          <input class="hidden-input" type="file" multiple />
          <div id="kimi-previews"></div>
        </div>
      </div>
    `;
    const fileInput = document.querySelector('input.hidden-input');
    let nextState = 'error';
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = `file-card ${nextState}`;
      const title = document.createElement('div');
      title.className = 'file-card-title';
      title.title = fileInput.files[0].name;
      title.textContent = fileInput.files[0].name;
      card.append(title);
      document.getElementById('kimi-previews').append(card);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'kimi-pdf-error-card' });
    await vi.advanceTimersByTimeAsync(12000);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf-error-card',
        provider: 'kimi',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );

    // A wrapper-level pending state also hides the nested title.
    document.getElementById('kimi-previews').replaceChildren();
    window.parent.postMessage.mockClear();
    nextState = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'upload-wrapper uploading';
    document.getElementById('kimi-previews').append(wrapper);
    fileInput.addEventListener('change', () => {
      const last = document.getElementById('kimi-previews').lastElementChild;
      if (last !== wrapper) wrapper.append(last);
    });

    dispatchDocFill({ attachments: [makePdfAttachment('doc-pdf-2', 'other.pdf')], requestId: 'kimi-pdf-uploading-card' });
    await vi.advanceTimersByTimeAsync(12000);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf-uploading-card',
        provider: 'kimi',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Kimi: never counts a .file-card-list wrapper around an errored card as a completed card', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    document.body.innerHTML = `
      <div id="chat-box">
        <div class="chat-editor">
          <div class="chat-input-editor" contenteditable="true"></div>
          <input class="hidden-input" type="file" multiple />
          <div id="kimi-previews"></div>
        </div>
      </div>
    `;
    const fileInput = document.querySelector('input.hidden-input');
    let nextState = 'error';
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = `file-card ${nextState}`;
      const title = document.createElement('div');
      title.className = 'file-card-title';
      title.title = fileInput.files[0].name;
      title.textContent = fileInput.files[0].name;
      card.append(title);
      const list = document.createElement('div');
      list.className = 'file-card-list';
      list.append(card);
      document.getElementById('kimi-previews').append(list);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'kimi-pdf-error-list' });
    await vi.advanceTimersByTimeAsync(12000);
    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'kimi-pdf-error-list', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf-error-list',
        provider: 'kimi',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );

    // A successful card inside the same list wrapper is still counted.
    document.getElementById('kimi-previews').replaceChildren();
    window.parent.postMessage.mockClear();
    nextState = 'success';
    dispatchDocFill({ attachments: [makePdfAttachment('doc-pdf-2', 'other.pdf')], requestId: 'kimi-pdf-success-list' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf-success-list',
        provider: 'kimi',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-2'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Kimi: counts a successful card once even when its title and attributes both name the file', async () => {
    window.happyDOM.setURL('https://www.kimi.com/');
    document.body.innerHTML = `
      <div id="chat-box">
        <div class="chat-editor">
          <div class="chat-input-editor" contenteditable="true"></div>
          <input class="hidden-input" type="file" multiple />
          <div id="kimi-previews"></div>
        </div>
      </div>
    `;
    const fileInput = document.querySelector('input.hidden-input');
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = 'file-card success';
      card.setAttribute('aria-label', fileInput.files[0].name);
      const title = document.createElement('div');
      title.className = 'file-card-title';
      title.title = fileInput.files[0].name;
      title.textContent = fileInput.files[0].name;
      card.append(title);
      document.getElementById('kimi-previews').append(card);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'kimi-pdf-nested-success' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'kimi-pdf-nested-success',
        provider: 'kimi',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Grok: injects mixed image + PDF through composer input and confirms previews', async () => {
    window.happyDOM.setURL('https://grok.com/');
    document.body.innerHTML = `
      <form id="grok-composer">
        <input id="grok-file" type="file" multiple />
        <div role="list" aria-label="Conversation attachments"></div>
        <div data-testid="chat-input"><div class="tiptap" contenteditable="true"></div></div>
        <button type="button" aria-label="Attach">Attach</button>
      </form>
    `;
    const fileInput = document.getElementById('grok-file');
    const list = document.querySelector('[aria-label="Conversation attachments"]');
    const uploaded = [];
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      uploaded.push(file.name);
      const item = document.createElement('div');
      item.dataset.fileName = file.name;
      list.append(item);
    });

    dispatchDocFill({
      attachments: [makeImageAttachment(), makePdfAttachment()],
      requestId: 'grok-mixed',
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(uploaded).toEqual(['diagram.png', 'paper.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'grok-mixed',
        provider: 'grok',
        status: 'succeeded',
        succeededAttachmentIds: ['img-1', 'doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Grok: finds mounted input outside form/.O-uuEq_composer without clicking "+", confirms Attachments region, and respects composer-cleared checks', async () => {
    window.happyDOM.setURL('https://grok.com/');
    document.body.innerHTML = `
      <div class="grok-9f619 grok-78zum5 grok-dt5ytf grok-euugli grok-1n2onr6 grok-87ps6o grok-h8yej3">
        <input id="grok-live-file" class="hidden" multiple="" type="file" />
        <div class="O-uuEq_composer">
          <form>
            <div id="grok-attachments-slot"></div>
            <div><div><div><div><div>
              <div role="textbox" aria-label="Message Grok" contenteditable="true" class="tiptap ProseMirror w-full px-2 bg-transparent focus:outline-none text-fg-primary"></div>
            </div></div></div></div></div>
            <button id="grok-plus-btn" type="button" aria-label="Add files, skills, and connectors">+</button>
          </form>
        </div>
      </div>
    `;
    const fileInput = document.getElementById('grok-live-file');
    const plusBtn = document.getElementById('grok-plus-btn');
    const plusClickSpy = vi.fn();
    markVisible(plusBtn);
    plusBtn.addEventListener('click', plusClickSpy);

    const uploaded = [];
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      uploaded.push(file.name);
      let region = document.querySelector('div[role="region"][aria-label="Attachments"]');
      if (!region) {
        region = document.createElement('div');
        region.setAttribute('role', 'region');
        region.setAttribute('aria-label', 'Attachments');
        const listWrapper = document.createElement('div');
        listWrapper.className = 'attachments-strip';
        region.append(listWrapper);
        document.getElementById('grok-attachments-slot').append(region);
      }
      const card = document.createElement('div');
      card.innerHTML = `
        <span>${file.name}</span>
        <span>626 B</span>
        <button type="button" aria-label="Open ${file.name}">Open</button>
        <button type="button" aria-label="Remove ${file.name}">Remove</button>
      `;
      region.firstElementChild.append(card);
    });

    const attachments = [
      makePdfAttachment('doc-pdf-1', 'sample.pdf'),
      makeDocxAttachment('doc-docx-1', 'sample.docx'),
      makeImageAttachment('img-1', 'diagram.png'),
    ];
    dispatchDocFill({ attachments, text: 'Inspect files', requestId: 'grok-live-multi' });
    await vi.advanceTimersByTimeAsync(4000);

    expect(plusClickSpy).not.toHaveBeenCalled();
    expect(uploaded).toEqual(['sample.pdf', 'sample.docx', 'diagram.png']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'grok-live-multi',
        provider: 'grok',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1', 'doc-docx-1', 'img-1'],
      }),
      EXTENSION_ORIGIN
    );

    // Retry when editor text is cleared but Attachments region still holds files must NOT re-upload.
    const editor = document.querySelector('[role="textbox"][aria-label="Message Grok"]');
    editor.textContent = '';
    window.parent.postMessage.mockClear();
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      context: 'multi-panel',
      images: [],
      attachments: [],
      fallbackAttachments: [attachments[0]],
      text: 'Inspect files',
      autoSubmit: false,
      retry: true,
      requestId: 'grok-live-retry-untouched',
    });
    await vi.advanceTimersByTimeAsync(1500);
    expect(uploaded).toEqual(['sample.pdf', 'sample.docx', 'diagram.png']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'grok-live-retry-untouched',
        provider: 'grok',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );

    // Once the user clears both editor text and the Attachments region, retry MUST re-upload fallbackAttachments.
    editor.textContent = '';
    document.querySelector('div[role="region"][aria-label="Attachments"]').remove();
    window.parent.postMessage.mockClear();
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      context: 'multi-panel',
      images: [],
      attachments: [],
      fallbackAttachments: [attachments[0]],
      text: 'Restored prompt',
      autoSubmit: false,
      retry: true,
      requestId: 'grok-live-retry-cleared',
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(uploaded).toEqual(['sample.pdf', 'sample.docx', 'diagram.png', 'sample.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'grok-live-retry-cleared',
        provider: 'grok',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Grok: never counts an upload-failed alert banner as a live attachment preview', async () => {
    window.happyDOM.setURL('https://grok.com/');
    document.body.innerHTML = `
      <div class="grok-9f619 grok-78zum5">
        <input id="grok-live-file" class="hidden" multiple="" type="file" />
        <div class="O-uuEq_composer">
          <form>
            <div><div><div><div><div>
              <div role="textbox" aria-label="Message Grok" contenteditable="true" class="tiptap ProseMirror"></div>
            </div></div></div></div></div>
            <button type="button" aria-label="Add files, skills, and connectors">+</button>
          </form>
        </div>
      </div>
    `;
    const fileInput = document.getElementById('grok-live-file');
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.setAttribute('aria-label', `Upload failed: ${file.name}`);
      alert.textContent = `Upload failed: ${file.name}`;
      document.body.append(alert);
    });

    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-1', 'sample.pdf')],
      requestId: 'grok-live-alert-reject',
    });
    await vi.advanceTimersByTimeAsync(13000);

    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'grok-live-alert-reject', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'grok-live-alert-reject',
        provider: 'grok',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  // ===== Tier B: Doubao, Qwen CN/Global, ChatGLM, Z.ai, Yuanbao, AI Studio, Google AI Mode, Google Search =====

  it('Doubao: injects PDF and confirms file card preview', async () => {
    window.happyDOM.setURL('https://www.doubao.com/chat/');
    document.body.innerHTML = `
      <div id="input-engine-container">
        <textarea placeholder="发消息..."></textarea>
        <input id="doubao-file" type="file" multiple />
      </div>
    `;
    const fileInput = document.getElementById('doubao-file');
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = 'file-card';
      card.textContent = fileInput.files[0].name;
      document.getElementById('input-engine-container').append(card);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'doubao-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'doubao-pdf',
        provider: 'doubao',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Qwen China: matches generic document input and confirms filename preview', async () => {
    window.happyDOM.setURL('https://www.qianwen.com/');
    document.body.innerHTML = `
      <div data-chat-input-layout="true">
        <div data-chat-input-body="true">
          <div data-slate-editor="true" contenteditable="true" role="textbox"></div>
        </div>
        <input id="qwen-img" type="file" accept="image/*" />
        <input id="qwen-doc" type="file" accept=".pdf,.docx,.txt" />
      </div>
    `;
    const docInput = document.getElementById('qwen-doc');
    docInput.addEventListener('change', () => {
      const chip = document.createElement('div');
      chip.className = 'file-chip';
      chip.textContent = docInput.files[0].name;
      document.querySelector('[data-chat-input-layout="true"]').append(chip);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'qwen-cn-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'qwen-cn-pdf',
        provider: 'qwen-cn',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Qwen Global: uses #filesUpload for documents instead of paste', async () => {
    window.happyDOM.setURL('https://chat.qwen.ai/');
    document.body.innerHTML = `
      <div class="message-input-container">
        <input id="filesUpload" type="file" multiple />
        <textarea class="message-input-textarea"></textarea>
        <div id="previews"></div>
      </div>
    `;
    const fileInput = document.getElementById('filesUpload');
    fileInput.addEventListener('change', () => {
      const card = document.createElement('div');
      card.className = 'file-item';
      card.textContent = fileInput.files[0].name;
      document.getElementById('previews').append(card);
    });

    dispatchDocFill({ attachments: [makeTxtAttachment()], requestId: 'qwen-global-txt' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'qwen-global-txt',
        provider: 'qwen-global',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Qwen Global: delivers document via composer form drop when React #filesUpload ignores synthetic change', async () => {
    window.happyDOM.setURL('https://chat.qwen.ai/');
    document.body.innerHTML = `
      <div id="qwen-root">
        <form id="qwen-composer-form">
          <div class="message-input-container">
            <input id="filesUpload" multiple aria-label="Upload files" type="file" style="display: none;" />
            <textarea class="message-input-textarea message-input-textarea-separation"></textarea>
            <div id="qwen-doc-previews"></div>
          </div>
        </form>
      </div>
    `;
    const form = document.getElementById('qwen-composer-form');
    const dropped = [];
    form.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      dropped.push(file.name);
      const card = document.createElement('div');
      card.className = 'uploaded-doc-card';
      card.innerHTML = `<span>${file.name}</span>`;
      document.getElementById('qwen-doc-previews').append(card);
    });

    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-1', 'qwen-drop.pdf')],
      text: 'Summarize Qwen PDF',
      requestId: 'qwen-global-drop-form',
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(dropped).toEqual(['qwen-drop.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'qwen-global-drop-form',
        provider: 'qwen-global',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Qwen Global: falls back to textarea composer wrapper drop when no form exists and rejects error alert banners', async () => {
    window.happyDOM.setURL('https://chat.qwen.ai/');
    document.body.innerHTML = `
      <div id="qwen-root">
        <div id="qwen-composer-outer">
          <div class="message-input-container">
            <input id="filesUpload" multiple aria-label="Upload files" type="file" style="display: none;" />
            <textarea class="message-input-textarea message-input-textarea-separation"></textarea>
            <div id="qwen-doc-previews"></div>
          </div>
        </div>
      </div>
    `;
    const outer = document.getElementById('qwen-composer-outer');
    let rejectNext = false;
    const dropped = [];
    outer.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      dropped.push(file.name);
      if (rejectNext) {
        const alert = document.createElement('div');
        alert.setAttribute('role', 'alert');
        alert.textContent = `Upload failed: ${file.name}`;
        document.body.append(alert);
        return;
      }
      const chip = document.createElement('div');
      chip.className = 'composer-doc-pill';
      chip.innerHTML = `<span>${file.name}</span>`;
      document.getElementById('qwen-doc-previews').append(chip);
    });

    dispatchDocFill({
      attachments: [makeDocxAttachment('doc-docx-1', 'qwen-wrapper.docx')],
      requestId: 'qwen-global-drop-wrapper',
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(dropped).toEqual(['qwen-wrapper.docx']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'qwen-global-drop-wrapper',
        provider: 'qwen-global',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-docx-1'],
      }),
      EXTENSION_ORIGIN
    );

    rejectNext = true;
    window.parent.postMessage.mockClear();
    dispatchDocFill({
      attachments: [makePdfAttachment('doc-pdf-2', 'rejected.pdf')],
      requestId: 'qwen-global-alert-reject',
    });
    await vi.advanceTimersByTimeAsync(13000);

    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'qwen-global-alert-reject', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'qwen-global-alert-reject',
        provider: 'qwen-global',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('ChatGLM: injects document into el-upload input and confirms file-list item', async () => {
    window.happyDOM.setURL('https://chatglm.cn/main/alltoolsdetail');
    document.body.innerHTML = `
      <div id="search-input-box">
        <textarea class="scroll-display-none"></textarea>
        <input class="el-upload__input" type="file" />
        <div class="file-list-box-content-list"></div>
      </div>
    `;
    const fileInput = document.querySelector('input.el-upload__input');
    fileInput.addEventListener('change', () => {
      const item = document.createElement('div');
      item.textContent = fileInput.files[0].name;
      document.querySelector('.file-list-box-content-list').append(item);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'chatglm-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'chatglm-pdf',
        provider: 'chatglm',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Z.ai Global: matches document input and confirms .chip-scroll chip, or skips when image-only', async () => {
    window.happyDOM.setURL('https://chat.z.ai/');
    document.body.innerHTML = `
      <div>
        <textarea placeholder="How can I help you today?"></textarea>
        <input id="zai-file" type="file" multiple accept=".png,.jpg,.pdf,.docx" />
        <div class="chip-scroll"></div>
      </div>
    `;
    const fileInput = document.getElementById('zai-file');
    fileInput.addEventListener('change', () => {
      const chip = document.createElement('div');
      chip.dataset.cy = 'file';
      chip.textContent = fileInput.files[0].name;
      document.querySelector('.chip-scroll').append(chip);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'zai-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'zai-pdf',
        provider: 'zai-global',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Yuanbao: clicks Upload File menu item for documents and confirms FileList item', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat');
    document.body.innerHTML = `
      <div id="yb-composer">
        <div class="chat-command-editor-specail">
          <div class="ql-editor" contenteditable="true" data-placeholder="Ask"></div>
        </div>
        <button data-new-input-control="add-tools-trigger">+</button>
        <div id="yb-list"></div>
      </div>
    `;
    const trigger = document.querySelector('[data-new-input-control="add-tools-trigger"]');
    markVisible(trigger);
    trigger.addEventListener('click', () => {
      const menuItem = document.createElement('button');
      menuItem.setAttribute('role', 'menuitem');
      menuItem.textContent = '上传文件';
      markVisible(menuItem);
      menuItem.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.pdf,.docx,.txt';
        input.addEventListener('change', () => {
          const card = document.createElement('div');
          card.className = 'FileList_inputFileListItem__abc';
          card.textContent = input.files[0].name;
          document.getElementById('yb-list').append(card);
        });
        document.body.append(input);
      });
      document.body.append(menuItem);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'yuanbao-pdf' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'yuanbao-pdf',
        provider: 'yuanbao',
        status: 'succeeded',
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Studio: uploads PDF via file input and skips DOCX when input only accepts PDF/images', async () => {
    window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
    document.body.innerHTML = `
      <ms-prompt-box>
        <textarea formcontrolname="promptText"></textarea>
        <input id="aistudio-file" type="file" accept="image/*,.pdf,.txt,.csv" />
      </ms-prompt-box>
    `;
    const uploaded = [];
    const fileInput = document.getElementById('aistudio-file');
    fileInput.addEventListener('change', () => uploaded.push(fileInput.files[0].name));

    dispatchDocFill({
      attachments: [makePdfAttachment(), makeDocxAttachment()],
      text: 'Compare',
      requestId: 'aistudio-pdf-and-docx',
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(uploaded).toEqual(['paper.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'aistudio-pdf-and-docx',
        provider: 'aistudio',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
        skippedAttachments: [{ id: 'doc-docx-1', name: 'spec.docx', reason: 'type-not-accepted' }],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Studio: acknowledges a dropped document only after its filename preview appears', async () => {
    window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
    document.body.innerHTML = `
      <ms-prompt-box>
        <div id="aistudio-chunks"></div>
        <div class="prompt-box-container" msfilecopypaste>
          <textarea formcontrolname="promptText"></textarea>
        </div>
      </ms-prompt-box>
    `;
    const dropTarget = document.querySelector('[msfilecopypaste]');
    const dropped = [];
    dropTarget.addEventListener('drop', (e) => {
      const name = e.dataTransfer?.files?.[0]?.name;
      dropped.push(name);
      setTimeout(() => {
        const chunk = document.createElement('div');
        chunk.className = 'file-chunk';
        chunk.dataset.fileName = name;
        chunk.textContent = name;
        document.getElementById('aistudio-chunks').append(chunk);
      }, 300);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'aistudio-pdf-drop' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(dropped).toEqual(['paper.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'aistudio-pdf-drop',
        provider: 'aistudio',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Studio: reports preview-timeout when the document drop produces no preview', async () => {
    window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
    document.body.innerHTML = `
      <ms-prompt-box>
        <div class="prompt-box-container" msfilecopypaste>
          <textarea formcontrolname="promptText"></textarea>
        </div>
      </ms-prompt-box>
    `;

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'aistudio-pdf-drop-unhandled' });
    await vi.advanceTimersByTimeAsync(12500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'aistudio-pdf-drop-unhandled',
        provider: 'aistudio',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Studio: never counts an "Upload failed" alert or failure banner as a document preview', async () => {
    window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
    document.body.innerHTML = `
      <ms-prompt-box>
        <div id="aistudio-chunks"></div>
        <div class="prompt-box-container" msfilecopypaste>
          <textarea formcontrolname="promptText"></textarea>
        </div>
      </ms-prompt-box>
    `;
    const dropTarget = document.querySelector('[msfilecopypaste]');
    const dropped = [];
    dropTarget.addEventListener('drop', (e) => {
      const name = e.dataTransfer?.files?.[0]?.name;
      dropped.push(name);
      const alert = document.createElement('div');
      alert.setAttribute('role', 'alert');
      alert.textContent = `Upload failed: ${name}`;
      document.body.append(alert);
      // A banner without an alert role still carries failure wording.
      const banner = document.createElement('div');
      banner.className = 'upload-banner';
      banner.setAttribute('title', `Upload failed: ${name}`);
      banner.textContent = `Upload failed: ${name}`;
      document.getElementById('aistudio-chunks').append(banner);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'aistudio-pdf-drop-alert' });
    await vi.advanceTimersByTimeAsync(13000);

    expect(dropped).toEqual(['paper.pdf']);
    expect(window.parent.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'aistudio-pdf-drop-alert', status: 'succeeded' }),
      EXTENSION_ORIGIN
    );
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'aistudio-pdf-drop-alert',
        provider: 'aistudio',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Mode: still skips an incompatible DOCX when Escape unmounts the "+" menu inputs', async () => {
    window.happyDOM.setURL('https://www.google.com/search?udm=50');
    document.body.innerHTML = `
      <div id="google-composer">
        <textarea class="ITIRGe" aria-label="Ask anything"></textarea>
        <button id="menu-btn" aria-haspopup="menu" aria-expanded="false">+</button>
      </div>
    `;
    const menuBtn = document.getElementById('menu-btn');
    markVisible(menuBtn);
    menuBtn.addEventListener('click', () => {
      menuBtn.setAttribute('aria-expanded', 'true');
      const menu = document.createElement('div');
      menu.id = 'google-plus-menu';
      const imgInput = document.createElement('input');
      imgInput.type = 'file';
      imgInput.accept = 'image/png,image/jpeg';
      const pdfInput = document.createElement('input');
      pdfInput.type = 'file';
      pdfInput.accept = '.pdf,application/pdf';
      menu.append(imgInput, pdfInput);
      document.body.append(menu);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      menuBtn.setAttribute('aria-expanded', 'false');
      document.getElementById('google-plus-menu')?.remove();
    }, true);

    dispatchDocFill({
      attachments: [makeDocxAttachment()],
      providerMode: 'ai',
      requestId: 'google-ai-docx-escape',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(document.getElementById('google-plus-menu')).toBeNull();
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-ai-docx-escape',
        provider: 'google',
        status: 'skipped',
        reason: 'type-not-accepted',
        skippedAttachments: [{ id: 'doc-docx-1', name: 'spec.docx', reason: 'type-not-accepted' }],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google AI Mode: routes PDF to the PDF input in "+" menu and skips unsupported DOCX', async () => {
    window.happyDOM.setURL('https://www.google.com/search?udm=50');
    document.body.innerHTML = `
      <div id="google-composer">
        <textarea class="ITIRGe" aria-label="Ask anything"></textarea>
        <button id="menu-btn" aria-haspopup="menu" aria-expanded="false">+</button>
      </div>
    `;
    const menuBtn = document.getElementById('menu-btn');
    markVisible(menuBtn);
    const uploads = [];
    menuBtn.addEventListener('click', () => {
      menuBtn.setAttribute('aria-expanded', 'true');
      if (document.getElementById('google-pdf-input')) return;
      const imgInput = document.createElement('input');
      imgInput.type = 'file';
      imgInput.accept = 'image/png,image/jpeg';
      const pdfInput = document.createElement('input');
      pdfInput.id = 'google-pdf-input';
      pdfInput.type = 'file';
      pdfInput.accept = '.pdf,application/pdf';
      pdfInput.addEventListener('change', () => uploads.push(pdfInput.files[0].name));
      document.body.append(imgInput, pdfInput);
    });

    dispatchDocFill({
      attachments: [makePdfAttachment()],
      providerMode: 'ai',
      requestId: 'google-ai-pdf',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(uploads).toEqual(['paper.pdf']);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-ai-pdf',
        provider: 'google',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      }),
      EXTENSION_ORIGIN
    );

    window.parent.postMessage.mockClear();
    dispatchDocFill({
      attachments: [makeDocxAttachment()],
      providerMode: 'ai',
      requestId: 'google-ai-docx-skip',
    });
    await vi.advanceTimersByTimeAsync(2000);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-ai-docx-skip',
        provider: 'google',
        status: 'skipped',
        reason: 'type-not-accepted',
        skippedAttachments: [{ id: 'doc-docx-1', name: 'spec.docx', reason: 'type-not-accepted' }],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google Search mode returns status "skipped" for document-only and succeeds with skippedAttachments when text is present', async () => {
    window.happyDOM.setURL('https://www.google.com/');
    document.body.innerHTML = `<input name="q" />`;

    dispatchDocFill({
      attachments: [makePdfAttachment()],
      text: '',
      providerMode: 'search',
      requestId: 'google-search-doc-only',
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-search-doc-only',
        provider: 'google',
        status: 'skipped',
        reason: 'unsupported',
        skippedAttachments: [{ id: 'doc-pdf-1', name: 'paper.pdf', reason: 'unsupported' }],
      }),
      EXTENSION_ORIGIN
    );

    window.parent.postMessage.mockClear();
    dispatchDocFill({
      attachments: [makePdfAttachment()],
      text: 'search query text',
      providerMode: 'search',
      requestId: 'google-search-text-plus-doc',
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(document.querySelector('input[name="q"]').value).toBe('search query text');
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-search-text-plus-doc',
        provider: 'google',
        status: 'succeeded',
        skippedAttachments: [{ id: 'doc-pdf-1', name: 'paper.pdf', reason: 'unsupported' }],
      }),
      EXTENSION_ORIGIN
    );
  });
  it('Google Search mode fails with control-not-found when the caption cannot be written', async () => {
    window.happyDOM.setURL('https://www.google.com/');
    document.body.innerHTML = `<div id="no-search-box"></div>`;

    dispatchDocFill({
      attachments: [makePdfAttachment()],
      text: 'search query text',
      providerMode: 'search',
      requestId: 'google-search-no-input',
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-search-no-input',
        provider: 'google',
        status: 'failed',
        reason: 'control-not-found',
        skippedAttachments: [{ id: 'doc-pdf-1', name: 'paper.pdf', reason: 'unsupported' }],
      }),
      EXTENSION_ORIGIN
    );
  });

  it('Google Search mode does not duplicate the caption on Retry Failed', async () => {
    window.happyDOM.setURL('https://www.google.com/');
    document.body.innerHTML = `<input name="q" />`;

    dispatchDocFill({
      attachments: [makePdfAttachment()],
      text: 'search query text',
      providerMode: 'search',
      requestId: 'google-search-first',
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(document.querySelector('input[name="q"]').value).toBe('search query text');

    window.parent.postMessage.mockClear();
    dispatchDocFill({
      attachments: [makePdfAttachment()],
      text: 'search query text',
      providerMode: 'search',
      requestId: 'google-search-retry',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(document.querySelector('input[name="q"]').value).toBe('search query text');
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'google-search-retry',
        provider: 'google',
        status: 'succeeded',
        skippedAttachments: [{ id: 'doc-pdf-1', name: 'paper.pdf', reason: 'unsupported' }],
      }),
      EXTENSION_ORIGIN
    );
  });

  // ===== Item #16 regression guards: Gemini Hydrogen + Qwen Global routing =====

  const getLastActionResult = () =>
    window.parent.postMessage.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'PANELIZE_ACTION_RESULT')
      .at(-1);

  const dispatchRetryWithFallback = (requestId, ...fallbackAttachments) =>
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      context: 'multi-panel',
      images: [],
      attachments: [],
      fallbackAttachments,
      text: 'Retry prompt',
      retry: true,
      autoSubmit: false,
      requestId,
    });

  const mountGemini = (markup) => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = markup;
    document.querySelectorAll('button, textarea, .ql-editor').forEach(markVisible);
  };

  const mountQwenGlobal = (markup) => {
    window.happyDOM.setURL('https://chat.qwen.ai/');
    document.body.innerHTML = markup;
    document.querySelectorAll('button, textarea').forEach(markVisible);
  };

  it('Qwen Global: waits for a consumed composer drop instead of re-sending the document through #filesUpload', async () => {
    mountQwenGlobal(`
      <form>
        <textarea class="message-input-textarea"></textarea>
        <input type="file" id="filesUpload" multiple />
      </form>
    `);
    const form = document.querySelector('form');
    const calls = [];
    const addCard = () => form.insertAdjacentHTML('beforeend', '<div class="file-item">paper.pdf</div>');
    form.addEventListener('drop', (event) => {
      event.preventDefault();
      calls.push('drop');
      setTimeout(addCard, 1400);
    });
    document.getElementById('filesUpload').addEventListener('change', () => {
      calls.push('change');
      addCard();
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'qwen-global-slow-drop' });
    await vi.advanceTimersByTimeAsync(16000);

    expect(calls).toEqual(['drop']);
    expect(document.querySelectorAll('.file-item')).toHaveLength(1);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'qwen-global-slow-drop',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      })
    );
  });

  it('Qwen Global: retry never credits an inline "Upload failed" alert as a staged document', async () => {
    mountQwenGlobal(`
      <div class="message-input-container">
        <div><textarea class="message-input-textarea"></textarea></div>
        <input type="file" id="filesUpload" multiple />
        <div role="alert" class="file-error">Upload failed: paper.pdf</div>
      </div>
    `);
    const dropSpy = vi.fn();
    document.querySelector('.message-input-container').addEventListener('drop', dropSpy);

    dispatchRetryWithFallback('qwen-global-alert-retry', makePdfAttachment());
    await vi.advanceTimersByTimeAsync(14000);

    expect(dropSpy).toHaveBeenCalledTimes(1);
    const result = getLastActionResult();
    expect(result.requestId).toBe('qwen-global-alert-retry');
    expect(result.status).toBe('failed');
    expect(result.succeededAttachmentIds).toEqual([]);
  });

  it('Gemini: ignores an unrelated <aside> image input and keeps the classic document drop fallback', async () => {
    mountGemini(`
      <aside><input type="file" accept="image/*" /></aside>
      <div class="input-area-container">
        <div class="ql-editor" contenteditable="true"></div>
        <button aria-label="Upload file">+</button>
      </div>
    `);
    const calls = [];
    document.querySelector('aside input').addEventListener('change', () => calls.push('aside'));
    document.querySelector('.ql-editor').addEventListener('drop', () => {
      calls.push('drop');
      document
        .querySelector('.input-area-container')
        .insertAdjacentHTML('beforeend', '<div class="file-chip">paper.pdf</div>');
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-aside-doc' });
    await vi.advanceTimersByTimeAsync(16000);

    expect(calls).toEqual(['drop']);
    const result = getLastActionResult();
    expect(result.status).toBe('succeeded');
    expect(result.succeededAttachmentIds).toEqual(['doc-pdf-1']);
    expect(result.skippedAttachments).toBeUndefined();
  });

  it('Gemini: never clicks an attachment chip remove button while looking for the upload trigger', async () => {
    mountGemini(`
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <div class="file-preview-chip"><button aria-label="close upload plan">x</button></div>
        <uploader>
          <button id="localized-upload" aria-label="Dateien hinzufügen"><mat-icon fonticon="add"></mat-icon></button>
        </uploader>
      </input-container>
    `);
    const picked = [];
    const removeBtn = document.querySelector('.file-preview-chip button');
    removeBtn.addEventListener('click', () => {
      picked.push('removed');
      removeBtn.parentElement.remove();
    });
    document.getElementById('localized-upload').addEventListener('click', () => {
      picked.push('upload');
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div class="cdk-overlay-pane"><input type="file" class="hidden-file-input" accept=".pdf,.docx" /></div>'
      );
      document.querySelector('.cdk-overlay-pane input').addEventListener('change', () => {
        document
          .querySelector('input-container')
          .insertAdjacentHTML('beforeend', '<uploader-file-preview class="file-preview-chip"><span class="gem-attachment-text">paper</span></uploader-file-preview>');
      });
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-chip-remove' });
    await vi.advanceTimersByTimeAsync(16000);

    expect(picked).toEqual(['upload']);
    expect(document.querySelector('button[aria-label="close upload plan"]')).not.toBeNull();
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({ status: 'succeeded', succeededAttachmentIds: ['doc-pdf-1'] })
    );
  });

  it('Gemini: a one-letter stem never erases the failure wording of an "Upload failed: a.pdf" chip', async () => {
    mountGemini('<input-container><div class="ql-editor" contenteditable="true" role="textbox"></div></input-container>');
    document.querySelector('.ql-editor').addEventListener('drop', () => {
      document
        .querySelector('input-container')
        .insertAdjacentHTML('beforeend', '<div class="file-preview-chip">Upload failed: a.pdf</div>');
    });

    dispatchDocFill({ attachments: [makePdfAttachment('a', 'a.pdf')], requestId: 'gemini-short-stem' });
    await vi.advanceTimersByTimeAsync(16000);

    const result = getLastActionResult();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('preview-timeout');
    expect(result.succeededAttachmentIds).toEqual([]);
  });

  it('Gemini: two CJK documents sharing a displayed stem each confirm their own new chip', async () => {
    mountGemini(`
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <input type="file" class="hidden-file-input" accept=".pdf,.docx" />
      </input-container>
    `);
    document.querySelector('input[type="file"]').addEventListener('change', () => {
      document
        .querySelector('input-container')
        .insertAdjacentHTML('beforeend', '<uploader-file-preview class="file-preview-chip"><span class="gem-attachment-text">日本(1)</span></uploader-file-preview>');
    });

    dispatchDocFill({
      attachments: [makePdfAttachment('a', '日本(1).pdf'), makeDocxAttachment('b', '日本(1).docx')],
      requestId: 'gemini-cjk-same-stem',
    });
    await vi.advanceTimersByTimeAsync(16000);

    expect(getLastActionResult()).toEqual(
      expect.objectContaining({ status: 'succeeded', succeededAttachmentIds: ['a', 'b'] })
    );
  });

  it('Gemini: retry reconciles one retained "sample" chip with only one of sample.pdf / sample.docx', async () => {
    mountGemini(`
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <input type="file" class="hidden-file-input" accept=".pdf,.docx" />
        <uploader-file-preview class="file-preview-chip"><span>PDF</span><span class="gem-attachment-text">sample</span></uploader-file-preview>
      </input-container>
    `);
    const uploaded = [];
    const fileInput = document.querySelector('input[type="file"]');
    fileInput.addEventListener('change', () => {
      uploaded.push(fileInput.files[0].name);
      document
        .querySelector('input-container')
        .insertAdjacentHTML('beforeend', '<uploader-file-preview class="file-preview-chip"><span>DOCX</span><span class="gem-attachment-text">sample</span></uploader-file-preview>');
    });

    dispatchRetryWithFallback(
      'gemini-retry-partial',
      makePdfAttachment('a', 'sample.pdf'),
      makeDocxAttachment('b', 'sample.docx')
    );
    await vi.advanceTimersByTimeAsync(16000);

    expect(uploaded).toEqual(['sample.docx']);
    expect(document.querySelectorAll('uploader-file-preview')).toHaveLength(2);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'gemini-retry-partial',
        status: 'succeeded',
        succeededAttachmentIds: ['a', 'b'],
      })
    );

    // Both chips now retained: a second retry must not upload anything again.
    document.querySelector('.ql-editor').textContent = '';
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback(
      'gemini-retry-all-retained',
      makePdfAttachment('a', 'sample.pdf'),
      makeDocxAttachment('b', 'sample.docx')
    );
    await vi.advanceTimersByTimeAsync(3000);

    expect(uploaded).toEqual(['sample.docx']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'gemini-retry-all-retained',
        status: 'succeeded',
        succeededAttachmentIds: ['a', 'b'],
      })
    );
  });

  it('Gemini: dismisses the opened upload menu by sending Escape to the menu element itself', async () => {
    mountGemini(`
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <uploader><button aria-label="Upload &amp; tools">+</button></uploader>
      </input-container>
    `);
    document.querySelector('uploader button').addEventListener('click', () => {
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div class="cdk-overlay-pane"><div role="menu"><input type="file" class="hidden-file-input" accept=".pdf,.docx" /></div></div>'
      );
      const menu = document.querySelector('[role="menu"]');
      menu.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') menu.parentElement.remove();
      });
      menu.querySelector('input').addEventListener('change', () => {
        document
          .querySelector('input-container')
          .insertAdjacentHTML('beforeend', '<div class="file-preview-chip">paper.pdf</div>');
      });
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-menu-escape' });
    await vi.advanceTimersByTimeAsync(16000);

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({ status: 'succeeded', succeededAttachmentIds: ['doc-pdf-1'] })
    );
  });

  // ===== v2.3.2 live-QA regressions: Zhipu GLM-5.4 UI, Gemini multi-doc remount, Yuanbao "Local Files" =====

  // `renderName` returns the card's visible `.upload-card__name` text, or null for an
  // unnamed (image-only) card, mirroring GLM-5.4's truncated / extension-less labels.
  const mountChatGLMGlm54 = ({ cardState = 'done', layoutClass = '', renderName = (name) => name } = {}) => {
    window.happyDOM.setURL('https://chatglm.cn/');
    // The profile avatar dialog input precedes the composer in DOM order, like the live page.
    document.body.innerHTML = `
      <div class="user-profile-edit-dialogs">
        <input class="user-profile-edit-dialogs__hidden-input" type="file" accept="image/*" />
      </div>
      <header><button type="button" class="back-to-legacy">返回旧版</button></header>
      <main class="${layoutClass}">
        <div class="input-area">
          <div class="upload-attachment-picker">
            <input type="file" class="file-input" multiple="" />
            <div class="upload-list"></div>
          </div>
          <div class="el-textarea">
            <textarea class="el-textarea__inner" tabindex="0" autocomplete="off" placeholder="和我聊聊天吧～" rows="2"></textarea>
          </div>
          <button type="button" class="tool-icon-button tool-icon-button--add-menu" aria-label="添加"></button>
          <button type="button" class="send-button send-button--disabled" aria-label="发送"></button>
        </div>
      </main>
    `;
    const editor = document.querySelector('textarea.el-textarea__inner');
    const fileInput = document.querySelector('input.file-input');
    const decoyInput = document.querySelector('.user-profile-edit-dialogs__hidden-input');
    const sendButton = document.querySelector('button.send-button');
    const uploadList = document.querySelector('.upload-list');
    document.querySelectorAll('button, textarea').forEach(markVisible);

    const uploaded = [];
    const decoyUploads = [];
    decoyInput.addEventListener('change', () => decoyUploads.push(decoyInput.files[0]?.name));
    fileInput.addEventListener('change', () => {
      const name = fileInput.files[0].name;
      uploaded.push(name);
      const card = document.createElement('div');
      card.className = cardState === 'error' ? 'upload-card upload-card--error' : 'upload-card';
      const displayName = renderName(name);
      card.innerHTML = displayName === null
        ? `<img alt="" src="blob:https://chatglm.cn/${encodeURIComponent(name)}" />`
        : `
        <div class="upload-card__info">
          <div class="upload-card__name">${displayName}</div>
        </div>
      `;
      uploadList.append(card);
    });
    editor.addEventListener('input', () => {
      sendButton.classList.toggle('send-button--disabled', !editor.value.trim());
    });

    return { editor, fileInput, decoyInput, sendButton, uploadList, uploaded, decoyUploads };
  };

  it('Zhipu GLM-5.4 UI: fills the el-textarea composer and clicks the send-button only once it is enabled', async () => {
    const { editor, sendButton } = mountChatGLMGlm54();
    const sendClicks = vi.fn();
    sendButton.addEventListener('click', sendClicks);

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });
    expect(sendClicks).not.toHaveBeenCalled();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello glm-5.4',
      autoSubmit: false,
      context: 'multi-panel',
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(editor.value).toContain('hello glm-5.4');
    expect(sendButton.classList.contains('send-button--disabled')).toBe(false);

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });
    expect(sendClicks).toHaveBeenCalledTimes(1);
  });

  it('Zhipu GLM-5.4 UI: uploads mixed PDF + PNG to the composer file-input (never the profile avatar input) and confirms each upload-card', async () => {
    const { uploaded, decoyUploads, uploadList } = mountChatGLMGlm54();

    dispatchDocFill({
      attachments: [makePdfAttachment('zhipu-pdf', 'zhipu-test.pdf'), makeImageAttachment('zhipu-png', 'diagram.png')],
      text: 'Summarize both',
      requestId: 'chatglm-glm54-mixed',
    });
    await vi.advanceTimersByTimeAsync(4000);

    expect(decoyUploads).toEqual([]);
    expect(uploaded).toEqual(['zhipu-test.pdf', 'diagram.png']);
    expect(uploadList.querySelectorAll('.upload-card')).toHaveLength(2);
    expect(document.querySelector('textarea.el-textarea__inner').value).toContain('Summarize both');
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-mixed',
        provider: 'chatglm',
        status: 'succeeded',
        succeededAttachmentIds: ['zhipu-pdf', 'zhipu-png'],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: keeps the composer file-input even when a page wrapper class mentions settings or avatar', async () => {
    const { uploaded, decoyUploads } = mountChatGLMGlm54({ layoutClass: 'chat-settings-layout user-avatar-shell' });

    dispatchDocFill({
      attachments: [makePdfAttachment('zhipu-pdf', 'zhipu-test.pdf'), makeImageAttachment('zhipu-png', 'diagram.png')],
      requestId: 'chatglm-glm54-wrapper-class',
    });
    await vi.advanceTimersByTimeAsync(4000);

    expect(decoyUploads).toEqual([]);
    expect(uploaded).toEqual(['zhipu-test.pdf', 'diagram.png']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-wrapper-class',
        status: 'succeeded',
        succeededAttachmentIds: ['zhipu-pdf', 'zhipu-png'],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: never counts an error-state upload-card as a confirmed upload', async () => {
    const { uploaded } = mountChatGLMGlm54({ cardState: 'error' });

    dispatchDocFill({
      attachments: [makePdfAttachment('zhipu-pdf', 'zhipu-test.pdf')],
      requestId: 'chatglm-glm54-error-card',
    });
    await vi.advanceTimersByTimeAsync(13000);

    expect(uploaded).toEqual(['zhipu-test.pdf']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-error-card',
        provider: 'chatglm',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: a retry keeps a staged upload-card and re-uploads only once the composer is cleared', async () => {
    const { editor, uploaded, uploadList } = mountChatGLMGlm54();
    const pdf = makePdfAttachment('zhipu-pdf', 'zhipu-test.pdf');

    dispatchDocFill({ attachments: [pdf], requestId: 'chatglm-glm54-first' });
    await vi.advanceTimersByTimeAsync(2500);
    expect(uploaded).toEqual(['zhipu-test.pdf']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({ requestId: 'chatglm-glm54-first', status: 'succeeded' })
    );

    editor.value = '';
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('chatglm-glm54-retry-staged', pdf);
    await vi.advanceTimersByTimeAsync(2500);
    expect(uploaded).toEqual(['zhipu-test.pdf']);
    expect(editor.value).toContain('Retry prompt');
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-retry-staged',
        status: 'succeeded',
        succeededAttachmentIds: ['zhipu-pdf'],
      })
    );

    editor.value = '';
    uploadList.replaceChildren();
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('chatglm-glm54-retry-cleared', pdf);
    await vi.advanceTimersByTimeAsync(2500);
    expect(uploaded).toEqual(['zhipu-test.pdf', 'zhipu-test.pdf']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-retry-cleared',
        status: 'succeeded',
        succeededAttachmentIds: ['zhipu-pdf'],
      })
    );
  });

  it('Zhipu legacy UI: still routes mixed PDF + PNG through the el-upload input and file-list preview', async () => {
    window.happyDOM.setURL('https://chatglm.cn/main/alltoolsdetail');
    document.body.innerHTML = `
      <div class="user-profile-edit-dialogs">
        <input class="user-profile-edit-dialogs__hidden-input" type="file" accept="image/*" />
      </div>
      <div class="search-box-container">
        <div class="upload-popover"><input class="el-upload__input" type="file" multiple /></div>
        <div id="search-input-box">
          <textarea class="scroll-display-none"></textarea>
          <div class="enter is-main-chat"><div class="enter-icon-container"></div></div>
        </div>
      </div>
      <div class="file-list-box-content-list"></div>
    `;
    const fileInput = document.querySelector('input.el-upload__input');
    const decoyInput = document.querySelector('.user-profile-edit-dialogs__hidden-input');
    const sendButton = document.querySelector('.enter-icon-container');
    markVisible(sendButton);
    const uploaded = [];
    fileInput.addEventListener('change', () => {
      uploaded.push(fileInput.files[0].name);
      const item = document.createElement('div');
      item.className = 'file-list-box-content-list-item';
      document.querySelector('.file-list-box-content-list').append(item);
    });
    const mouseDowns = vi.fn();
    const clicks = vi.fn();
    sendButton.addEventListener('mousedown', mouseDowns);
    sendButton.addEventListener('click', clicks);

    dispatchDocFill({
      attachments: [makePdfAttachment(), makeImageAttachment()],
      text: 'Legacy prompt',
      autoSubmit: true,
      requestId: 'chatglm-legacy-mixed',
    });
    await vi.advanceTimersByTimeAsync(4000);

    expect(uploaded).toEqual(['paper.pdf', 'diagram.png']);
    expect(decoyInput.files).toHaveLength(0);
    expect(document.querySelector('textarea.scroll-display-none').value).toContain('Legacy prompt');
    expect(mouseDowns).toHaveBeenCalledTimes(1);
    expect(clicks).not.toHaveBeenCalled();
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-legacy-mixed',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1', 'img-1'],
      })
    );
  });

  /**
   * Gemini Hydrogen upload menu that, like the live CDK overlay, ignores trigger clicks
   * while a previous menu pane is still detaching. Escape unmounts the document inputs
   * at once but leaves the pane with its image/*,video/* input for STALE_PANE_MS.
   */
  const mountGeminiHydrogenWithLingeringOverlay = ({ withStalePane = false } = {}) => {
    const STALE_PANE_MS = 1000;
    mountGemini(`
      <main>
        <input-container>
          <div id="gemini-hydrogen-previews"></div>
          <div class="xap-uploader-dropzone" file-drop-zone>
            <div class="ql-editor" contenteditable="true" role="textbox"></div>
          </div>
          <uploader>
            <button id="gemini-upload-tools" type="button" aria-label="Upload &amp; tools">
              <mat-icon fonticon="add"></mat-icon>
            </button>
          </uploader>
        </input-container>
      </main>
    `);
    const previewsHost = document.getElementById('gemini-hydrogen-previews');
    const uploadToolsBtn = document.getElementById('gemini-upload-tools');
    const uploads = [];
    const triggerClicks = vi.fn();

    const addChip = (name, isImage) => {
      const chip = document.createElement('uploader-file-preview');
      chip.className = 'file-preview-chip ng-star-inserted';
      chip.innerHTML = isImage
        ? `<img src="blob:https://gemini.google.com/${encodeURIComponent(name)}" alt="Preview" />`
        : `<span class="gem-attachment-text gds-body-s">${name.replace(/\.[^.]+$/, '')}</span>`;
      previewsHost.append(chip);
    };
    const makeInput = (accept, isImage) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.className = 'hidden-file-input ng-star-inserted';
      input.accept = accept;
      input.addEventListener('change', () => {
        const name = input.files[0].name;
        uploads.push(name);
        addChip(name, isImage);
      });
      return input;
    };
    const mountPane = ({ includeDocInput }) => {
      const pane = document.createElement('div');
      pane.className = 'cdk-overlay-pane';
      pane.innerHTML = '<div role="menu" class="mat-mdc-menu-panel"></div>';
      if (includeDocInput) {
        const docInput = makeInput('.txt,.pdf,.doc,.docx,.md,.csv,.json', false);
        docInput.dataset.kind = 'doc';
        pane.append(docInput);
      }
      pane.append(makeInput('image/*,video/*', true));
      document.body.append(pane);
      return pane;
    };

    uploadToolsBtn.addEventListener('click', () => {
      triggerClicks();
      if (document.querySelector('.cdk-overlay-pane')) return;
      mountPane({ includeDocInput: true });
    });
    const beginDetach = (pane) => {
      pane.querySelectorAll('input[data-kind="doc"]').forEach((input) => input.remove());
      if (pane.dataset.detaching) return;
      pane.dataset.detaching = 'true';
      setTimeout(() => pane.remove(), STALE_PANE_MS);
    };
    const onEscape = (event) => {
      if (event.key !== 'Escape') return;
      const pane = document.querySelector('.cdk-overlay-pane');
      if (pane) beginDetach(pane);
    };
    document.addEventListener('keydown', onEscape);
    if (withStalePane) {
      beginDetach(mountPane({ includeDocInput: false }));
    }

    return { uploads, triggerClicks, cleanup: () => document.removeEventListener('keydown', onEscape) };
  };

  it('Gemini Hydrogen: re-mounts the document input when a detaching overlay only leaves an image/*,video/* input', async () => {
    const { uploads, triggerClicks, cleanup } = mountGeminiHydrogenWithLingeringOverlay({ withStalePane: true });
    try {
      expect(document.querySelectorAll('.cdk-overlay-pane input[type="file"]')).toHaveLength(1);
      expect(document.querySelector('.cdk-overlay-pane input').accept).toBe('image/*,video/*');

      dispatchDocFill({ attachments: [makePdfAttachment('sample-pdf', 'sample.pdf')], requestId: 'gemini-stale-overlay-pdf' });
      await vi.advanceTimersByTimeAsync(6000);
      expect(uploads).toEqual(['sample.pdf']);
      expect(triggerClicks.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(getLastActionResult()).toEqual(
        expect.objectContaining({
          requestId: 'gemini-stale-overlay-pdf',
          provider: 'gemini',
          status: 'succeeded',
          succeededAttachmentIds: ['sample-pdf'],
        })
      );
      expect(getLastActionResult().skippedAttachments).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('Gemini Hydrogen: uploads DOCX -> PDF -> TXT -> PNG sequentially without a type-not-accepted race', async () => {
    const { uploads, cleanup } = mountGeminiHydrogenWithLingeringOverlay();
    try {
      dispatchDocFill({
        attachments: [
          makeDocxAttachment('race-docx', '日本中部京都红叶之旅_测试(1).docx'),
          makePdfAttachment('race-pdf', 'sample.pdf'),
          makeTxtAttachment('race-txt', 'sample.txt'),
          makeImageAttachment('race-png', 'sample.png'),
        ],
        requestId: 'gemini-multi-doc-race',
      });
      await vi.advanceTimersByTimeAsync(15000);

      expect(uploads).toEqual(['日本中部京都红叶之旅_测试(1).docx', 'sample.pdf', 'sample.txt', 'sample.png']);
      const result = getLastActionResult();
      expect(result).toEqual(
        expect.objectContaining({
          requestId: 'gemini-multi-doc-race',
          provider: 'gemini',
          status: 'succeeded',
          succeededAttachmentIds: ['race-docx', 'race-pdf', 'race-txt', 'race-png'],
        })
      );
      expect(result.skippedAttachments).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('Gemini Hydrogen: still skips a document as type-not-accepted when a re-opened menu only offers image/*,video/*', async () => {
    mountGemini(`
      <input-container>
        <div class="ql-editor" contenteditable="true" role="textbox"></div>
        <uploader><button id="img-only-upload" aria-label="Upload &amp; tools">+</button></uploader>
      </input-container>
    `);
    const triggerClicks = vi.fn();
    document.getElementById('img-only-upload').addEventListener('click', () => {
      triggerClicks();
      if (document.querySelector('.cdk-overlay-pane')) return;
      document.body.insertAdjacentHTML(
        'beforeend',
        '<div class="cdk-overlay-pane"><div role="menu"><input type="file" class="hidden-file-input" accept="image/*,video/*" /></div></div>'
      );
    });
    const onEscape = (event) => {
      if (event.key === 'Escape') document.querySelector('.cdk-overlay-pane')?.remove();
    };
    document.addEventListener('keydown', onEscape);
    try {
      dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-image-only-menu' });
      await vi.advanceTimersByTimeAsync(6000);

      expect(triggerClicks).toHaveBeenCalledTimes(2);
      expect(document.querySelector('.cdk-overlay-pane')).toBeNull();
      expect(getLastActionResult()).toEqual(
        expect.objectContaining({
          requestId: 'gemini-image-only-menu',
          status: 'skipped',
          reason: 'type-not-accepted',
          skippedAttachments: [{ id: 'doc-pdf-1', name: 'paper.pdf', reason: 'type-not-accepted' }],
        })
      );
    } finally {
      document.removeEventListener('keydown', onEscape);
    }
  });

  it('Yuanbao English UI: picks the "Local Files" menu item for documents (never Upload Image or Tencent Docs)', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat');
    document.body.innerHTML = `
      <div id="yb-composer">
        <div class="chat-command-editor-specail">
          <div class="ql-editor" contenteditable="true" data-placeholder="Ask"></div>
        </div>
        <button data-new-input-control="add-tools-trigger">+</button>
        <div id="yb-list"></div>
      </div>
    `;
    const trigger = document.querySelector('[data-new-input-control="add-tools-trigger"]');
    markVisible(trigger);
    const menuClicks = [];
    const uploaded = [];
    trigger.addEventListener('click', () => {
      if (document.getElementById('yb-menu')) return;
      const menu = document.createElement('div');
      menu.id = 'yb-menu';
      ['Search', 'Upload Image', 'Local Files', 'Tencent Docs'].forEach((label) => {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.innerHTML = `<span class="icon"></span><span>${label}</span>`;
        markVisible(item);
        item.addEventListener('click', () => {
          menuClicks.push(label);
          if (label === 'Upload Image') {
            const imgInput = document.createElement('input');
            imgInput.type = 'file';
            imgInput.accept = 'image/*';
            document.body.append(imgInput);
          }
          if (label !== 'Local Files') return;
          const input = document.createElement('input');
          input.type = 'file';
          input.multiple = true;
          input.accept = '.pdf,.docx,.txt';
          input.addEventListener('change', () => {
            uploaded.push(input.files[0].name);
            const card = document.createElement('div');
            card.className = 'FileList_inputFileListItem__abc';
            card.textContent = input.files[0].name;
            document.getElementById('yb-list').append(card);
          });
          document.body.append(input);
        });
        menu.append(item);
      });
      document.body.append(menu);
    });

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'yuanbao-local-files' });
    await vi.advanceTimersByTimeAsync(2500);

    expect(menuClicks).toEqual(['Local Files']);
    expect(uploaded).toEqual(['paper.pdf']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-local-files',
        provider: 'yuanbao',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      })
    );
  });

  // ===== v2.3.2 fix round 2: Codex review P1s + live Yuanbao preview confirmation =====

  it('Gemini Hydrogen: re-opens once when a stale overlay present at the first click detaches during the initial wait', async () => {
    const { uploads, triggerClicks, cleanup } = mountGeminiHydrogenWithLingeringOverlay({ withStalePane: true });
    try {
      // Start the fill 700ms into the stale pane's 1000ms detach: it vanishes mid-wait.
      await vi.advanceTimersByTimeAsync(700);
      expect(document.querySelector('.cdk-overlay-pane')).not.toBeNull();
      dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'gemini-stale-overlay-fast-detach' });
      await vi.advanceTimersByTimeAsync(15000);

      expect(uploads).toEqual(['paper.pdf']);
      expect(triggerClicks).toHaveBeenCalledTimes(2);
      expect(getLastActionResult()).toEqual(
        expect.objectContaining({
          requestId: 'gemini-stale-overlay-fast-detach',
          status: 'succeeded',
          succeededAttachmentIds: ['doc-pdf-1'],
        })
      );
    } finally {
      cleanup();
    }
  });

  it('Zhipu GLM-5.4 UI: an earlier upload card settling never confirms a rejected PDF', async () => {
    const { uploadList, fileInput } = mountChatGLMGlm54({ cardState: 'error' });
    const old = document.createElement('div');
    old.className = 'upload-card upload-card--loading';
    old.innerHTML = '<span class="upload-card__name">old.png</span>';
    uploadList.append(old);
    fileInput.addEventListener('change', () => setTimeout(() => old.classList.remove('upload-card--loading'), 100));

    dispatchDocFill({ attachments: [makePdfAttachment()], requestId: 'chatglm-glm54-stale-card' });
    await vi.advanceTimersByTimeAsync(13000);

    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-stale-card',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: an already-loading unnamed image card settling never confirms a new image upload', async () => {
    const { uploadList, fileInput } = mountChatGLMGlm54({ cardState: 'error', renderName: () => null });
    const old = document.createElement('div');
    old.className = 'upload-card upload-card--loading';
    old.innerHTML = '<img alt="" src="blob:https://chatglm.cn/old" />';
    uploadList.append(old);
    fileInput.addEventListener('change', () => setTimeout(() => old.classList.remove('upload-card--loading'), 100));

    dispatchDocFill({ attachments: [makeImageAttachment()], requestId: 'chatglm-glm54-stale-image-card' });
    await vi.advanceTimersByTimeAsync(9000);

    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-stale-image-card',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: [],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: confirms DOCX + PDF + TXT + PNG with truncated, extension-less, and unnamed upload cards', async () => {
    const displayNames = {
      '日本中部京都红叶之旅_测试(1).docx': '日本中部京都红叶之旅_...',
      'sample.pdf': 'sample.pdf',
      'sample.txt': 'sample',
    };
    const { uploaded, uploadList, fileInput } = mountChatGLMGlm54({
      renderName: (name) => (name in displayNames ? displayNames[name] : null),
    });
    fileInput.addEventListener('change', () => {
      const card = uploadList.lastElementChild;
      card.classList.add('upload-card--loading');
      setTimeout(() => card.classList.remove('upload-card--loading'), 300);
    });

    dispatchDocFill({
      attachments: [
        makeDocxAttachment('glm-docx', '日本中部京都红叶之旅_测试(1).docx'),
        makePdfAttachment('glm-pdf', 'sample.pdf'),
        makeTxtAttachment('glm-txt', 'sample.txt'),
        makeImageAttachment('glm-png', 'sample.png'),
      ],
      requestId: 'chatglm-glm54-four-mixed',
    });
    await vi.advanceTimersByTimeAsync(8000);

    expect(uploaded).toEqual(['日本中部京都红叶之旅_测试(1).docx', 'sample.pdf', 'sample.txt', 'sample.png']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-four-mixed',
        status: 'succeeded',
        succeededAttachmentIds: ['glm-docx', 'glm-pdf', 'glm-txt', 'glm-png'],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: mixed named PDF and unnamed loading image both wait for settled cards', async () => {
    const { fileInput, uploadList } = mountChatGLMGlm54();
    fileInput.addEventListener('change', () => {
      if (fileInput.files[0].name !== 'diagram.png') return;
      const card = uploadList.lastElementChild;
      card.innerHTML = '<img alt="" src="blob:sample" />';
      card.classList.add('upload-card--loading');
      setTimeout(() => card.classList.remove('upload-card--loading'), 300);
    });

    dispatchDocFill({ attachments: [makePdfAttachment(), makeImageAttachment()], requestId: 'chatglm-glm54-unnamed-image' });
    await vi.advanceTimersByTimeAsync(3000);

    expect(getLastActionResult().succeededAttachmentIds).toEqual(['doc-pdf-1', 'img-1']);
  });

  it('Zhipu GLM-5.4 UI: a retry re-uploads a fallback PDF whose card was replaced by an unrelated upload', async () => {
    const { uploadList, uploaded } = mountChatGLMGlm54();
    const pdf = makePdfAttachment();
    dispatchDocFill({ attachments: [pdf], requestId: 'chatglm-glm54-unrelated-first' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(uploaded).toEqual(['paper.pdf']);

    uploadList.innerHTML = '<div class="upload-card"><span class="upload-card__name">other.png</span></div>';
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('chatglm-glm54-unrelated-retry', pdf);
    await vi.advanceTimersByTimeAsync(2500);

    expect(uploaded).toEqual(['paper.pdf', 'paper.pdf']);
    // The user's own other.png card stays staged.
    expect([...uploadList.querySelectorAll('.upload-card__name')].map((el) => el.textContent)).toEqual([
      'other.png',
      'paper.pdf',
    ]);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-unrelated-retry',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1'],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: a retry re-uploads only the missing fallback attachment and keeps the retained one', async () => {
    const { uploadList, uploaded } = mountChatGLMGlm54();
    const pdf = makePdfAttachment();
    const png = makeImageAttachment();
    dispatchDocFill({ attachments: [pdf, png], requestId: 'chatglm-glm54-partial-first' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(uploaded).toEqual(['paper.pdf', 'diagram.png']);

    [...uploadList.querySelectorAll('.upload-card')]
      .find((card) => card.textContent.includes('diagram.png'))
      .remove();
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('chatglm-glm54-partial-retry', pdf, png);
    await vi.advanceTimersByTimeAsync(3000);

    expect(uploaded).toEqual(['paper.pdf', 'diagram.png', 'diagram.png']);
    expect(uploadList.querySelectorAll('.upload-card')).toHaveLength(2);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'chatglm-glm54-partial-retry',
        status: 'succeeded',
        succeededAttachmentIds: ['doc-pdf-1', 'img-1'],
      })
    );
  });

  it('Zhipu GLM-5.4 UI: TRIGGER_SEND with a disabled send-button never falls back to an Enter keypress', () => {
    const { editor } = mountChatGLMGlm54();
    const enter = vi.fn();
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') enter();
    });

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });

    expect(enter).not.toHaveBeenCalled();
  });

  it('Zhipu GLM-5.4 UI: auto-submit keeps retrying while the send-button is disabled and clicks it once enabled', async () => {
    const { editor, sendButton } = mountChatGLMGlm54();
    let enterWhileDisabled = 0;
    const submitted = vi.fn();
    editor.addEventListener('input', () => {
      sendButton.classList.add('send-button--disabled');
      setTimeout(() => sendButton.classList.remove('send-button--disabled'), 1000);
    });
    editor.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (sendButton.classList.contains('send-button--disabled')) {
        enterWhileDisabled += 1;
        return;
      }
      submitted();
    });
    sendButton.addEventListener('click', submitted);

    dispatchMultiPanelMessage({ type: 'INJECT_TEXT', text: 'Slow GLM prompt', autoSubmit: true, context: 'multi-panel' });
    await vi.advanceTimersByTimeAsync(3000);

    expect(enterWhileDisabled).toBe(0);
    expect(submitted).toHaveBeenCalledOnce();
  });

  /**
   * Live yuanbao.tencent.com composer (captured 2026-11-25): document cards render the
   * extension-less name plus an uppercase type badge, image cards carry an
   * aria-label="预览图片<name>" and an https <img> without alt, and every card embeds a
   * "Re-upload" retry overlay that is display:none unless the upload failed.
   *
   * Live CDP probe: each `<input type="file">` is mounted lazily by its menu item and then
   * stays mounted across files, but its `change` handler is one-shot. Only clicking
   * Add -> "Local Files" / "Upload Image" again re-arms it; reusing the mounted input
   * without that click is silently ignored. The menu closes when an item is clicked.
   */
  const mountYuanbaoLive = ({ failedNames = [], ignoreImagesAfterDocs = false } = {}) => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat');
    document.body.innerHTML = `
      <div id="yb-composer">
        <div class="pl-[6px] empty:hidden" data-input-resource-area="true">
          <div class="FileList_inputFileList__tSu2d undefined">
            <div class="swiper swiper-initialized swiper-horizontal FileList_swiper__sJ7Ih">
              <div class="swiper-wrapper" id="yb-swiper"></div>
            </div>
          </div>
        </div>
        <div class="chat-command-editor-specail">
          <div class="ql-editor" contenteditable="true" data-placeholder="Ask"></div>
        </div>
        <button data-new-input-control="add-tools-trigger">+</button>
      </div>
    `;
    const swiper = document.getElementById('yb-swiper');
    const trigger = document.querySelector('[data-new-input-control="add-tools-trigger"]');
    markVisible(trigger);
    const uploaded = [];
    const menuClicks = [];

    const addDocCard = (name) => {
      const dot = name.lastIndexOf('.');
      const stem = name.slice(0, dot);
      const ext = name.slice(dot + 1).toUpperCase();
      const failed = failedNames.includes(name);
      const slide = document.createElement('div');
      slide.className = 'swiper-slide FileList_inputFileListSwiperItemFile__Sc3H_';
      slide.innerHTML = `
        <div class="FileList_inputFileListItem__sOOlP FileList_inputFileListItemPdf___5kgD bg-New-background-extra_hover">
          <div class="FileList_inputFileListItemPdfIcon__VuNEY">
            <img draggable="false" src="https://static.yuanbao.tencent.com/doc_normal_light.png" alt="icon">
            <div class="FileList_inputFileListItemStatus__J9y4A FileList_inputFileListItemStatusLocalFile__I_WrF"></div>
          </div>
          <div class="FileList_inputFileListItemPdfInfo__pnCZB">
            <div class="FileList_inputFileListItemPdfInfoName__2_V8V">${stem}</div>
            <div class="FileList_inputFileListItemPdfInfoDetail__OmXZC">
              <div class="FileList_finishShowCount__NY8SX">
                <span class="FileList_fileType__B0xTp">${ext}</span>
                <div class="FileList_divide__AzspK"></div>1.24KB
              </div>
            </div>
          </div>
          <div class="FileList_inputFileListItemClose__0Gnyx" aria-label="删除文件"></div>
          <div class="FileList_inputFileListItemRetry__9Y_yI" aria-label="重新上传文件" style="${failed ? '' : 'display: none;'}">
            <div class="FileList_retryIcon__6gEw8"></div>
            <div class="FileList_retryText__mfuYQ">Re-upload</div>
          </div>
        </div>
      `;
      swiper.append(slide);
    };
    const addImageCard = (name) => {
      const slide = document.createElement('div');
      slide.className = 'swiper-slide FileList_inputFileListSwiperItemImage__3Gj6L';
      slide.innerHTML = `
        <div class="FileList_inputFileListItem__sOOlP FileList_inputFileListItemImage__EF_2N" aria-label="预览图片${name}">
          <img src="https://hunyuan-prod-1258344703.cos.ap-guangzhou.myqcloud.com/${encodeURIComponent(name)}">
        </div>
      `;
      swiper.append(slide);
    };
    const pickers = new Map();
    const armPicker = (key, accept, onFile) => {
      let picker = pickers.get(key);
      if (!picker) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = accept;
        picker = { input, armed: false };
        input.addEventListener('change', () => {
          if (!picker.armed) return;
          picker.armed = false;
          const name = input.files[0].name;
          uploaded.push(name);
          setTimeout(() => onFile(name), 200);
        });
        document.body.append(input);
        pickers.set(key, picker);
      }
      picker.armed = true;
    };

    trigger.addEventListener('click', () => {
      document.querySelector('#yb-menu')?.remove();
      const menu = document.createElement('div');
      menu.id = 'yb-menu';
      ['Upload Image', 'Local Files', 'Tencent Docs'].forEach((label) => {
        const item = document.createElement('div');
        item.setAttribute('role', 'menuitem');
        item.textContent = label;
        markVisible(item);
        item.addEventListener('click', () => {
          menuClicks.push(label);
          menu.remove();
          if (label === 'Local Files') {
            armPicker('doc', '.pdf,.xls,.xlsx,.ppt,.pptx,.doc,.docx,.txt', addDocCard);
          } else if (label === 'Upload Image') {
            armPicker('image', '.jpg,.jpeg,.png,.webp,.bmp,.gif', (name) => {
              const hasDocs = swiper.querySelector('[class*="FileList_inputFileListSwiperItemFile__"]');
              if (ignoreImagesAfterDocs && hasDocs) return;
              addImageCard(name);
            });
          }
        });
        menu.append(item);
      });
      document.body.append(menu);
    });

    return { swiper, uploaded, menuClicks, pickers };
  };

  it('Yuanbao live UI: confirms a Local Files DOCX + PDF + TXT batch from extension-less names with hidden Re-upload overlays', async () => {
    const { uploaded, menuClicks } = mountYuanbaoLive();

    dispatchDocFill({
      attachments: [
        makeDocxAttachment('yb-docx', '日本中部京都红叶之旅_测试(1).docx'),
        makePdfAttachment('yb-pdf', 'sample.pdf'),
        makeTxtAttachment('yb-txt', 'sample.txt'),
      ],
      requestId: 'yuanbao-live-docs',
    });
    await vi.advanceTimersByTimeAsync(6000);

    expect(menuClicks).toEqual(['Local Files', 'Local Files', 'Local Files']);
    expect(uploaded).toEqual(['日本中部京都红叶之旅_测试(1).docx', 'sample.pdf', 'sample.txt']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-docs',
        provider: 'yuanbao',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-docx', 'yb-pdf', 'yb-txt'],
      })
    );
  });

  it('Yuanbao live UI: re-arms the one-shot Local Files input before every sequential document, including same-stem PDF + TXT', async () => {
    const { swiper, uploaded, menuClicks, pickers } = mountYuanbaoLive();

    dispatchDocFill({
      attachments: [
        makeDocxAttachment('yb-docx', '日本中部京都红叶之旅_测试(1).docx'),
        makePdfAttachment('yb-pdf', 'sample.pdf'),
        makeTxtAttachment('yb-txt', 'sample.txt'),
      ],
      requestId: 'yuanbao-live-rearm-docs',
    });
    await vi.advanceTimersByTimeAsync(6000);

    // The same mounted input serves every file; each one needed its own menu click.
    expect(pickers.size).toBe(1);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(menuClicks).toEqual(['Local Files', 'Local Files', 'Local Files']);
    expect(uploaded).toEqual(['日本中部京都红叶之旅_测试(1).docx', 'sample.pdf', 'sample.txt']);
    const cards = [...swiper.querySelectorAll('[class*="FileList_inputFileListItem__"]')];
    expect(cards.map((card) => card.querySelector('[class*="FileList_inputFileListItemPdfInfoName__"]').textContent))
      .toEqual(['日本中部京都红叶之旅_测试(1)', 'sample', 'sample']);
    expect(cards.map((card) => card.querySelector('[class*="FileList_fileType__"]').textContent))
      .toEqual(['DOCX', 'PDF', 'TXT']);
    expect(document.getElementById('yb-menu')).toBeNull();
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-rearm-docs',
        provider: 'yuanbao',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-docx', 'yb-pdf', 'yb-txt'],
      })
    );
  });

  it('Yuanbao live UI: re-arms the one-shot Upload Image input before every sequential image', async () => {
    const { swiper, uploaded, menuClicks, pickers } = mountYuanbaoLive();

    dispatchDocFill({
      attachments: [makeImageAttachment('yb-png-1', 'first.png'), makeImageAttachment('yb-png-2', 'second.png')],
      requestId: 'yuanbao-live-rearm-images',
    });
    await vi.advanceTimersByTimeAsync(6000);

    expect(pickers.size).toBe(1);
    expect(menuClicks).toEqual(['Upload Image', 'Upload Image']);
    expect(uploaded).toEqual(['first.png', 'second.png']);
    expect(swiper.querySelectorAll('[class*="FileList_inputFileListItemImage__"]')).toHaveLength(2);
    expect(document.getElementById('yb-menu')).toBeNull();
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-rearm-images',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-png-1', 'yb-png-2'],
      })
    );
  });

  it('Yuanbao live UI: confirms an Upload Image card identified by its aria-label and https <img> without alt', async () => {
    const { uploaded, menuClicks } = mountYuanbaoLive();

    dispatchDocFill({ attachments: [makeImageAttachment('yb-png', 'sample.png')], requestId: 'yuanbao-live-image' });
    await vi.advanceTimersByTimeAsync(4000);

    expect(menuClicks).toEqual(['Upload Image']);
    expect(uploaded).toEqual(['sample.png']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-image',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-png'],
      })
    );
  });

  it('Yuanbao live UI: a card with a visible Re-upload overlay never confirms, while a sibling with a hidden overlay does', async () => {
    mountYuanbaoLive({ failedNames: ['sample.txt'] });

    dispatchDocFill({
      attachments: [makePdfAttachment('yb-pdf', 'sample.pdf'), makeTxtAttachment('yb-txt', 'sample.txt')],
      requestId: 'yuanbao-live-failed-card',
    });
    await vi.advanceTimersByTimeAsync(15000);

    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-failed-card',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: ['yb-pdf'],
      })
    );
  });

  it('Yuanbao live UI: an image silently dropped after documents does not confirm', async () => {
    const { uploaded } = mountYuanbaoLive({ ignoreImagesAfterDocs: true });

    dispatchDocFill({
      attachments: [makePdfAttachment('yb-pdf', 'sample.pdf'), makeImageAttachment('yb-png', 'sample.png')],
      requestId: 'yuanbao-live-mixed',
    });
    await vi.advanceTimersByTimeAsync(12000);

    expect(uploaded).toEqual(['sample.pdf', 'sample.png']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-mixed',
        status: 'failed',
        reason: 'preview-timeout',
        succeededAttachmentIds: ['yb-pdf'],
      })
    );
  });

  it('Yuanbao live UI: a retry keeps staged cards and re-uploads only the fallback documents that are gone', async () => {
    const { swiper, uploaded } = mountYuanbaoLive();
    const pdf = makePdfAttachment('yb-pdf', 'sample.pdf');
    const txt = makeTxtAttachment('yb-txt', 'sample.txt');
    dispatchDocFill({ attachments: [pdf, txt], requestId: 'yuanbao-live-retry-first' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({ requestId: 'yuanbao-live-retry-first', status: 'succeeded' })
    );

    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('yuanbao-live-retry-staged', pdf, txt);
    await vi.advanceTimersByTimeAsync(5000);
    expect(uploaded).toEqual(['sample.pdf', 'sample.txt']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-retry-staged',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-pdf', 'yb-txt'],
      })
    );

    // Remove the TXT card only: its PDF sibling shares the "sample" stem but not the type badge.
    [...swiper.querySelectorAll('[class*="FileList_fileType__"]')]
      .find((badge) => badge.textContent === 'TXT')
      .closest('.swiper-slide')
      .remove();
    document.querySelector('.ql-editor').textContent = '';
    window.parent.postMessage.mockClear();
    dispatchRetryWithFallback('yuanbao-live-retry-partial', pdf, txt);
    await vi.advanceTimersByTimeAsync(5000);
    expect(uploaded).toEqual(['sample.pdf', 'sample.txt', 'sample.txt']);
    expect(getLastActionResult()).toEqual(
      expect.objectContaining({
        requestId: 'yuanbao-live-retry-partial',
        status: 'succeeded',
        succeededAttachmentIds: ['yb-pdf', 'yb-txt'],
      })
    );
  });
});
