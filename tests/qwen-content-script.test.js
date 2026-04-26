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

function createTextareaComposerDom() {
  document.body.innerHTML = `
    <main>
      <a id="new-chat" href="/">New chat</a>
      <form>
        <textarea id="composer" placeholder="Ask anything"></textarea>
        <input id="file-input" type="file" accept="image/*" />
        <button id="send-button" type="submit" aria-label="Send">Send</button>
      </form>
    </main>
  `;

  const editor = document.getElementById('composer');
  const fileInput = document.getElementById('file-input');
  const sendButton = document.getElementById('send-button');
  const newChatButton = document.getElementById('new-chat');

  [editor, fileInput, sendButton, newChatButton].forEach(markVisible);

  return {
    editor,
    fileInput,
    sendButton,
    newChatButton,
  };
}

function createQwenComposerDom() {
  document.body.innerHTML = `
    <main>
      <a id="new-chat" href="/">New chat</a>
      <div class="message-input-container-area">
        <textarea
          id="composer"
          class="message-input-textarea"
          placeholder="How can I help you today?"
        ></textarea>
        <div class="message-input-right-button">
          <div class="message-input-right-button-send">
            <div class="chat-prompt-send-button">
              <button id="send-button" class="send-button" type="button"></button>
            </div>
          </div>
        </div>
      </div>
    </main>
  `;

  const editor = document.getElementById('composer');
  const sendButton = document.getElementById('send-button');
  const newChatButton = document.getElementById('new-chat');

  [editor, sendButton, newChatButton].forEach(markVisible);

  return {
    editor,
    sendButton,
    newChatButton,
  };
}

describe('Qwen content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chat.qwen.ai/');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    createTextareaComposerDom();
  });

  it('injects text into the Qwen textarea composer', () => {
    const { editor } = createTextareaComposerDom();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello qwen',
      autoSubmit: false,
      context: 'multi-panel',
    });

    expect(editor.value).toContain('hello qwen');
  });

  it('uses the send button for Qwen when triggering send', () => {
    const { sendButton } = createTextareaComposerDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the visible new chat control for Qwen', () => {
    const { newChatButton } = createTextareaComposerDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'NEW_CHAT',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('clicks the Qwen send button when the button only exposes the send-button class', () => {
    const { sendButton } = createQwenComposerDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
