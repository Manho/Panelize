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
});
