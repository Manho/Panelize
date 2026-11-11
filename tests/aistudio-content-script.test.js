import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN, dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';
import { readContentScriptSelectorTable } from './live/live-harness.js';

const buttonFinderUtilsPath = path.resolve(process.cwd(), 'content-scripts/button-finder-utils.js');
const buttonFinderUtilsCode = fs.readFileSync(buttonFinderUtilsPath, 'utf8');
const focusTogglePath = path.resolve(process.cwd(), 'content-scripts/focus-toggle.js');
const focusToggleCode = fs.readFileSync(focusTogglePath, 'utf8');
const contentScriptPath = path.resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js');
const contentScriptCode = fs.readFileSync(contentScriptPath, 'utf8');

const SAMPLE_IMAGE = {
  id: 'img-aistudio-1',
  name: 'diagram.png',
  type: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII='
};

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeVisible(element, rect = { width: 320, height: 48, top: 10, left: 10, right: 330, bottom: 58 }) {
  Object.defineProperty(element, 'offsetWidth', {
    configurable: true,
    get: () => rect.width
  });
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    get: () => rect.height
  });
  Object.defineProperty(element, 'offsetParent', {
    configurable: true,
    get: () => document.body
  });
  element.getBoundingClientRect = () => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    toJSON() {
      return this;
    }
  });
  element.getClientRects = () => [rect];
  return element;
}

function createAiStudioComposerDom({
  mode = 'ctrl-enter-submits',
  buttonState = 'run',
  includeTempToggle = true,
  includeClearButton = true,
  incognitoActive = false
} = {}) {
  document.body.innerHTML = `
    <div class="toolbar">
      ${includeTempToggle ? '<button data-test-incognito-toggle aria-label="Toggle temporary chat" mattooltip="Toggle temporary chat"></button>' : ''}
      ${includeClearButton ? '<button data-test-clear="outside" aria-label="New chat" mattooltip="New chat"></button>' : ''}
    </div>
    ${incognitoActive ? '<ms-incognito-mode-indicator><div class="incognito-banner">You\'re in a temporary chat</div></ms-incognito-mode-indicator>' : ''}
    <ms-prompt-box>
      <div class="prompt-box-container" msfilecopypaste>
        <div class="text-wrapper">
          <ms-autosize-textarea>
            <textarea
              class="textarea"
              formcontrolname="promptText"
              aria-label="Enter a prompt"
              placeholder="Start typing a prompt"
              rows="1"
            ></textarea>
          </ms-autosize-textarea>
        </div>
        <ms-add-media-button>
          <button aria-label="Insert assets such as images, videos, files, or audio" mattooltip="Insert assets such as images, videos, files, or audio"></button>
        </ms-add-media-button>
        <ms-run-button>
          <button
            ms-button
            type="submit"
            class="ms-button-primary ${mode === 'ctrl-enter-submits' ? 'ctrl-enter-submits' : ''}"
            aria-disabled="false"
            mattooltip="Send prompt (⌘ + Enter)"
            aria-label="Run"
          >
            <span class="run-button-label">Run</span>
            <span class="material-symbols-outlined">arrow_upward</span>
          </button>
        </ms-run-button>
      </div>
    </ms-prompt-box>
  `;

  const textarea = document.querySelector('ms-prompt-box textarea[formcontrolname="promptText"]');
  const runButton = document.querySelector('ms-run-button button');
  const tempToggle = document.querySelector('button[data-test-incognito-toggle]');
  const clearButton = document.querySelector('button[data-test-clear="outside"]');
  const addMediaButton = document.querySelector('ms-add-media-button button');
  const incognitoIndicator = document.querySelector('ms-incognito-mode-indicator');

  makeVisible(textarea);
  makeVisible(runButton, { width: 88, height: 36, top: 18, left: 300, right: 388, bottom: 54 });
  if (tempToggle) {
    makeVisible(tempToggle, { width: 36, height: 36, top: 4, left: 240, right: 276, bottom: 40 });
  }
  if (clearButton) {
    makeVisible(clearButton, { width: 36, height: 36, top: 4, left: 280, right: 316, bottom: 40 });
  }
  if (addMediaButton) {
    makeVisible(addMediaButton, { width: 36, height: 36, top: 18, left: 256, right: 292, bottom: 54 });
  }
  if (incognitoIndicator) {
    makeVisible(incognitoIndicator, { width: 240, height: 28, top: 0, left: 10, right: 250, bottom: 28 });
  }

  if (buttonState === 'stop') {
    runButton.setAttribute('mattooltip', 'Cancel generation');
    runButton.setAttribute('aria-label', 'Stop');
    runButton.innerHTML = `
      <span class="run-button-label">Stop</span>
      <span class="material-symbols-outlined spin">progress_activity</span>
    `;
  } else if (buttonState === 'add') {
    runButton.setAttribute('aria-label', 'Add');
    runButton.innerHTML = '<span class="run-button-label">Add</span>';
  } else if (buttonState === 'disabled') {
    runButton.setAttribute('aria-disabled', 'true');
    runButton.disabled = true;
  }

  return { textarea, runButton, tempToggle, clearButton, addMediaButton };
}

function getProviderStatusCalls(postMessageSpy, type) {
  return postMessageSpy.mock.calls
    .map(call => call[0])
    .filter(payload => payload?.type === type && payload?.context === 'multi-panel-provider-status');
}

describe('Google AI Studio content script integration', () => {
  beforeAll(() => {
    window.eval(buttonFinderUtilsCode);
    window.eval(contentScriptCode);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() }
    });
    document.body.innerHTML = '';
  });

  describe('hostname ordering vs google.com', () => {
    it('identifies aistudio.google.com as aistudio instead of google and injects into ms-prompt-box textarea', () => {
      const { textarea } = createAiStudioComposerDom();

      const inputSpy = vi.fn();
      const changeSpy = vi.fn();
      textarea.addEventListener('input', inputSpy);
      textarea.addEventListener('change', changeSpy);

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        text: 'Explain Flash Thinking tokens',
        autoSubmit: false
      });

      expect(textarea.value).toBe('Explain Flash Thinking tokens');
      expect(inputSpy).toHaveBeenCalledTimes(1);
      expect(changeSpy).toHaveBeenCalledTimes(1);
    });

    it('keeps www.google.com identified as google AI mode', () => {
      window.happyDOM.setURL('https://www.google.com/search?udm=50');
      document.body.innerHTML = '<textarea class="ITIRGe" aria-label="Ask anything"></textarea>';
      const aiInput = document.querySelector('textarea.ITIRGe');
      makeVisible(aiInput);

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        text: 'Google AI Mode query',
        autoSubmit: false,
        providerMode: 'ai'
      });

      expect(aiInput.value).toBe('Google AI Mode query');
    });

    it('focuses ms-prompt-box textarea in focus-toggle.js on aistudio.google.com before google.com', () => {
      const { textarea } = createAiStudioComposerDom();
      const unrelatedGoogleInput = document.createElement('textarea');
      unrelatedGoogleInput.className = 'ITIRGe';
      unrelatedGoogleInput.setAttribute('aria-label', 'Ask anything');
      document.body.appendChild(unrelatedGoogleInput);
      makeVisible(unrelatedGoogleInput);

      let messageHandler = null;
      const context = {
        window: { location: { hostname: 'aistudio.google.com' }, getSelection: () => window.getSelection() },
        document,
        chrome: {
          runtime: {
            onMessage: {
              addListener: (fn) => {
                messageHandler = fn;
              }
            }
          }
        }
      };

      vm.createContext(context);
      vm.runInContext(focusToggleCode, context);

      const focusSpy = vi.spyOn(textarea, 'focus');
      const googleFocusSpy = vi.spyOn(unrelatedGoogleInput, 'focus');
      const sendResponse = vi.fn();

      messageHandler({ action: 'takeFocus' }, {}, sendResponse);

      expect(focusSpy).toHaveBeenCalledTimes(1);
      expect(googleFocusSpy).not.toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });
  });

  describe('prompt injection, clear input, and Run vs Stop button guard', () => {
    it('clears the ms-prompt-box textarea on CLEAR_INPUT', () => {
      const { textarea } = createAiStudioComposerDom();
      textarea.value = 'Draft prompt to clear';

      dispatchMultiPanelMessage({
        type: 'CLEAR_INPUT',
        context: 'multi-panel'
      });

      expect(textarea.value).toBe('');
    });

    it('clicks ms-run-button when idle and autoSubmit is true', async () => {
      const { textarea, runButton } = createAiStudioComposerDom({ buttonState: 'run' });
      const clickSpy = vi.spyOn(runButton, 'click');

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        text: 'Hello AI Studio',
        autoSubmit: true
      });

      expect(textarea.value).toBe('Hello AI Studio');
      await wait(550);
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('never clicks ms-run-button when streaming (Stop state with .spin or Cancel generation)', async () => {
      const { runButton } = createAiStudioComposerDom({ buttonState: 'stop' });
      const clickSpy = vi.spyOn(runButton, 'click');

      expect(window.ButtonFinderUtils.isAiStudioSendControl(runButton)).toBe(false);
      expect(window.ButtonFinderUtils.findSendButton('aistudio')).toBeNull();

      dispatchMultiPanelMessage({
        type: 'TRIGGER_SEND',
        context: 'multi-panel'
      });

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        context: 'multi-panel',
        text: 'Do not interrupt active generation',
        autoSubmit: true
      });
      await wait(600);

      expect(clickSpy).not.toHaveBeenCalled();
    });

    it('never clicks ms-run-button when in Add state or disabled', () => {
      const { runButton } = createAiStudioComposerDom({ buttonState: 'add' });
      const clickSpy = vi.spyOn(runButton, 'click');

      expect(window.ButtonFinderUtils.isAiStudioSendControl(runButton)).toBe(false);

      dispatchMultiPanelMessage({
        type: 'TRIGGER_SEND',
        context: 'multi-panel'
      });
      expect(clickSpy).not.toHaveBeenCalled();

      runButton.innerHTML = '<span class="run-button-label">Run</span>';
      runButton.setAttribute('aria-label', 'Run');
      runButton.setAttribute('aria-disabled', 'true');
      expect(window.ButtonFinderUtils.isAiStudioSendControl(runButton)).toBe(false);

      dispatchMultiPanelMessage({
        type: 'TRIGGER_SEND',
        context: 'multi-panel'
      });
      expect(clickSpy).not.toHaveBeenCalled();
    });
  });

  describe('busy and idle status tracking', () => {
    it('reports PANELIZE_PROVIDER_BUSY when ms-run-button switches to Stop/spin and PANELIZE_PROVIDER_IDLE when returning to Run', async () => {
      let notifyMutation;
      vi.stubGlobal('MutationObserver', class {
        constructor(callback) {
          notifyMutation = callback;
        }
        observe() {}
        disconnect() {}
      });
      vi.useFakeTimers();

      try {
        const postMessageSpy = window.parent.postMessage;
        const { runButton } = createAiStudioComposerDom({ buttonState: 'run' });

        dispatchMultiPanelMessage({
          type: 'TRIGGER_SEND',
          context: 'multi-panel',
          requestId: 'req-aistudio-stream-1'
        });

        runButton.setAttribute('mattooltip', 'Cancel generation');
        runButton.setAttribute('aria-label', 'Stop');
        runButton.innerHTML = `
          <span class="run-button-label">Stop</span>
          <span class="material-symbols-outlined spin">progress_activity</span>
        `;
        notifyMutation();

        expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_BUSY')).toEqual([
          expect.objectContaining({
            type: 'PANELIZE_PROVIDER_BUSY',
            context: 'multi-panel-provider-status',
            provider: 'aistudio',
            requestId: 'req-aistudio-stream-1',
            phase: 'busy'
          })
        ]);

        runButton.setAttribute('mattooltip', 'Send prompt (⌘ + Enter)');
        runButton.setAttribute('aria-label', 'Run');
        runButton.innerHTML = `
          <span class="run-button-label">Run</span>
          <span class="material-symbols-outlined">arrow_upward</span>
        `;
        notifyMutation();

        await vi.advanceTimersByTimeAsync(850);

        expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_IDLE')).toEqual([
          expect.objectContaining({
            type: 'PANELIZE_PROVIDER_IDLE',
            context: 'multi-panel-provider-status',
            provider: 'aistudio',
            requestId: 'req-aistudio-stream-1',
            phase: 'idle'
          })
        ]);
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    });
  });

  describe('New Chat navigation and confirmation modal bypass', () => {
    it('navigates directly to /prompts/new_chat on NEW_CHAT in normal mode without clicking the modal-triggering clear button', () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/123456789');
      const { clearButton } = createAiStudioComposerDom();
      const clearClickSpy = vi.spyOn(clearButton, 'click');

      dispatchMultiPanelMessage({
        type: 'NEW_CHAT',
        context: 'multi-panel',
        temporaryChat: false
      });

      expect(clearClickSpy).not.toHaveBeenCalled();
      // AI Studio keeps temporary mode sticky, so normal mode must opt out explicitly.
      expect(window.location.href).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    });

    it('opts out of sticky AI Studio temporary mode on NEW_CHAT with temporaryChat false', () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
      createAiStudioComposerDom({ incognitoActive: true });

      dispatchMultiPanelMessage({
        type: 'NEW_CHAT',
        context: 'multi-panel',
        temporaryChat: false
      });

      expect(window.location.href).toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    });

    it('navigates directly to /prompts/new_chat?temporary=true when temporaryChat is true', () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
      const { clearButton } = createAiStudioComposerDom();
      const clearClickSpy = vi.spyOn(clearButton, 'click');

      dispatchMultiPanelMessage({
        type: 'NEW_CHAT',
        context: 'multi-panel',
        temporaryChat: true
      });

      expect(clearClickSpy).not.toHaveBeenCalled();
      expect(window.location.href).toBe('https://aistudio.google.com/prompts/new_chat?temporary=true');
    });

    it('preserves temporary=true on NEW_CHAT when already in temporary chat and temporaryChat is not explicitly false', () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat?temporary=true');
      const { clearButton } = createAiStudioComposerDom({ incognitoActive: true });
      const clearClickSpy = vi.spyOn(clearButton, 'click');

      dispatchMultiPanelMessage({
        type: 'NEW_CHAT',
        context: 'multi-panel'
      });

      expect(clearClickSpy).not.toHaveBeenCalled();
      expect(window.location.href).toBe('https://aistudio.google.com/prompts/new_chat?temporary=true');
    });
  });

  describe('Temporary Chat detection and activation', () => {
    it('reports PANELIZE_TEMP_CHAT_ENABLED without clicking toggle when URL already has temporary=true', async () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat?temporary=true');
      const { tempToggle } = createAiStudioComposerDom();
      const clickSpy = vi.spyOn(tempToggle, 'click');

      dispatchMultiPanelMessage({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel'
      });
      await wait(50);

      expect(clickSpy).not.toHaveBeenCalled();
      expect(getProviderStatusCalls(window.parent.postMessage, 'PANELIZE_TEMP_CHAT_ENABLED')).toEqual([
        expect.objectContaining({
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          context: 'multi-panel-provider-status',
          provider: 'aistudio'
        })
      ]);
    });

    it('reports PANELIZE_TEMP_CHAT_ENABLED without clicking toggle when visible ms-incognito-mode-indicator has text in DOM', async () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
      const { tempToggle } = createAiStudioComposerDom({ incognitoActive: true });
      const clickSpy = vi.spyOn(tempToggle, 'click');

      dispatchMultiPanelMessage({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel'
      });
      await wait(50);

      expect(clickSpy).not.toHaveBeenCalled();
      expect(getProviderStatusCalls(window.parent.postMessage, 'PANELIZE_TEMP_CHAT_ENABLED')).toEqual([
        expect.objectContaining({
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          context: 'multi-panel-provider-status',
          provider: 'aistudio'
        })
      ]);
    });

    it('ignores an empty or hidden ms-incognito-mode-indicator host element and clicks button[data-test-incognito-toggle]', async () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
      const { tempToggle } = createAiStudioComposerDom({ incognitoActive: false });
      const emptyIndicator = document.createElement('ms-incognito-mode-indicator');
      document.body.appendChild(emptyIndicator);
      const clickSpy = vi.spyOn(tempToggle, 'click');

      dispatchMultiPanelMessage({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel'
      });
      await wait(50);

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('clicks button[data-test-incognito-toggle] when temporary chat is not yet active', async () => {
      window.happyDOM.setURL('https://aistudio.google.com/prompts/new_chat');
      const { tempToggle } = createAiStudioComposerDom({ incognitoActive: false });
      const clickSpy = vi.spyOn(tempToggle, 'click');

      dispatchMultiPanelMessage({
        type: 'ENABLE_TEMP_CHAT',
        context: 'multi-panel'
      });
      await wait(50);

      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(getProviderStatusCalls(window.parent.postMessage, 'PANELIZE_TEMP_CHAT_ENABLED')).toEqual([
        expect.objectContaining({
          type: 'PANELIZE_TEMP_CHAT_ENABLED',
          context: 'multi-panel-provider-status',
          provider: 'aistudio'
        })
      ]);
    });
  });

  describe('multimodal image paste injection', () => {
    it('dispatches a ClipboardEvent paste with image file onto the prompt box and injects text', async () => {
      const { textarea } = createAiStudioComposerDom();
      const promptContainer = document.querySelector('ms-prompt-box [msfilecopypaste]');
      const pastedFiles = [];

      promptContainer.addEventListener('paste', (event) => {
        const files = [...(event.clipboardData?.files || [])];
        pastedFiles.push(...files);
      });

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT_WITH_IMAGES',
        context: 'multi-panel',
        requestId: 'req-aistudio-img-1',
        text: 'Describe this architecture diagram',
        images: [SAMPLE_IMAGE],
        autoSubmit: false
      });

      await wait(1200);

      expect(pastedFiles).toHaveLength(1);
      expect(pastedFiles[0].name).toBe('diagram.png');
      expect(pastedFiles[0].type).toBe('image/png');
      expect(textarea.value).toBe('Describe this architecture diagram');
      expect(window.parent.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'PANELIZE_ACTION_RESULT',
          context: 'multi-panel-action-result',
          provider: 'aistudio',
          requestId: 'req-aistudio-img-1',
          status: 'succeeded',
          succeededImageIds: ['img-aistudio-1']
        }),
        EXTENSION_ORIGIN
      );
    });
  });

  describe('live harness selector table compatibility', () => {
    it('keeps all live-harness selector and URL tables parseable as standalone literals', () => {
      for (const tableName of [
        'PROVIDER_SELECTORS',
        'SEND_BUTTON_SELECTORS',
        'NEW_CHAT_BUTTON_SELECTORS',
        'NEW_CHAT_URLS'
      ]) {
        const table = readContentScriptSelectorTable(tableName);
        expect(table.aistudio).toBeTruthy();
      }
      expect(readContentScriptSelectorTable('NEW_CHAT_URLS').aistudio)
        .toBe('https://aistudio.google.com/prompts/new_chat?temporary=false');
    });
  });
});
