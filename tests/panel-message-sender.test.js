import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN, dispatchMultiPanelMessage } from './helpers/multi-panel-messages.js';

const composerScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/chatgpt-composer.js'),
  'utf8'
);
const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function wait(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function markVisible(element) {
  Object.defineProperty(element, 'offsetParent', { configurable: true, get: () => document.body });
  element.getBoundingClientRect = () => ({
    top: 10, left: 10, right: 110, bottom: 40, width: 100, height: 30, x: 10, y: 10,
  });
}

function createChatgptDom() {
  document.body.innerHTML = `
    <nav>
      <button type="button" data-testid="new-chat-button" aria-label="New chat">New chat</button>
      <button type="button" aria-label="Turn on temporary chat">Temp</button>
    </nav>
    <form data-type="unified-composer">
      <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
      <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
    </form>
  `;
  document.querySelectorAll('button').forEach(markVisible);
  const clicks = { send: 0, newChat: 0, tempChat: 0 };
  document.querySelector('[data-testid="send-button"]').addEventListener('click', () => { clicks.send += 1; });
  document.querySelector('[data-testid="new-chat-button"]').addEventListener('click', () => { clicks.newChat += 1; });
  document.querySelector('[aria-label="Turn on temporary chat"]').addEventListener('click', () => { clicks.tempChat += 1; });
  return { prompt: document.getElementById('prompt-textarea'), clicks };
}

function parentMessagesOfType(type) {
  return window.parent.postMessage.mock.calls.map(call => call[0]).filter(data => data?.type === type);
}

/**
 * One case per message type the content script acts on. `run` dispatches
 * the message with the given sender, waits, and returns what it observed;
 * `untouched` is the observation when the message was ignored.
 */
const MESSAGE_CASES = [
  {
    type: 'INJECT_TEXT',
    async run(dom, sender) {
      dispatchMultiPanelMessage({ type: 'INJECT_TEXT', text: 'Injected prompt', autoSubmit: true, context: 'multi-panel' }, sender);
      await wait(600);
      return { text: dom.prompt.textContent, sends: dom.clicks.send };
    },
    untouched: { text: '', sends: 0 },
  },
  {
    type: 'INJECT_TEXT_WITH_IMAGES',
    async run(dom, sender) {
      dispatchMultiPanelMessage({
        type: 'INJECT_TEXT_WITH_IMAGES', text: 'Prompt with images', images: [], autoSubmit: true,
        requestId: 'fill-request', context: 'multi-panel',
      }, sender);
      await wait(1200);
      return {
        text: dom.prompt.textContent,
        sends: dom.clicks.send,
        results: parentMessagesOfType('PANELIZE_ACTION_RESULT').length,
      };
    },
    untouched: { text: '', sends: 0, results: 0 },
  },
  {
    type: 'TRIGGER_SEND',
    async run(dom, sender) {
      dom.prompt.textContent = 'Typed by the user';
      dispatchMultiPanelMessage({ type: 'TRIGGER_SEND', requestId: 'send-request', context: 'multi-panel' }, sender);
      await wait(300);
      return { sends: dom.clicks.send };
    },
    untouched: { sends: 0 },
  },
  {
    type: 'NEW_CHAT',
    async run(dom, sender) {
      dispatchMultiPanelMessage({ type: 'NEW_CHAT', context: 'multi-panel' }, sender);
      await wait(300);
      return { newChats: dom.clicks.newChat };
    },
    untouched: { newChats: 0 },
  },
  {
    type: 'ENABLE_TEMP_CHAT',
    async run(dom, sender) {
      dispatchMultiPanelMessage({ type: 'ENABLE_TEMP_CHAT', context: 'multi-panel' }, sender);
      await wait(300);
      return { tempChats: dom.clicks.tempChat };
    },
    untouched: { tempChats: 0 },
  },
  {
    type: 'CLEAR_INPUT',
    async run(dom, sender) {
      dom.prompt.textContent = 'Draft the user is writing';
      dispatchMultiPanelMessage({ type: 'CLEAR_INPUT', clearImages: true, context: 'multi-panel' }, sender);
      await wait(100);
      return { text: dom.prompt.textContent };
    },
    untouched: { text: 'Draft the user is writing' },
  },
  ...['PANELIZE_SNAPSHOT_PREPARE', 'PANELIZE_SNAPSHOT_SCROLL', 'PANELIZE_SNAPSHOT_RESTORE'].map(type => ({
    type,
    async run(_dom, sender) {
      dispatchMultiPanelMessage({
        type, context: 'multi-panel', requestId: `${type}-request`, sessionId: 'snapshot-session',
        prompt: '', align: false, scrollTop: 0,
      }, sender);
      await wait(700);
      return { replies: parentMessagesOfType('PANELIZE_SNAPSHOT_STATE').length };
    },
    untouched: { replies: 0 },
  })),
];

const OTHER_WINDOW = { postMessage: () => {} };

// Senders that hold a reference to the provider window but are not the
// Multi-Panel page embedding it.
const UNTRUSTED_SENDERS = [
  ['another window on the extension origin', () => ({ source: OTHER_WINDOW })],
  ['the provider page itself', () => ({ source: window, origin: 'https://chatgpt.com' })],
  ['no source window', () => ({ source: null })],
  ['the parent on a web origin', () => ({ origin: 'https://third-party.example' })],
  ['the parent on another extension origin', () => ({ origin: 'chrome-extension://another-extension-id' })],
  ['the parent on the extension origin with a path', () => ({ origin: `${EXTENSION_ORIGIN}/multi-panel/multi-panel.html` })],
  ['the parent on an opaque origin', () => ({ origin: 'null' })],
  ['the parent with no origin', () => ({ origin: '' })],
];

describe('panel messages are accepted only from the Multi-Panel page', () => {
  beforeAll(() => {
    // Same order as the ChatGPT entry in manifest.json.
    window.eval(composerScriptSource);
    window.eval(contentScriptSource);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    window.happyDOM.setURL('https://chatgpt.com/');
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
  });

  it('derives the trusted origin from chrome.runtime.getURL', () => {
    expect(EXTENSION_ORIGIN).toBe('chrome-extension://panelize-test-extension-id');
  });

  describe.each(MESSAGE_CASES)('$type', (messageCase) => {
    it('acts on the message from the embedding extension page', async () => {
      const dom = createChatgptDom();
      const observed = await messageCase.run(dom, {});
      expect(observed).not.toEqual(messageCase.untouched);
    });

    it.each(UNTRUSTED_SENDERS)('ignores the message from %s', async (_name, sender) => {
      const dom = createChatgptDom();
      const observed = await messageCase.run(dom, sender());
      expect(observed).toEqual(messageCase.untouched);
    });
  });
});
