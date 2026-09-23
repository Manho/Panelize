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
let testClock = Date.now();

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
           class="SendButton_sendButton__test SendButton_disabled__test SendButton_sendNot__test">
        <svg viewBox="0 0 48 48"></svg>
      </div>
    </div>
    <div role="button" aria-label="New Chat"></div>
  `;

  const editor = document.querySelector('.ql-editor');
  const addButton = document.querySelector('[data-new-input-control="add-tools-trigger"]');
  const sendButton = document.getElementById('yuanbao-send-btn');
  const newChatButton = document.querySelector('[aria-label="New Chat"]');
  [editor, addButton, sendButton, newChatButton].forEach(markVisible);

  editor.addEventListener('input', () => {
    if (sendButton.getAttribute('aria-label') !== 'Stop Answering') {
      sendButton.className = 'SendButton_sendButton__test';
    }
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

function getActionResultCalls() {
  return window.parent.postMessage.mock.calls
    .map(([payload]) => payload)
    .filter(payload => payload?.type === 'PANELIZE_ACTION_RESULT');
}

describe('Yuanbao content script integration', () => {
  beforeAll(() => {
    window.eval(buttonFinderSource);
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    testClock += 10000;
    vi.setSystemTime(testClock);
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

  it('does not stop Yuanbao generation on trigger send or auto-submit', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    const { editor, sendButton } = createYuanbaoDom();
    sendButton.className = 'SendButton_sendButton__test SendButton_sendStop__test';
    sendButton.setAttribute('aria-label', 'Stop Answering');
    sendButton.querySelector('svg').remove();
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND' });
    dispatchMultiPanelMessage({ type: 'INJECT_TEXT', text: ' + queued', autoSubmit: true });
    await vi.advanceTimersByTimeAsync(900);

    expect(editor.textContent).toContain('queued');
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['Yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa', createYuanbaoDom],
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
    ['進入臨時對話', '退出臨時對話'],
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

  it.each(['退出临时对话', '退出臨時對話'])(
    'does not turn off an already active Yuanbao temporary chat labeled %s without a URL flag',
    async (label) => {
      window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
      document.body.innerHTML = `<div role="button" aria-label="${label}"></div>`;
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
    }
  );

  it('does not toggle Yuanbao temporary chat twice across overlapping and late retries', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    document.body.innerHTML = '';
    dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT' });
    await vi.advanceTimersByTimeAsync(1100);

    const control = document.createElement('div');
    control.setAttribute('role', 'button');
    control.setAttribute('aria-label', '进入临时对话');
    document.body.append(control);
    markVisible(control);
    const clickSpy = vi.fn(() => {
      setTimeout(() => control.setAttribute('aria-label', '退出临时对话'), 1600);
    });
    control.addEventListener('click', clickSpy);

    await vi.advanceTimersByTimeAsync(100);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(control.getAttribute('aria-label')).toBe('进入临时对话');

    dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT' });
    await vi.advanceTimersByTimeAsync(600);

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PANELIZE_TEMP_CHAT_ENABLED', provider: 'yuanbao' }),
      '*'
    );
  });

  it.each(['新建对话', '新建對話'])('clicks Yuanbao new chat with label %s', (label) => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    const { newChatButton } = createYuanbaoDom();
    newChatButton.setAttribute('aria-label', label);
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);
    dispatchMultiPanelMessage({ type: 'NEW_CHAT' });
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa', createYuanbaoDom],
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
      provider: 'yuanbao',
      status: 'succeeded',
      succeededImageIds: ['provider-sample-image'],
    }));
  });

  it('reconciles a delayed Yuanbao preview without uploading the image twice', async () => {
    window.happyDOM.setURL('https://yuanbao.tencent.com/chat/naQivTmsDa');
    const { uploadedNames } = createYuanbaoDom({ previewDelayMs: 6500 });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: 'keep this draft',
      autoSubmit: false,
      requestId: 'yuanbao-delayed-first',
    });
    await vi.advanceTimersByTimeAsync(7500);

    expect(uploadedNames).toEqual(['sample.png']);
    expect(getActionResultCalls()).toContainEqual(expect.objectContaining({
      requestId: 'yuanbao-delayed-first',
      status: 'failed',
      reason: 'preview-timeout',
    }));

    window.parent.postMessage.mockClear();
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      images: [SAMPLE_IMAGE],
      text: 'keep this draft',
      autoSubmit: false,
      requestId: 'yuanbao-delayed-retry',
      retry: true,
    });
    await vi.advanceTimersByTimeAsync(2500);

    expect(uploadedNames).toEqual(['sample.png']);
    expect(document.querySelector('.ql-editor').textContent).toBe('draftkeep this draft');
    expect(getActionResultCalls()).toContainEqual(expect.objectContaining({
      requestId: 'yuanbao-delayed-retry',
      status: 'succeeded',
      succeededImageIds: ['provider-sample-image'],
    }));
  });
});
