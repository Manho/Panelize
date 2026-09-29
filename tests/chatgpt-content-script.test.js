import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function dispatchMultiPanelMessage(payload) {
  window.dispatchEvent(new MessageEvent('message', { data: payload }));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForProviderStatusCall(postMessageSpy, type, expectedLength = 1, timeoutMs = 1200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = getProviderStatusCalls(postMessageSpy, type);
    if (calls.length === expectedLength) {
      return calls;
    }
    await wait(25);
  }
  return getProviderStatusCalls(postMessageSpy, type);
}

function createChatgptComposerDom({ includeSendButton = true, includeStopButton = false } = {}) {
  document.body.innerHTML = `
    <form data-type="unified-composer">
      <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
      ${includeSendButton ? '<button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>' : ''}
      ${includeStopButton ? '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>' : ''}
    </form>
  `;

  return {
    composer: document.querySelector('form[data-type="unified-composer"]'),
    prompt: document.getElementById('prompt-textarea'),
    getSendButton: () => document.querySelector('button[data-testid="send-button"]'),
    getStopButton: () => document.querySelector('button[data-testid="stop-button"]'),
  };
}

function getProviderStatusCalls(postMessageSpy, type) {
  return postMessageSpy.mock.calls
    .map(call => call[0])
    .filter(payload => payload?.type === type && payload?.context === 'multi-panel-provider-status');
}

describe('chatgpt content script provider status', () => {
  beforeAll(() => {
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chatgpt.com/c/test');
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
    createChatgptComposerDom();
  });

  it('does not report busy before the stop button appears', async () => {
    const postMessageSpy = window.parent.postMessage;

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      requestId: 'req-pending',
      context: 'multi-panel',
    });

    await wait(150);

    expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_BUSY')).toHaveLength(0);
  });

  it('reports busy when the ChatGPT stop button appears', async () => {
    const postMessageSpy = window.parent.postMessage;
    const { composer } = createChatgptComposerDom({ includeSendButton: true, includeStopButton: false });

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      requestId: 'req-busy',
      context: 'multi-panel',
    });

    await wait(100);
    composer.insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
    await wait(50);

    const busyCalls = getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_BUSY');
    expect(busyCalls).toHaveLength(1);
    expect(busyCalls[0]).toMatchObject({
      requestId: 'req-busy',
      provider: 'chatgpt',
      phase: 'busy',
    });
  });

  it('reports idle after the stop button disappears for 800ms', async () => {
    const postMessageSpy = window.parent.postMessage;
    const { getStopButton } = createChatgptComposerDom({ includeSendButton: true, includeStopButton: false });

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      requestId: 'req-idle',
      context: 'multi-panel',
    });

    await wait(100);
    document.querySelector('form[data-type="unified-composer"]').insertAdjacentHTML(
      'beforeend',
      '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>'
    );
    await wait(50);
    getStopButton()?.remove();
    await wait(850);

    const idleCalls = await waitForProviderStatusCall(postMessageSpy, 'PANELIZE_PROVIDER_IDLE');
    expect(idleCalls).toHaveLength(1);
    expect(idleCalls[0]).toMatchObject({
      requestId: 'req-idle',
      provider: 'chatgpt',
      phase: 'idle',
    });
  });

  it('does not report idle when the stop button briefly reappears', async () => {
    let notifyMutation;
    vi.stubGlobal('MutationObserver', class {
      constructor(callback) { notifyMutation = callback; }
      observe() {}
      disconnect() {}
    });
    vi.useFakeTimers();
    try {
      const postMessageSpy = window.parent.postMessage;
      const { composer, getStopButton } = createChatgptComposerDom({
        includeSendButton: true,
        includeStopButton: false,
      });

      dispatchMultiPanelMessage({
        type: 'TRIGGER_SEND',
        requestId: 'req-flicker',
        context: 'multi-panel',
      });

      composer.insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
      notifyMutation();
      expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_BUSY')).toHaveLength(1);
      getStopButton()?.remove();
      notifyMutation();
      await vi.advanceTimersByTimeAsync(300);
      composer.insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
      notifyMutation();
      await vi.advanceTimersByTimeAsync(650);

      expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_IDLE')).toHaveLength(0);

      getStopButton()?.remove();
      notifyMutation();
      await vi.advanceTimersByTimeAsync(800);

      expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_IDLE')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('stops tracking when busy is never observed within 2 seconds', async () => {
    const postMessageSpy = window.parent.postMessage;
    const { composer } = createChatgptComposerDom({ includeSendButton: true, includeStopButton: false });

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      requestId: 'req-fallback',
      context: 'multi-panel',
    });

    await wait(2200);
    composer.insertAdjacentHTML('beforeend', '<button type="button" data-testid="stop-button" aria-label="Stop streaming">Stop</button>');
    await wait(100);

    expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_BUSY')).toHaveLength(0);
    expect(getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_IDLE')).toHaveLength(0);
  });

  it('reports user interaction for non-chatgpt providers during send tracking', async () => {
    window.happyDOM.setURL('https://gemini.google.com/app');
    document.body.innerHTML = '<div class="ql-editor" contenteditable="true"></div>';

    const postMessageSpy = window.parent.postMessage;
    const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

    dispatchMultiPanelMessage({
      type: 'TRIGGER_SEND',
      requestId: 'req-gemini-user-interaction',
      context: 'multi-panel',
    });

    const pointerdownHandler = addEventListenerSpy.mock.calls.find(
      ([eventName]) => eventName === 'pointerdown'
    )?.[1];

    expect(pointerdownHandler).toBeTypeOf('function');

    pointerdownHandler({ isTrusted: true });

    const interactionCalls = getProviderStatusCalls(postMessageSpy, 'PANELIZE_PROVIDER_USER_INTERACTION');
    expect(interactionCalls).toHaveLength(1);
    expect(interactionCalls[0]).toMatchObject({
      requestId: 'req-gemini-user-interaction',
      provider: 'gemini',
      phase: 'user-interaction',
    });
  });

  it('fills and sends the current ChatGPT composer without a prompt-textarea id', async () => {
    document.body.innerHTML = `
      <div contenteditable="true" class="ProseMirror">Unrelated editor</div>
      <form data-chatgpt-composer data-composer-placement="thread">
        <div data-composer-markdown contenteditable="true" class="ProseMirror"><p>Existing draft. </p></div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    `;
    const editor = document.querySelector('[data-composer-markdown]');
    const sentTexts = [];
    document.querySelector('button').addEventListener('click', event => {
      event.preventDefault();
      sentTexts.push(editor.textContent);
    });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT', text: 'Test prompt', autoSubmit: true, context: 'multi-panel',
    });
    await wait(600);

    expect(editor.textContent).toBe('Existing draft. Test prompt');
    expect(document.querySelector('.ProseMirror').textContent).toBe('Unrelated editor');
    expect(sentTexts).toEqual(['Existing draft. Test prompt']);

    dispatchMultiPanelMessage({ type: 'CLEAR_INPUT', context: 'multi-panel' });
    expect(editor.textContent).toBe('');
    expect(document.querySelector('.ProseMirror').textContent).toBe('Unrelated editor');
  });

  it('still fills and sends the legacy prompt-textarea composer', async () => {
    const { prompt, getSendButton } = createChatgptComposerDom();
    const click = vi.spyOn(getSendButton(), 'click');
    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT', text: 'Legacy prompt', autoSubmit: true, context: 'multi-panel',
    });
    await wait(600);
    expect(prompt.textContent).toBe('Legacy prompt');
    expect(click).toHaveBeenCalledOnce();
  });
});
