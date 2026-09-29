import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Same order as the ChatGPT entry in manifest.json.
const scriptSources = [
  'content-scripts/chatgpt-composer.js',
  'content-scripts/enter-behavior-utils.js',
  'content-scripts/enter-behavior-chatgpt.js',
  'content-scripts/focus-toggle.js',
].map(file => readFileSync(resolve(process.cwd(), file), 'utf8'));

const CURRENT_COMPOSER_DOM = `
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

function trustedEnter(overrides = {}) {
  return {
    isTrusted: true,
    code: 'Enter',
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides,
  };
}

describe('ChatGPT composer content scripts', () => {
  let testWindow;
  let document;
  let runtimeMessageListener;

  // One eval, so the scripts share top-level bindings as content scripts in
  // the same world do.
  function loadScripts(html) {
    document.body.innerHTML = html;
    testWindow.eval(scriptSources.join('\n;\n'));
  }

  // happy-dom has no layout (offsetParent is undefined), so mark the home
  // composer the way a browser reports an element that is not rendered.
  function hideHomeComposer() {
    const editor = document.querySelector('[data-composer-placement="home"] [data-composer-markdown]');
    Object.defineProperty(editor, 'offsetParent', { configurable: true, get: () => null });
  }

  function getThreadComposer() {
    const form = document.querySelector('[data-composer-placement="thread"]');
    return { form, editor: form.querySelector('[data-composer-markdown]'), sendButton: form.querySelector('button') };
  }

  beforeEach(() => {
    testWindow = new Window({ url: 'https://chatgpt.com/c/test' });
    document = testWindow.document;
    runtimeMessageListener = null;
    testWindow.chrome = {
      runtime: {
        lastError: null,
        onMessage: { addListener: vi.fn(listener => { runtimeMessageListener = listener; }) },
      },
      storage: {
        local: { get: vi.fn() },
        sync: {
          get: vi.fn((_defaults, callback) => callback({
            enterKeyBehavior: {
              enabled: true,
              newlineModifiers: { shift: true, ctrl: false, alt: false, meta: false },
              sendModifiers: { shift: false, ctrl: false, alt: false, meta: false },
            },
          })),
        },
        onChanged: { addListener: vi.fn() },
      },
    };
  });

  it('finds the rendered current composer instead of the first one in the DOM', () => {
    loadScripts(CURRENT_COMPOSER_DOM);
    const { form, editor } = getThreadComposer();
    hideHomeComposer();

    const composer = testWindow.PanelizeChatgptComposer;
    expect(composer.findEditor()).toBe(editor);
    expect(composer.findForm()).toBe(form);
    expect(composer.isEditor(editor)).toBe(true);
    expect(composer.isEditor(document.querySelector('textarea'))).toBe(false);
  });

  it('sends from the focused current composer with its own form button', () => {
    loadScripts(CURRENT_COMPOSER_DOM);
    const { editor, sendButton } = getThreadComposer();
    const otherButtons = [...document.querySelectorAll('button')].filter(button => button !== sendButton);
    const clicks = [];
    document.querySelectorAll('button').forEach(button => {
      button.addEventListener('click', event => {
        event.preventDefault();
        clicks.push(button);
      });
    });
    editor.focus();
    expect(document.activeElement).toBe(editor);

    const event = trustedEnter();
    testWindow.handleEnterSwap(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(clicks).toEqual([sendButton]);
    expect(otherButtons.some(button => clicks.includes(button))).toBe(false);
  });

  it('turns the newline shortcut on the current composer into Shift+Enter', () => {
    loadScripts(CURRENT_COMPOSER_DOM);
    const { editor, sendButton } = getThreadComposer();
    const click = vi.spyOn(sendButton, 'click');
    const keydowns = [];
    editor.addEventListener('keydown', event => keydowns.push({ key: event.key, shiftKey: event.shiftKey }));
    editor.focus();

    const event = trustedEnter({ shiftKey: true });
    testWindow.handleEnterSwap(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(keydowns).toEqual([{ key: 'Enter', shiftKey: true }]);
    expect(click).not.toHaveBeenCalled();
  });

  it('still sends from the legacy prompt-textarea composer', () => {
    loadScripts(`
      <form data-type="unified-composer">
        <div id="prompt-textarea" contenteditable="true" class="ProseMirror"></div>
        <button type="submit" data-testid="send-button" aria-label="Send prompt">Send</button>
      </form>
    `);
    const sendButton = document.querySelector('[data-testid="send-button"]');
    const click = vi.spyOn(sendButton, 'click');
    document.getElementById('prompt-textarea').focus();

    testWindow.handleEnterSwap(trustedEnter());

    expect(click).toHaveBeenCalledOnce();
  });

  it('leaves Enter alone outside the composer', () => {
    loadScripts(`${CURRENT_COMPOSER_DOM}<div contenteditable="true" id="notes"></div>`);
    const click = vi.spyOn(getThreadComposer().sendButton, 'click');
    document.getElementById('notes').focus();

    const event = trustedEnter();
    testWindow.handleEnterSwap(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('focus toggle moves focus to the rendered current composer', () => {
    loadScripts(CURRENT_COMPOSER_DOM);
    const { editor } = getThreadComposer();
    hideHomeComposer();
    const sendResponse = vi.fn();

    runtimeMessageListener({ action: 'takeFocus' }, {}, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    expect(document.activeElement).toBe(editor);
  });
});
