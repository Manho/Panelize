import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

const composerScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/chatgpt-composer.js'),
  'utf8'
);
const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

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
    // Same order as the ChatGPT entry in manifest.json.
    window.eval(composerScriptSource);
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

  it('fills the rendered composer and clicks only the send button in its form', async () => {
    document.body.innerHTML = `
      <form data-testid="edit-message">
        <textarea>Earlier message</textarea>
        <button type="submit" aria-label="Send">Send</button>
      </form>
      <form data-chatgpt-composer data-composer-placement="home">
        <div data-composer-markdown contenteditable="true" class="ProseMirror"></div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
      <form data-chatgpt-composer data-composer-placement="thread">
        <div data-composer-markdown contenteditable="true" class="ProseMirror"></div>
        <button type="submit" aria-label="Send">Send</button>
      </form>
    `;
    const [homeEditor, threadEditor] = document.querySelectorAll('[data-composer-markdown]');
    // happy-dom has no layout (offsetParent is undefined); report the home
    // composer the way a browser does for an element that is not rendered.
    Object.defineProperty(homeEditor, 'offsetParent', { configurable: true, get: () => null });
    const threadSendButton = threadEditor.closest('form').querySelector('button');
    const clicked = [];
    document.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        clicked.push(button);
      });
    });

    dispatchMultiPanelMessage({
      type: 'INJECT_TEXT', text: 'Thread prompt', autoSubmit: true, context: 'multi-panel',
    });
    await wait(600);

    expect(threadEditor.textContent).toBe('Thread prompt');
    expect(homeEditor.textContent).toBe('');
    expect(clicked).toEqual([threadSendButton]);
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

  describe('New Chat clears the persisted composer draft', () => {
    function createDraftDom() {
      document.body.innerHTML = `
        <button aria-label="New chat">New chat</button>
        <form data-chatgpt-composer data-composer-placement="home">
          <div data-composer-markdown contenteditable="true" class="ProseMirror"><p>just testhow are you</p></div>
          <button type="submit" aria-label="Send">Send</button>
        </form>
      `;
      const newChatButton = document.querySelector('button[aria-label="New chat"]');
      Object.defineProperty(newChatButton, 'offsetParent', { configurable: true, get: () => document.body });
      newChatButton.getBoundingClientRect = () => ({ x: 0, y: 0, width: 32, height: 32, top: 0, left: 0, right: 32, bottom: 32 });
      const newChatClick = vi.fn();
      newChatButton.addEventListener('click', newChatClick);
      return { editor: document.querySelector('[data-composer-markdown]'), newChatClick };
    }

    it('clears the draft ChatGPT keeps after its own New chat button', async () => {
      window.happyDOM.setURL('https://chatgpt.com/');
      const { editor, newChatClick } = createDraftDom();

      dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });
      await wait(50);

      expect(newChatClick).toHaveBeenCalledOnce();
      expect(editor.textContent).toBe('');

      // ChatGPT restores the draft after re-rendering; the retry clears it again.
      editor.innerHTML = '<p>just testhow are you</p>';
      await wait(400);
      expect(editor.textContent).toBe('');
    });

    it('does not wipe a fill sent right after New Chat', async () => {
      window.happyDOM.setURL('https://chatgpt.com/');
      const { editor } = createDraftDom();

      dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });
      await wait(20);
      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT', text: 'Fresh prompt', autoSubmit: false, context: 'multi-panel',
      });
      await wait(700);

      expect(editor.textContent).toBe('Fresh prompt');
    });

    it('never clicks hidden or offscreen Octane New chat links in narrow columns (avoids Home navigation identity unavailable crash)', async () => {
      window.happyDOM.setURL('https://chatgpt.com/c/existing-thread');
      window.sessionStorage.clear();
      document.body.innerHTML = `
        <aside style="display: none;">
          <a id="desktop-octane-new-chat" data-octane-navigation-item="new_chat">New chat</a>
        </aside>
        <div id="mobile-drawer">
          <a id="drawer-octane-new-chat" aria-label="New chat" data-octane-navigation-item="new_chat" style="visibility: hidden;">New chat</a>
        </div>
        <form data-chatgpt-composer data-composer-placement="thread">
          <div data-composer-markdown contenteditable="true" class="ProseMirror"><p>narrow column draft</p></div>
          <button type="submit" aria-label="Send">Send</button>
        </form>
      `;

      const desktopLink = document.getElementById('desktop-octane-new-chat');
      const drawerLink = document.getElementById('drawer-octane-new-chat');
      const editor = document.querySelector('[data-composer-markdown]');
      Object.defineProperty(editor, 'offsetParent', { configurable: true, get: () => document.body });
      editor.getBoundingClientRect = () => ({ x: 16, y: 500, width: 420, height: 48, top: 500, left: 16, right: 436, bottom: 548 });

      Object.defineProperty(desktopLink, 'offsetParent', { configurable: true, get: () => null });
      desktopLink.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });

      Object.defineProperty(drawerLink, 'offsetParent', { configurable: true, get: () => document.body });
      drawerLink.getBoundingClientRect = () => ({ x: -306, y: 8, width: 260, height: 40, top: 8, left: -306, right: -46, bottom: 48 });

      const desktopClickSpy = vi.fn(() => {
        throw new Error('Home navigation identity unavailable');
      });
      const drawerClickSpy = vi.fn(() => {
        throw new Error('Home navigation identity unavailable');
      });
      desktopLink.addEventListener('click', desktopClickSpy);
      drawerLink.addEventListener('click', drawerClickSpy);

      dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' });
      await wait(50);

      expect(desktopClickSpy).not.toHaveBeenCalled();
      expect(drawerClickSpy).not.toHaveBeenCalled();
      expect(editor.textContent).toBe('');
      expect(window.sessionStorage.getItem('panelize:chatgpt-pending-new-chat-clear')).not.toBeNull();
      expect(window.location.href).toBe('https://chatgpt.com/');
    });

    it('supports narrow ChatGPT Temporary chat header button aria-label', async () => {
      window.happyDOM.setURL('https://chatgpt.com/');
      const postMessageSpy = vi.fn();
      Object.defineProperty(window, 'parent', {
        configurable: true,
        value: { postMessage: postMessageSpy },
      });

      document.body.innerHTML = '<button id="narrow-temp-chat" aria-label="Temporary chat"></button>';
      const tempButton = document.getElementById('narrow-temp-chat');
      Object.defineProperty(tempButton, 'offsetParent', { configurable: true, get: () => document.body });
      tempButton.getBoundingClientRect = () => ({ x: 418, y: 8, width: 36, height: 36, top: 8, left: 418, right: 454, bottom: 44 });

      const clickSpy = vi.fn();
      tempButton.addEventListener('click', clickSpy);

      dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT', context: 'multi-panel' });
      await wait(50);

      expect(clickSpy).toHaveBeenCalledOnce();
      expect(
        postMessageSpy.mock.calls.some(
          ([payload]) => payload?.type === 'PANELIZE_TEMP_CHAT_ENABLED' && payload?.provider === 'chatgpt'
        )
      ).toBe(true);
    });

    it('fills, clears, and sends narrow ChatGPT mobile-composer-prompt textarea', async () => {
      window.happyDOM.setURL('https://chatgpt.com/');
      document.body.innerHTML = `
        <form data-mobile-composer>
          <textarea id="mobile-composer-prompt" data-mobile-composer-prompt name="prompt"></textarea>
          <button id="mobile-send" type="submit" aria-label="Send message"></button>
        </form>
      `;
      const textarea = document.getElementById('mobile-composer-prompt');
      const sendBtn = document.getElementById('mobile-send');
      Object.defineProperty(textarea, 'offsetParent', { configurable: true, get: () => document.body });
      Object.defineProperty(sendBtn, 'offsetParent', { configurable: true, get: () => document.body });
      const sendClick = vi.fn((e) => e.preventDefault());
      sendBtn.addEventListener('click', sendClick);

      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT',
        text: 'Narrow column prompt',
        autoSubmit: true,
        context: 'multi-panel',
      });
      await wait(600);

      expect(textarea.value).toBe('Narrow column prompt');
      expect(sendClick).toHaveBeenCalledOnce();

      dispatchMultiPanelMessage({
        type: 'CLEAR_INPUT',
        context: 'multi-panel',
      });
      await wait(50);

      expect(textarea.value).toBe('');
    });

    it('waits past 2000ms for a slow reloaded composer to mount before consuming the marker, and never erases trusted user typing', async () => {
      const { Window: HappyWindow } = await import('happy-dom');
      const frameWin = new HappyWindow({ url: 'https://chatgpt.com/' });
      const hostStub = { postMessage: vi.fn() };
      Object.defineProperty(frameWin, 'parent', { configurable: true, value: hostStub });
      Object.defineProperty(frameWin, 'top', { configurable: true, value: hostStub });

      vi.useFakeTimers();
      try {
        frameWin.setTimeout = globalThis.setTimeout;
        frameWin.clearTimeout = globalThis.clearTimeout;
        frameWin.Date = globalThis.Date;

        frameWin.document.body.innerHTML = '<div id="app-loading-shell">Loading...</div>';
        frameWin.sessionStorage.setItem(
          'panelize:chatgpt-pending-new-chat-clear',
          String(Date.now())
        );

        frameWin.eval(composerScriptSource);
        frameWin.eval(contentScriptSource);

        // Past the old 2000ms cutoff with no composer mounted yet: marker is still retained
        await vi.advanceTimersByTimeAsync(2500);
        expect(
          frameWin.sessionStorage.getItem('panelize:chatgpt-pending-new-chat-clear')
        ).not.toBeNull();

        // At 3200ms ChatGPT mounts its composer with a persisted draft
        const form = frameWin.document.createElement('form');
        form.setAttribute('data-chatgpt-composer', '');
        form.setAttribute('data-composer-placement', 'home');
        const slowEditor = frameWin.document.createElement('div');
        slowEditor.id = 'slow-editor';
        slowEditor.setAttribute('data-composer-markdown', '');
        slowEditor.setAttribute('contenteditable', 'true');
        slowEditor.className = 'ProseMirror';
        slowEditor.innerHTML = '<p>persisted cold-load draft</p>';
        Object.defineProperty(slowEditor, 'offsetParent', {
          configurable: true,
          get: () => frameWin.document.body,
        });
        const sendBtn = frameWin.document.createElement('button');
        sendBtn.type = 'submit';
        sendBtn.setAttribute('aria-label', 'Send');
        form.append(slowEditor, sendBtn);
        frameWin.document.body.appendChild(form);

        await vi.advanceTimersByTimeAsync(300);
        expect(slowEditor.textContent).toBe('');
        expect(
          frameWin.sessionStorage.getItem('panelize:chatgpt-pending-new-chat-clear')
        ).toBeNull();

        // Late React draft hydration 200ms after mount is also cleared
        slowEditor.innerHTML = '<p>late hydrated draft</p>';
        await vi.advanceTimersByTimeAsync(350);
        expect(slowEditor.textContent).toBe('');

        // Trusted user typing cancels remaining passes so user input is never erased
        const trustedKeydown = new frameWin.KeyboardEvent('keydown', { key: 'H', bubbles: true });
        Object.defineProperty(trustedKeydown, 'isTrusted', { value: true });
        slowEditor.dispatchEvent(trustedKeydown);
        slowEditor.innerHTML = '<p>Hello from user</p>';

        await vi.advanceTimersByTimeAsync(2500);
        expect(slowEditor.textContent).toBe('Hello from user');
      } finally {
        vi.useRealTimers();
        await frameWin.happyDOM.close();
      }
    });
  });
});
