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

const sampleImage = {
  name: 'sample.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2Z2ioAAAAASUVORK5CYII=',
};

function createGeminiDom({ sendLabel = '发送', sendDisabled = false, includeSend = true } = {}) {
  document.body.innerHTML = `
    <div class="input-area-container">
      <div class="ql-editor" contenteditable="true" role="textbox"></div>
      <button id="gemini-upload" type="button" aria-label="上传和工具">
        <mat-icon fonticon="plus"></mat-icon>
      </button>
      ${includeSend ? `
        <button id="gemini-send" type="button" aria-label="${sendLabel}">
          <mat-icon fonticon="arrow_upward"></mat-icon>
        </button>
      ` : ''}
    </div>
  `;

  const editor = document.querySelector('.ql-editor');
  const uploadButton = document.getElementById('gemini-upload');
  const sendButton = document.getElementById('gemini-send');

  [editor, uploadButton, sendButton].filter(Boolean).forEach(markVisible);
  if (sendButton) {
    sendButton.disabled = sendDisabled;
  }

  return { editor, uploadButton, sendButton };
}

describe('Gemini content script integration', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    window.happyDOM.setURL('https://gemini.google.com/app');
  });

  it.each([
    ['Chinese aria label', '发送'],
    ['English aria label', 'Send message'],
    ['locale-independent icon fallback', 'Envoyer'],
  ])('clicks the Gemini send button using the %s', (_name, sendLabel) => {
    const { uploadButton, sendButton } = createGeminiDom({ sendLabel });
    const uploadClickSpy = vi.fn();
    const sendClickSpy = vi.fn();
    uploadButton.addEventListener('click', uploadClickSpy);
    sendButton.addEventListener('click', sendClickSpy);

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });

    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(uploadClickSpy).not.toHaveBeenCalled();
  });

  it('uses the verified Gemini send button after text auto-submit', async () => {
    vi.useFakeTimers();
    const { editor, uploadButton, sendButton } = createGeminiDom();
    const uploadClickSpy = vi.fn();
    const sendClickSpy = vi.fn();
    uploadButton.addEventListener('click', uploadClickSpy);
    sendButton.addEventListener('click', sendClickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT',
      text: 'hello gemini',
      autoSubmit: true,
      context: 'multi-panel',
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(editor.textContent).toContain('hello gemini');
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(uploadClickSpy).not.toHaveBeenCalled();
  });

  it('keeps Gemini image injection on the editor paste and drop path', async () => {
    vi.useFakeTimers();
    const { editor, uploadButton, sendButton } = createGeminiDom();
    const pasteSpy = vi.fn();
    const dropSpy = vi.fn();
    const uploadClickSpy = vi.fn();
    const sendClickSpy = vi.fn();
    editor.addEventListener('paste', pasteSpy);
    editor.addEventListener('drop', dropSpy);
    uploadButton.addEventListener('click', uploadClickSpy);
    sendButton.addEventListener('click', sendClickSpy);

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT_WITH_IMAGES',
      text: '',
      images: [sampleImage],
      autoSubmit: false,
      context: 'multi-panel',
    });
    await vi.runAllTimersAsync();

    expect(pasteSpy).toHaveBeenCalledTimes(1);
    expect(dropSpy).toHaveBeenCalledTimes(1);
    expect(uploadClickSpy).not.toHaveBeenCalled();
    expect(sendClickSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', { includeSend: false }],
    ['disabled', { sendDisabled: true }],
  ])('does not click the upload button when the send button is %s', (_name, options) => {
    const { uploadButton, sendButton } = createGeminiDom(options);
    const uploadClickSpy = vi.fn();
    const sendClickSpy = vi.fn();
    uploadButton.addEventListener('click', uploadClickSpy);
    sendButton?.addEventListener('click', sendClickSpy);

    dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', context: 'multi-panel' });

    expect(sendClickSpy).not.toHaveBeenCalled();
    expect(uploadClickSpy).not.toHaveBeenCalled();
  });

  it('intercepts same-origin /u/1/app?pageId=none target="_blank" account links inside Multi-Panel frames while leaving external links alone', () => {
    const fakeHost = { postMessage: vi.fn() };
    Object.defineProperty(window, 'parent', { configurable: true, value: fakeHost });
    Object.defineProperty(window, 'top', { configurable: true, value: fakeHost });

    const assignSpy = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    document.body.innerHTML = `
      <a id="gemini-u1-link" href="https://gemini.google.com/u/1/app?pageId=none" target="_blank">Account 1</a>
      <a id="gemini-external-link" href="https://accounts.google.com/Logout" target="_blank">Sign out</a>
    `;

    const accountLink = document.getElementById('gemini-u1-link');
    const accountClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    accountLink.dispatchEvent(accountClick);

    expect(accountClick.defaultPrevented).toBe(true);
    expect(assignSpy).toHaveBeenCalledWith('https://gemini.google.com/u/1/app?pageId=none');

    assignSpy.mockClear();
    const externalLink = document.getElementById('gemini-external-link');
    const externalClick = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    externalLink.dispatchEvent(externalClick);

    expect(externalClick.defaultPrevented).toBe(false);
    expect(assignSpy).not.toHaveBeenCalled();
  });

  it('preserves the active /u/<n> account prefix on Gemini NEW_CHAT URL fallback', () => {
    window.happyDOM.setURL('https://gemini.google.com/u/1/app/conv-abc123');
    createGeminiDom();

    dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });

    expect(window.location.href).toBe('https://gemini.google.com/u/1/app');
  });
});
