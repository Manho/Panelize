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

function dispatchMultiPanelMessage(payload) {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createQwenChinaDom() {
  document.body.innerHTML = `
    <aside id="new-nav-tab-wrapper">
      <button id="qwen-cn-new-chat">
        <span data-role="icon" data-icon-type="qwpcicon-newDialogue"></span>
      </button>
    </aside>
    <div>
      <div data-chat-input-layout="true">
        <div data-chat-input-body="true">
          <div
            id="qwen-cn-editor"
            role="textbox"
            aria-multiline="true"
            data-slate-editor="true"
            data-slate-node="value"
            contenteditable="true"
          ></div>
        </div>
        <button id="qwen-cn-upload" aria-label="添加附件"></button>
        <button id="qwen-cn-send" aria-label="发送消息"></button>
      </div>
    </div>
  `;

  const elements = {
    editor: document.getElementById('qwen-cn-editor'),
    sendButton: document.getElementById('qwen-cn-send'),
    newChatButton: document.getElementById('qwen-cn-new-chat'),
  };
  elements.sendButton.disabled = true;
  elements.editor.addEventListener('beforeinput', (event) => {
    event.preventDefault();
    elements.editor.textContent += event.data;
    elements.sendButton.disabled = elements.editor.textContent.trim() === '';
  });
  const composer = document.querySelector('[data-chat-input-layout="true"]');
  composer.addEventListener('dragenter', () => {
    if (document.getElementById('qwen-cn-file')) return;

    const fileInput = document.createElement('input');
    fileInput.id = 'qwen-cn-file';
    fileInput.type = 'file';
    fileInput.accept = 'image/jpeg,image/jpg,image/png,image/bmp,image/webp';
    fileInput.style.display = 'none';
    fileInput.addEventListener('change', () => {
      const preview = document.createElement('img');
      preview.alt = 'avatar';
      composer.append(preview);
    });
    composer.append(fileInput);
  });
  Object.values(elements).forEach(markVisible);
  return { ...elements, composer };
}

function createQwenGlobalDom() {
  document.body.innerHTML = `
    <button id="qwen-global-new-chat" class="new-chat"></button>
    <div id="dropzone-container">
      <div class="message-input-container">
        <textarea id="qwen-global-editor" class="message-input-textarea"></textarea>
        <input id="filesUpload" type="file" style="display: none" />
        <div class="chat-prompt-send-button">
          <button id="qwen-global-send" class="send-button"></button>
        </div>
      </div>
    </div>
  `;

  const elements = {
    editor: document.getElementById('qwen-global-editor'),
    sendButton: document.getElementById('qwen-global-send'),
    newChatButton: document.getElementById('qwen-global-new-chat'),
    fileInput: document.getElementById('filesUpload'),
    dropzone: document.getElementById('dropzone-container'),
  };
  elements.editor.addEventListener('paste', (event) => {
    event.preventDefault();
    const preview = document.createElement('img');
    preview.alt = 'sample.png';
    preview.className = 'vision-item-image';
    elements.dropzone.append(preview);
  });
  Object.values(elements).forEach(markVisible);
  return elements;
}

describe('Qwen content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['China', 'https://www.qianwen.com/', createQwenChinaDom],
    ['Global', 'https://chat.qwen.ai/', createQwenGlobalDom],
  ])('injects text and sends with Qwen %s', (_name, url, createDom) => {
    window.happyDOM.setURL(url);
    const { editor, sendButton } = createDom();
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello qwen',
      autoSubmit: false,
      context: 'multi-panel',
    });
    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    const editorText = editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent;
    expect(editorText).toContain('hello qwen');
    expect(sendButton.disabled).toBe(false);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['China', 'https://www.qianwen.com/', createQwenChinaDom],
    ['Global', 'https://chat.qwen.ai/', createQwenGlobalDom],
  ])('uses the verified new chat control for Qwen %s', (_name, url, createDom) => {
    window.happyDOM.setURL(url);
    const { newChatButton } = createDom();
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  function dispatchImageInjection() {
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: '',
      images: [{
        name: 'sample.png',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
      }],
      autoSubmit: false,
      context: 'multi-panel',
    });
  }

  it('mounts Qwen China image input through drag interaction and waits for its preview', async () => {
    window.happyDOM.setURL('https://www.qianwen.com/');
    const { composer } = createQwenChinaDom();

    expect(document.getElementById('qwen-cn-file')).toBeNull();
    dispatchImageInjection();

    await wait(1000);

    const fileInput = document.getElementById('qwen-cn-file');
    expect(fileInput).not.toBeNull();
    expect(fileInput.files).toHaveLength(1);
    expect(fileInput.files[0].name).toBe('sample.png');
    expect(composer.querySelector('img[alt="avatar"]')).not.toBeNull();
  });

  it('uploads an image to Qwen Global through its verified composer paste path', async () => {
    window.happyDOM.setURL('https://chat.qwen.ai/');
    const { dropzone, editor, fileInput } = createQwenGlobalDom();
    const changeSpy = vi.fn();
    const pasteSpy = vi.fn();
    fileInput.addEventListener('change', changeSpy);
    editor.addEventListener('paste', pasteSpy);

    dispatchImageInjection();

    await wait(1000);

    expect(pasteSpy).toHaveBeenCalledTimes(1);
    expect(changeSpy).not.toHaveBeenCalled();
    expect(dropzone.querySelector('img.vision-item-image[alt="sample.png"]')).not.toBeNull();
  });
});
