import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

function createChatGLMDom({ withFileInput = true } = {}) {
  document.body.innerHTML = `
    <aside class="aside-subjects">
      <div id="chatglm-new-chat" class="new-session"></div>
    </aside>
    <div class="search-box-container">
      <div class="upload-container"><input class="img-input" type="file" accept=".png,.jpg" /></div>
      ${withFileInput ? '<div class="upload-popover"><input class="el-upload__input" type="file" multiple /></div>' : ''}
      <div id="search-input-box">
        <textarea id="chatglm-editor" class="scroll-display-none"></textarea>
        <div class="enter is-main-chat">
          <div id="chatglm-send" class="enter-icon-container"></div>
        </div>
      </div>
    </div>
    <div class="file-list-box-content-list"></div>
  `;

  const editor = document.getElementById('chatglm-editor');
  const sendButton = document.getElementById('chatglm-send');
  const newChatButton = document.getElementById('chatglm-new-chat');
  const fileInput = document.querySelector('input.el-upload__input');
  const legacyFileInput = document.querySelector('input.img-input');
  const previewList = document.querySelector('.file-list-box-content-list');
  [editor, sendButton, newChatButton].forEach(markVisible);

  fileInput?.addEventListener('change', () => {
    const preview = document.createElement('div');
    preview.className = 'file-list-box-content-list-item';
    previewList.append(preview);
  });

  return { editor, sendButton, newChatButton, fileInput, legacyFileInput, previewList };
}

function dispatchMultiPanelMessage(payload) {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

function dispatchImageInjection(autoSubmit = false) {
  dispatchMultiPanelMessage({
    type: 'INJECT_TEXT_WITH_IMAGES',
    text: '',
    images: [{
      name: 'sample.png',
      type: 'image/png',
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
    }],
    autoSubmit,
    context: 'multi-panel',
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ChatGLM content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chatglm.cn/');
  });

  it('injects text and dispatches the verified mousedown send event', () => {
    const { editor, sendButton } = createChatGLMDom();
    const mouseDownSpy = vi.fn();
    const clickSpy = vi.fn();
    sendButton.addEventListener('mousedown', mouseDownSpy);
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello chatglm',
      autoSubmit: false,
      context: 'multi-panel',
    });
    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });

    expect(editor.value).toContain('hello chatglm');
    expect(mouseDownSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it('uses the verified new chat control', () => {
    const { newChatButton } = createChatGLMDom();
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uploads an image and waits for the ChatGLM preview', async () => {
    const { fileInput, legacyFileInput, previewList } = createChatGLMDom();

    dispatchImageInjection();
    await wait(1000);

    expect(fileInput.files).toHaveLength(1);
    expect(fileInput.files[0].name).toBe('sample.png');
    expect(legacyFileInput.files).toHaveLength(0);
    expect(previewList.children).toHaveLength(1);
  });

  it('does not auto-submit when image injection fails', async () => {
    const { sendButton } = createChatGLMDom({ withFileInput: false });
    const mouseDownSpy = vi.fn();
    sendButton.addEventListener('mousedown', mouseDownSpy);

    dispatchImageInjection(true);
    await wait(1000);

    expect(mouseDownSpy).not.toHaveBeenCalled();
  });
});
