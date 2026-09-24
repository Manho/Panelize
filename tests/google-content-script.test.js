import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
}

function dispatchMultiPanelMessage(payload) {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

function createGoogleSearchDom(initialValue = '') {
  document.body.innerHTML = `
    <form role="search" action="/search">
      <input name="q" class="gLFyf" />
      <button type="submit" aria-label="Google Search">Search</button>
    </form>
    <textarea class="ITIRGe" aria-label="Ask anything"></textarea>
    <button data-xid="input-plate-send-button">Send</button>
  `;

  const searchInput = document.querySelector('input[name="q"]');
  const searchButton = document.querySelector('button[aria-label="Google Search"]');
  const aiInput = document.querySelector('textarea.ITIRGe');
  const aiSendButton = document.querySelector('button[data-xid="input-plate-send-button"]');

  searchInput.value = initialValue;
  aiInput.value = '';

  [searchInput, searchButton, aiInput, aiSendButton].forEach(markVisible);

  return {
    searchInput,
    searchButton,
    aiInput,
    aiSendButton,
    form: document.querySelector('form'),
  };
}

function createGoogleAiImageUploadDom() {
  document.body.innerHTML = `
    <div class="google-ai-shell">
      <textarea class="ITIRGe" aria-label="Ask anything"></textarea>
      <button type="button" aria-label="更多输入项">+</button>
      <button type="button" data-xid="input-plate-send-button">Send</button>
    </div>
  `;

  const aiInput = document.querySelector('textarea.ITIRGe');
  const addButton = document.querySelector('button[aria-label="更多输入项"]');
  const sendButton = document.querySelector('button[data-xid="input-plate-send-button"]');

  [aiInput, addButton, sendButton].forEach(markVisible);

  return { aiInput, addButton, sendButton };
}

/**
 * Trimmed from the live AI Mode page (2026-09): the file inputs only exist
 * inside the "+" menu, next to model and "generate image" options, and the page
 * also shows an unrelated "添加笔记本" button.
 */
function createGoogleAiModeMenuDom() {
  document.body.innerHTML = `
    <button type="button" class="WET9nf" id="add-notebook">添加笔记本</button>
    <div class="esoFne" role="presentation">
      <textarea class="ITIRGe" aria-label="尽情提问" placeholder="尽情提问" maxlength="8192"></textarea>
      <button class="uMMzHc hhGtFb" aria-label="添加文件、工具并选择模型" aria-haspopup="menu" aria-expanded="false">+</button>
      <button type="button" data-xid="input-plate-send-button">Send</button>
    </div>
  `;

  const aiInput = document.querySelector('textarea.ITIRGe');
  const menuTrigger = document.querySelector('button[aria-haspopup="menu"]');
  const notebookButton = document.getElementById('add-notebook');
  [aiInput, menuTrigger, notebookButton].forEach(markVisible);
  const clicked = [];
  notebookButton.addEventListener('click', () => clicked.push('notebook'));

  function closeMenu() {
    document.querySelector('[data-is-aim-input-menu]')?.remove();
    menuTrigger.setAttribute('aria-expanded', 'false');
  }

  menuTrigger.addEventListener('click', () => {
    if (document.querySelector('[data-is-aim-input-menu]')) {
      closeMenu();
      return;
    }
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-is-aim-input-menu', 'true');
    menu.innerHTML = `
      <button aria-label="添加图片" role="menuitem">添加图片
        <input type="file" hidden="true" accept="image/avif,image/bmp,image/heic,image/heif,image/jpeg,image/png,image/tiff,image/webp" multiple="true">
      </button>
      <button aria-label="添加文件" role="menuitem">添加文件<input type="file" hidden="true" accept="" multiple="true"></button>
      <button aria-label="生成图片" role="menuitemradio" aria-checked="false">生成图片</button>
    `;
    menu.querySelectorAll('button').forEach((item) => {
      markVisible(item);
      item.addEventListener('click', () => clicked.push(item.getAttribute('aria-label')));
    });
    document.body.append(menu);
    menuTrigger.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  const uploads = [];
  document.addEventListener('change', (event) => {
    if (event.target.type === 'file') {
      uploads.push({ accept: event.target.accept, names: [...event.target.files].map((file) => file.name) });
    }
  });

  return { menuTrigger, clicked, uploads };
}

describe('google content script integration', () => {
  beforeAll(() => {
    if (typeof DataTransfer === 'undefined') {
      globalThis.DataTransfer = class DataTransfer {
        constructor() {
          this.files = [];
          this.items = {
            add: (file) => {
              this.files.push(file);
            }
          };
        }
      };
    }

    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://www.google.com/');
    const { searchInput } = createGoogleSearchDom('');
    expect(searchInput).toBeTruthy();
    dispatchMultiPanelMessage({
      type: 'CLEAR_INPUT',
      providerMode: 'search',
      context: 'multi-panel',
    });
  });

  it('targets the AI composer in AI mode even when the search box exists', () => {
    const { searchInput, aiInput } = createGoogleSearchDom('existing search');

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello ai',
      autoSubmit: false,
      providerMode: 'ai',
      context: 'multi-panel',
    });

    expect(aiInput.value).toBe('hello ai');
    expect(searchInput.value).toBe('existing search');
  });

  it('replaces the old Google search query on the first fill and appends on later fills', () => {
    const { searchInput } = createGoogleSearchDom('old query');

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'first fill',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });
    expect(searchInput.value).toBe('first fill');

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'second fill',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });
    expect(searchInput.value).toBe('first fillsecond fill');
  });

  it('resets the search fill session after sending', () => {
    const { searchInput } = createGoogleSearchDom('old query');
    const assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'first fill',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      providerMode: 'search',
      context: 'multi-panel',
    });

    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy.mock.calls[0][0]).toContain('/search?q=first+fill');
    expect(searchInput.value).toBe('first fill');

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'next search',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });

    expect(searchInput.value).toBe('next search');
  });

  it('clears the Google search input and resets the session on CLEAR_INPUT', () => {
    const { searchInput } = createGoogleSearchDom('old query');

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'first fill',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });
    expect(searchInput.value).toBe('first fill');

    dispatchMultiPanelMessage({
      type: 'CLEAR_INPUT',
      providerMode: 'search',
      context: 'multi-panel',
    });
    expect(searchInput.value).toBe('');

    searchInput.value = 'leftover query';
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'fresh fill',
      autoSubmit: false,
      providerMode: 'search',
      context: 'multi-panel',
    });

    expect(searchInput.value).toBe('fresh fill');
  });

  it('opens the Google AI image picker before assigning uploaded files', async () => {
    window.happyDOM.setURL('https://www.google.com/search?udm=50');
    const { addButton } = createGoogleAiImageUploadDom();
    let changeEventCount = 0;

    addButton.addEventListener('click', () => {
      if (document.querySelector('input[type="file"]')) {
        return;
      }

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = 'image/*';
      fileInput.hidden = true;
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        changeEventCount += 1;
      });
      document.body.appendChild(fileInput);
    });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: '',
      images: [{
        name: 'sample.png',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII='
      }],
      autoSubmit: false,
      providerMode: 'ai',
      context: 'multi-panel',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).toBeTruthy();
    expect(changeEventCount).toBe(1);
    expect(fileInput.files).toHaveLength(1);
    expect(fileInput.files[0].name).toBe('sample.png');
  });

  it('uploads through the image input inside the current AI Mode "+" menu', async () => {
    window.happyDOM.setURL('https://www.google.com/search?udm=50');
    const { menuTrigger, clicked, uploads } = createGoogleAiModeMenuDom();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: '',
      images: [{
        name: 'sample.png',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII='
      }],
      autoSubmit: false,
      providerMode: 'ai',
      context: 'multi-panel',
    });

    await new Promise(resolve => setTimeout(resolve, 400));

    expect(uploads).toEqual([{
      accept: 'image/avif,image/bmp,image/heic,image/heif,image/jpeg,image/png,image/tiff,image/webp',
      names: ['sample.png'],
    }]);
    expect(clicked).toEqual([]);
    expect(menuTrigger.getAttribute('aria-expanded')).toBe('false');
  });
});
