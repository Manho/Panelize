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
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createDoubaoComposerDom() {
  document.body.innerHTML = `
    <div id="flow_chat_sidebar">
      <div>Header</div>
      <div class="cursor-pointer" id="doubao-new-chat">新对话</div>
    </div>
    <div id="input-engine-container">
      <div class="semi-input-textarea-wrapper">
        <textarea
          id="doubao-editor"
          class="semi-input-textarea semi-input-textarea-autosize"
          placeholder="发消息..."
        ></textarea>
      </div>
      <input id="doubao-file-input" type="file" accept=".png,.jpg,image/*" />
      <button id="flow-end-msg-send" aria-label="">Send</button>
    </div>
  `;

  const editor = document.getElementById('doubao-editor');
  const fileInput = document.getElementById('doubao-file-input');
  const sendButton = document.getElementById('flow-end-msg-send');
  const newChatButton = document.getElementById('doubao-new-chat');

  [editor, fileInput, sendButton, newChatButton].forEach(markVisible);

  return {
    editor,
    fileInput,
    sendButton,
    newChatButton,
  };
}

function createCurrentDoubaoComposerDom() {
  document.body.innerHTML = `
    <div contenteditable="true" class="ProseMirror" id="unrelated-editor"></div>
    <div id="input-engine-container">
      <div class="guidance-input-editor-wrapper">
        <div class="w-full text-16">
          <div
            id="doubao-prosemirror-editor"
            contenteditable="true"
            translate="no"
            class="tiptap ProseMirror"
            tabindex="0"
          >
            <p data-placeholder="发消息或按住空格说话..." class="is-empty is-editor-empty"><br></p>
          </div>
        </div>
      </div>
      <button id="flow-end-msg-send">Send</button>
    </div>
  `;

  const unrelatedEditor = document.getElementById('unrelated-editor');
  const editor = document.getElementById('doubao-prosemirror-editor');
  const sendButton = document.getElementById('flow-end-msg-send');

  [unrelatedEditor, editor, sendButton].forEach(markVisible);

  return {
    unrelatedEditor,
    editor,
    sendButton,
  };
}

describe('doubao content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://www.doubao.com/chat/');
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
    createDoubaoComposerDom();
  });

  it('injects text into the Doubao textarea composer', () => {
    const { editor } = createDoubaoComposerDom();

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello doubao',
      autoSubmit: false,
      context: 'multi-panel',
    });

    expect(editor.value).toContain('hello doubao');
  });

  it('injects text into the current Doubao ProseMirror composer', () => {
    const { unrelatedEditor, editor } = createCurrentDoubaoComposerDom();
    const execCommandSpy = vi.fn((command, _showUi, value) => {
      if (command !== 'insertText') {
        return false;
      }

      document.activeElement.appendChild(document.createTextNode(value));
      return true;
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: execCommandSpy,
    });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello current doubao',
      autoSubmit: false,
      context: 'multi-panel',
    });

    expect(editor.textContent).toContain('hello current doubao');
    expect(unrelatedEditor.textContent).toBe('');
    expect(execCommandSpy).toHaveBeenCalledWith(
      'insertText',
      false,
      'hello current doubao'
    );
  });

  it('uses the send button for Doubao when triggering send', () => {
    const { sendButton } = createDoubaoComposerDom();
    const clickSpy = vi.fn();
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the Doubao textarea composer through form control updates', async () => {
    const { editor } = createDoubaoComposerDom();
    editor.value = 'hello doubao';
    const inputSpy = vi.fn();
    const changeSpy = vi.fn();
    editor.addEventListener('input', inputSpy);
    editor.addEventListener('change', changeSpy);

    dispatchMultiPanelMessage({
      type: 'CLEAR_INPUT',
      context: 'multi-panel',
    });

    await wait(10);

    expect(editor.value).toBe('');
    expect(inputSpy).toHaveBeenCalled();
    expect(changeSpy).toHaveBeenCalled();
  });

  it('uploads images through the Doubao file input and keeps text injection working', async () => {
    const { editor, fileInput } = createDoubaoComposerDom();
    const changeSpy = vi.fn();
    fileInput.addEventListener('change', () => {
      const preview = document.createElement('img');
      preview.src = 'blob:https://www.doubao.com/test-preview';
      document.getElementById('input-engine-container').appendChild(preview);
    });
    fileInput.addEventListener('change', changeSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: 'text only',
      images: [{
        name: 'sample.png',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII='
      }],
      autoSubmit: false,
      context: 'multi-panel',
    });

    await wait(2800);

    expect(editor.value).toContain('text only');
    expect(changeSpy).toHaveBeenCalled();
    expect(fileInput.files).toHaveLength(1);
    expect(fileInput.files[0].name).toBe('sample.png');
  });

  it('does not auto-submit Doubao images when upload preview never appears', async () => {
    const { fileInput, sendButton } = createDoubaoComposerDom();
    const clickSpy = vi.fn();
    const changeSpy = vi.fn();
    fileInput.addEventListener('change', changeSpy);
    sendButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: 'text with missing preview',
      images: [{
        name: 'sample.png',
        type: 'image/png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII='
      }],
      autoSubmit: true,
      context: 'multi-panel',
    });

    await wait(3500);

    expect(changeSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  }, 6000);

  it('uses the visible new chat control for Doubao', () => {
    const { newChatButton } = createDoubaoComposerDom();
    const clickSpy = vi.fn();
    newChatButton.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'NEW_CHAT',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('uses the current create conversation control for Doubao', () => {
    // Markup captured from the live site on 2026-09-23: the control sits in a
    // `contents` wrapper, so it is no longer a direct sidebar child.
    document.body.innerHTML = `
      <div id="flow_chat_sidebar" data-testid="flow_chat_sidebar">
        <div class="select-none contents">
          <div data-testid="create_conversation_button">
            <div><span>新对话</span></div>
          </div>
        </div>
      </div>
    `;
    const newChatControl = document.querySelector('[data-testid="create_conversation_button"]');
    const clickSpy = vi.fn();
    newChatControl.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'NEW_CHAT',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });
});
