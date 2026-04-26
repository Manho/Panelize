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

function createZaiComposerDom() {
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

describe('Z.ai content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chat.z.ai/');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    createZaiComposerDom();
  });

  it('injects text into the Z.ai textarea composer', () => {
    const { editor } = createZaiComposerDom();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello zai',
      autoSubmit: false,
      context: 'multi-panel',
    });

    expect(editor.value).toContain('hello zai');
  });

  it('uses the send button for Z.ai when triggering send', () => {
    const { sendButton } = createZaiComposerDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the visible new chat control for Z.ai', () => {
    const { newChatButton } = createZaiComposerDom();
    const clickSpy = vi.fn((event) => event.preventDefault());
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'NEW_CHAT',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
