import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

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

/**
 * Markup trimmed from the live site on 2026-09-23. Controls are divs from
 * DeepSeek's design system; the remaining classes are build hashes.
 * @param {object} [options]
 * @param {boolean} [options.sendDisabled] - Empty composer state.
 */
function createDeepSeekDom({ sendDisabled = false } = {}) {
  document.body.innerHTML = `
    <div class="dc1f7bee _4bcc731">
      <div class="_5a8ac7a" tabindex="0" id="deepseek-new-chat">
        <div class="ds-icon _1c42ad7"><svg></svg></div>
        <span>New chat</span>
        <div class="ds-focus-ring"></div>
      </div>
    </div>
    <div class="_77cefa5 _9996a53">
      <textarea id="deepseek-editor" placeholder="Message DeepSeek" rows="2" name="search"></textarea>
      <div class="ec4f5d61">
        <div role="button" tabindex="0" id="deepseek-attach"
          class="ds-button ds-button--iconLabelPrimary ds-button--icon ds-button--capsule ds-button--s f02f0e25">
          <div class="ds-button__icon"><svg></svg></div>
        </div>
        <div role="button" tabindex="0" id="deepseek-send"
          class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m ${sendDisabled ? 'ds-button--disabled ' : ''}_52c986b">
          <div class="ds-icon"><svg></svg></div>
        </div>
      </div>
    </div>
  `;

  const elements = {
    editor: document.getElementById('deepseek-editor'),
    newChatControl: document.getElementById('deepseek-new-chat'),
    attachButton: document.getElementById('deepseek-attach'),
    sendButton: document.getElementById('deepseek-send'),
  };
  Object.values(elements).forEach(markVisible);
  return elements;
}

describe('deepseek content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chat.deepseek.com/');
  });

  it('clicks the current DeepSeek send button instead of the attach button', () => {
    const { sendButton, attachButton } = createDeepSeekDom();
    const sendSpy = vi.fn();
    const attachSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);
    attachButton.addEventListener('click', attachSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(attachSpy).not.toHaveBeenCalled();
  });

  it('does not click the DeepSeek send button while it is disabled', () => {
    const { sendButton } = createDeepSeekDom({ sendDisabled: true });
    const sendSpy = vi.fn();
    sendButton.addEventListener('click', sendSpy);

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      context: 'multi-panel',
    });

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('uses the current sidebar new chat control for DeepSeek', () => {
    const { newChatControl } = createDeepSeekDom();
    const clickSpy = vi.fn();
    newChatControl.addEventListener('click', clickSpy);

    dispatchMultiPanelMessage({
      type: 'NEW_CHAT',
      context: 'multi-panel',
    });

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('https://chat.deepseek.com/');
  });

  it('re-populates the visible React-controlled DeepSeek composer after deleting its prompt even with an inline-edit textarea earlier in the DOM', () => {
    const { editor } = createDeepSeekDom();

    // Prepend a hidden/inline-edit textarea earlier in DOM order
    const inlineEdit = document.createElement('textarea');
    inlineEdit.setAttribute('name', 'user query');
    inlineEdit.value = 'old edited turn';
    document.body.prepend(inlineEdit);

    // Simulate React 18 controlled input value tracker on the composer textarea
    let trackedValue = '';
    const reactSeenValues = [];
    editor._valueTracker = {
      getValue: () => trackedValue,
      setValue: (next) => {
        trackedValue = String(next);
      },
    };
    editor.addEventListener('input', () => {
      if (editor._valueTracker.getValue() !== editor.value) {
        editor._valueTracker.setValue(editor.value);
        reactSeenValues.push(editor.value);
      }
    });

    // Pass 1: initial fill
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'First DeepSeek prompt',
      autoSubmit: false,
      context: 'multi-panel',
    });
    expect(editor.value).toBe('First DeepSeek prompt');
    expect(reactSeenValues).toEqual(['First DeepSeek prompt']);

    // Simulate user deleting the prompt inside DeepSeek while _valueTracker goes stale
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(editor, '');
    editor._valueTracker.setValue('First DeepSeek prompt');

    // Pass 2: re-sending the exact same prompt after deletion must still notify React and populate editor
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'First DeepSeek prompt',
      autoSubmit: false,
      context: 'multi-panel',
    });

    expect(editor.value).toBe('First DeepSeek prompt');
    expect(inlineEdit.value).toBe('old edited turn');
    expect(reactSeenValues).toEqual(['First DeepSeek prompt', 'First DeepSeek prompt']);
  });

  it('retries auto-submit when DeepSeek send button transitions from disabled to enabled asynchronously', async () => {
    vi.useFakeTimers();
    try {
      const { editor, sendButton } = createDeepSeekDom({ sendDisabled: true });
      const sendSpy = vi.fn();
      sendButton.addEventListener('click', sendSpy);

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        text: 'Delayed enablement prompt',
        autoSubmit: true,
        context: 'multi-panel',
      });

      expect(editor.value).toBe('Delayed enablement prompt');

      // Still disabled at initial 800ms check -> should wait rather than firing premature Enter
      await vi.advanceTimersByTimeAsync(850);
      expect(sendSpy).not.toHaveBeenCalled();

      // DeepSeek React composer finishes enabling the send button at ~1000ms
      sendButton.classList.remove('ds-button--disabled');
      await vi.advanceTimersByTimeAsync(450);

      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not click an enabled unrelated .ds-icon-button while the primary DeepSeek send button is disabled', async () => {
    vi.useFakeTimers();
    try {
      const { sendButton } = createDeepSeekDom({ sendDisabled: true });
      const unrelatedIconBtn = document.createElement('button');
      unrelatedIconBtn.type = 'button';
      unrelatedIconBtn.className = 'ds-icon-button';
      unrelatedIconBtn.innerHTML = '<svg><path d="M1 1 L10 10"></path></svg>';
      markVisible(unrelatedIconBtn);
      sendButton.parentElement.prepend(unrelatedIconBtn);

      const unrelatedSpy = vi.fn();
      const sendSpy = vi.fn();
      unrelatedIconBtn.addEventListener('click', unrelatedSpy);
      sendButton.addEventListener('click', sendSpy);

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        text: 'Avoid unrelated icon buttons',
        autoSubmit: true,
        context: 'multi-panel',
      });

      await vi.advanceTimersByTimeAsync(850);
      expect(unrelatedSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();

      sendButton.classList.remove('ds-button--disabled');
      await vi.advanceTimersByTimeAsync(450);

      expect(unrelatedSpy).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
