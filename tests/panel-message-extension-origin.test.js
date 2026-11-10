import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN } from './helpers/multi-panel-messages.js';

const composerScriptSource = readFileSync(resolve(process.cwd(), 'content-scripts/chatgpt-composer.js'), 'utf8');
const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function wait(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

/**
 * Loads the ChatGPT content scripts into a fresh panel frame whose
 * chrome.runtime is `runtime`, then has the Multi-Panel parent ask it to
 * type and send a prompt.
 */
async function sendPromptToFreshFrame(runtime) {
  const frame = new Window({ url: 'https://chatgpt.com/' });
  const parent = { postMessage: vi.fn() };
  Object.defineProperty(frame, 'parent', { configurable: true, value: parent });
  frame.chrome = { ...globalThis.chrome, runtime };
  frame.document.body.innerHTML = `
    <form data-type="unified-composer">
      <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Chat with ChatGPT"></div>
      <button type="button" data-testid="send-button" aria-label="Send prompt">Send</button>
    </form>
  `;
  const sendButton = frame.document.querySelector('[data-testid="send-button"]');
  Object.defineProperty(sendButton, 'offsetParent', { configurable: true, get: () => frame.document.body });
  sendButton.getBoundingClientRect = () => ({ top: 10, left: 10, right: 110, bottom: 40, width: 100, height: 30, x: 10, y: 10 });
  let sends = 0;
  sendButton.addEventListener('click', () => { sends += 1; });
  const warn = vi.spyOn(frame.console, 'warn').mockImplementation(() => {});

  frame.eval(composerScriptSource);
  frame.eval(contentScriptSource);
  frame.dispatchEvent(new frame.MessageEvent('message', {
    data: { type: 'INJECT_TEXT', text: 'Injected prompt', autoSubmit: true, context: 'multi-panel' },
    source: parent,
    origin: EXTENSION_ORIGIN,
  }));
  await wait(600);

  const result = {
    text: frame.document.getElementById('prompt-textarea').textContent,
    sends,
    parentPosts: parent.postMessage.mock.calls,
    warnings: warn.mock.calls.map(call => String(call[0])),
  };
  await frame.happyDOM.close();
  return result;
}

describe('the extension origin the panel content script trusts', () => {
  it('lets the Multi-Panel page drive the frame when chrome.runtime.getURL works', async () => {
    const result = await sendPromptToFreshFrame(globalThis.chrome.runtime);

    expect(result.text).toBe('Injected prompt');
    expect(result.sends).toBe(1);
    expect(result.parentPosts.length).toBeGreaterThan(0);
    result.parentPosts.forEach(call => expect(call[1]).toBe(EXTENSION_ORIGIN));
  });

  it.each([
    ['is missing', () => ({ ...globalThis.chrome.runtime, getURL: undefined })],
    ['throws', () => ({ ...globalThis.chrome.runtime, getURL: () => { throw new Error('Extension context invalidated.'); } })],
    ['returns no origin', () => ({ ...globalThis.chrome.runtime, getURL: () => '' })],
  ])('ignores every panel message and posts nothing when chrome.runtime.getURL %s', async (_name, runtime) => {
    const result = await sendPromptToFreshFrame(runtime());

    expect(result.text).toBe('');
    expect(result.sends).toBe(0);
    expect(result.parentPosts).toEqual([]);
  });

  it('warns when the extension origin is unavailable', async () => {
    const result = await sendPromptToFreshFrame({ ...globalThis.chrome.runtime, getURL: undefined });

    expect(result.warnings.some(text => text.includes('Extension origin unavailable'))).toBe(true);
  });
});
