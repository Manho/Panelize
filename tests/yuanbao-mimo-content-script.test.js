import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);
const buttonFinderSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/button-finder-utils.js'),
  'utf8'
);

const SAMPLE_IMAGE = {
  id: 'provider-sample-image',
  name: 'sample.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
};

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body,
  });
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: 10,
      left: 10,
      right: 100,
      bottom: 40,
      width: 90,
      height: 30,
    }),
  });
}

function dispatchMultiPanelMessage(data) {
  window.dispatchEvent(new MessageEvent('message', {
    data: {
      context: 'multi-panel',
      ...data,
    },
  }));
}

function createYuanbaoDom({ previewDelayMs = 0 } = {}) {
  document.body.innerHTML = `
    <div id="yuanbao-composer">
      <div class="chat-command-editor-specail ql-container">
        <div class="ql-editor" contenteditable="true" data-placeholder="Send Message"><p>draft</p></div>
      </div>
      <button data-new-input-control="add-tools-trigger" aria-label="Add"></button>
      <div id="yuanbao-previews"></div>
      <div id="yuanbao-send-btn" aria-label="Send"
           class="SendButton_sendButton__test SendButton_disabled__test SendButton_sendNot__test"></div>
    </div>
    <div role="button" aria-label="New Chat"></div>
  `;

  const editor = document.querySelector('.ql-editor');
  const addButton = document.querySelector('[data-new-input-control="add-tools-trigger"]');
  const sendButton = document.getElementById('yuanbao-send-btn');
  const newChatButton = document.querySelector('[aria-label="New Chat"]');
  [editor, addButton, sendButton, newChatButton].forEach(markVisible);

  editor.addEventListener('input', () => {
    sendButton.className = 'SendButton_sendButton__test';
  });

  const uploadedNames = [];
  addButton.addEventListener('click', () => {
    if (document.getElementById('yuanbao-upload-image')) return;

    const uploadAction = document.createElement('button');
    uploadAction.id = 'yuanbao-upload-image';
    uploadAction.setAttribute('role', 'menuitem');
    uploadAction.textContent = 'Upload Image';
    markVisible(uploadAction);
    document.body.append(uploadAction);

    uploadAction.addEventListener('click', () => {
      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.multiple = true;
      fileInput.accept = 'image/*';
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        uploadedNames.push(file.name);
        setTimeout(() => {
          const item = document.createElement('div');
          item.className = 'FileList_inputFileListItem__test';
          const image = document.createElement('img');
          image.alt = file.name;
          image.src = `https://cdn.example/${file.name}`;
          item.append(image);
          document.getElementById('yuanbao-previews').append(item);
        }, previewDelayMs);
      });
      document.body.append(fileInput);
    });
  });

  return { editor, newChatButton, sendButton, uploadedNames };
}

function createMimoDom({ previewDelayMs = 0 } = {}) {
  document.body.innerHTML = `
    <div class="relative rounded-2xl border" id="mimo-composer">
      <textarea placeholder="Ask me anything">draft</textarea>
      <input type="file" multiple
             accept="image/jpeg,image/png,image/webp,image/bmp,text/plain,application/pdf">
      <div id="mimo-previews"></div>
      <button data-track-id="home_send_btn" disabled><svg viewBox="0 0 19 16"></svg></button>
    </div>
    <button data-track-id="navbar_new_chat_btn"></button>
  `;

  const editor = document.querySelector('textarea');
  const fileInput = document.querySelector('input[type="file"]');
  const sendButton = document.querySelector('[data-track-id="home_send_btn"]');
  const newChatButton = document.querySelector('[data-track-id="navbar_new_chat_btn"]');
  [editor, sendButton, newChatButton].forEach(markVisible);

  editor.addEventListener('input', () => {
    sendButton.disabled = editor.value.trim() === '';
  });

  const uploadedNames = [];
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    uploadedNames.push(file.name);
    setTimeout(() => {
      const preview = document.createElement('button');
      preview.setAttribute('aria-label', file.name);
      document.getElementById('mimo-previews').append(preview);
    }, previewDelayMs);
  });

  return { editor, newChatButton, sendButton, uploadedNames };
}

function getActionResultCalls() {
  return window.parent.postMessage.mock.calls
    .map(([payload]) => payload)
    .filter(payload => payload?.type === 'PANELIZE_ACTION_RESULT');
}

describe('Yuanbao and MiMo content script integration', () => {
  beforeAll(() => {
    window.eval(buttonFinderSource);
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it.each([
    ['Yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa', createYuanbaoDom],
    ['MiMo', 'https://aistudio.xiaomimimo.com/#/c', createMimoDom],
  ])('appends text and uses the verified send control for %s', (_name, url, createDom) => {
    window.happyDOM.setURL(url);
    const { editor, sendButton } = createDom();
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: ' + panelize',
      autoSubmit: false,
    });
    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND' });

    const value = editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent;
    expect(value).toContain('draft');
    expect(value).toContain('panelize');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa', createYuanbaoDom],
    ['MiMo', 'https://aistudio.xiaomimimo.com/#/c', createMimoDom],
  ])('uses the provider-specific new chat control for %s', (_name, url, createDom) => {
    window.happyDOM.setURL(url);
    const { newChatButton } = createDom();
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'NEW_CHAT' });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Enter Temporary Chat', 'Exit Temporary Chat'],
    ['进入临时对话', '退出临时对话'],
  ])('acknowledges Yuanbao temporary chat after %s changes to %s', async (enterLabel, exitLabel) => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    document.body.innerHTML = `<div role="button" aria-label="${enterLabel}"></div>`;
    const control = document.querySelector('[role="button"]');
    markVisible(control);
    control.addEventListener('click', () => {
      control.setAttribute('aria-label', exitLabel);
    });

    dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT' });
    await vi.advanceTimersByTimeAsync(500);

    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PANELIZE_TEMP_CHAT_ENABLED',
        provider: 'yuanbao',
      }),
      '*'
    );
  });

  it('does not turn off an already active Chinese Yuanbao temporary chat without a URL flag', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    document.body.innerHTML = '<div role="button" aria-label="退出临时对话"></div>';
    const control = document.querySelector('[role="button"]');
    markVisible(control);
    const clickSpy = vi.fn();
    control.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT' });
    await vi.advanceTimersByTimeAsync(200);

    expect(clickSpy).not.toHaveBeenCalled();
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PANELIZE_TEMP_CHAT_ENABLED', provider: 'yuanbao' }),
      '*'
    );
  });

  it('clicks Yuanbao new chat with a Chinese label', () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    const { newChatButton } = createYuanbaoDom();
    newChatButton.setAttribute('aria-label', '新建对话');
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);
    dispatchMultiPanelMessage({ type: 'NEW_CHAT' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('targets MiMo composer when another textarea precedes it and the tooltip is open', () => {
    window.happyDOM.setURL('https://aistudio.xiaomimimo.com/#/c');
    const { editor, sendButton } = createMimoDom();
    editor.placeholder = '随便问问';
    document.body.insertAdjacentHTML('afterbegin', '<textarea id="unrelated">leave me alone</textarea>');
    sendButton.setAttribute('data-state', 'open');
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'INJECT_TEXT', text: ' + composer', autoSubmit: false });
    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND' });

    expect(editor.value).toContain('composer');
    expect(document.getElementById('unrelated').value).toBe('leave me alone');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it.each(['0 0 24 24', '0 0 20 20'])(
    'does not click MiMo stop or unknown icon %s on trigger send or auto-submit',
    async (viewBox) => {
      window.happyDOM.setURL('https://aistudio.xiaomimimo.com/#/c');
      const { sendButton } = createMimoDom();
      sendButton.querySelector('svg').setAttribute('viewBox', viewBox);
      sendButton.disabled = false;
      const clickSpy = vi.fn();
      sendButton.addEventListener('click', clickSpy);

      dispatchMultiPanelMessage({ type: 'TRIGGER_SEND' });
      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        text: ' + queued',
        autoSubmit: true,
      });
      await vi.advanceTimersByTimeAsync(900);

      expect(clickSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['Yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa', createYuanbaoDom],
    ['MiMo', 'https://aistudio.xiaomimimo.com/#/c', createMimoDom],
  ])('uploads and verifies an image preview for %s', async (_name, url, createDom) => {
    window.happyDOM.setURL(url);
    const { uploadedNames } = createDom();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: '',
      autoSubmit: false,
      requestId: `fill-${_name}`,
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(uploadedNames).toEqual(['sample.png']);
    expect(getActionResultCalls()).toContainEqual(expect.objectContaining({
      provider: _name === 'Yuanbao' ? 'yuanbao' : 'mimo',
      status: 'succeeded',
      succeededImageIds: ['provider-sample-image'],
    }));
  });

  it('reconciles a delayed MiMo preview without uploading the image twice', async () => {
    window.happyDOM.setURL('https://aistudio.xiaomimimo.com/#/c');
    const { uploadedNames } = createMimoDom({ previewDelayMs: 6500 });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: 'keep this draft',
      autoSubmit: false,
      requestId: 'mimo-delayed-first',
    });
    await vi.advanceTimersByTimeAsync(7500);

    expect(uploadedNames).toEqual(['sample.png']);
    expect(getActionResultCalls()).toContainEqual(expect.objectContaining({
      requestId: 'mimo-delayed-first',
      status: 'failed',
      reason: 'preview-timeout',
    }));

    window.parent.postMessage.mockClear();
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: 'keep this draft',
      autoSubmit: false,
      requestId: 'mimo-delayed-retry',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(uploadedNames).toEqual(['sample.png']);
    expect(document.querySelector('textarea').value).toBe('draftkeep this draft');
    expect(getActionResultCalls()).toContainEqual(expect.objectContaining({
      requestId: 'mimo-delayed-retry',
      status: 'succeeded',
      succeededImageIds: ['provider-sample-image'],
    }));
  });
});
