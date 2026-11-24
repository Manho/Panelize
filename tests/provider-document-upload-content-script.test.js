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
});
