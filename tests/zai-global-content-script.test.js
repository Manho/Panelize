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

function createZaiGlobalDom({ withFileInput = true } = {}) {
  document.body.innerHTML = `
    <button id="zai-new-chat" aria-label="New Chat">New Chat</button>
    <div class="relative flex flex-col">
      ${withFileInput ? '<input type="file" hidden multiple accept=".pdf,.png,.jpg" />' : ''}
      <form>
        <div class="chip-scroll"></div>
        <textarea class="input-scroll" placeholder="How can I help you today?"></textarea>
        <button class="sendMessageButton" type="button">Send</button>
      </form>
    </div>
  `;

  const editor = document.querySelector('textarea');
  const sendButton = document.querySelector('button.sendMessageButton');
  const newChatButton = document.getElementById('zai-new-chat');
  const fileInput = document.querySelector('input[type="file"]');
  const previewList = document.querySelector('.chip-scroll');
  [editor, sendButton, newChatButton].forEach(markVisible);

  fileInput?.addEventListener('change', () => {
    const preview = document.createElement('img');
    preview.dataset.cy = 'image';
    preview.alt = fileInput.files[0].name;
    previewList.append(preview);
  });

  return { editor, sendButton, newChatButton, fileInput, previewList };
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

describe('Z.ai Global content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chat.z.ai/');
  });

  it('injects text and clicks the verified send button', () => {
    const { editor, sendButton } = createZaiGlobalDom();
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello z.ai',
      autoSubmit: false,
      context: 'multi-panel',
    });
    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });

    expect(editor.value).toContain('hello z.ai');
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the verified chat link for a new chat', () => {
    const { newChatButton } = createZaiGlobalDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uploads an image and waits for the Z.ai preview', async () => {
    const { fileInput, previewList } = createZaiGlobalDom();

    dispatchImageInjection();
    await wait(1000);

    expect(fileInput.files).toHaveLength(1);
    expect(fileInput.files[0].name).toBe('sample.png');
    expect(previewList.querySelectorAll('img[data-cy="image"]')).toHaveLength(1);
  });

  it('does not auto-submit when image injection fails', async () => {
    const { sendButton } = createZaiGlobalDom({ withFileInput: false });
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchImageInjection(true);
    await wait(1000);

    expect(clickSpy).not.toHaveBeenCalled();
  });
});
