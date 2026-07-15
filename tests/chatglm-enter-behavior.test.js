import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-utils.js'),
  'utf8'
);
const scriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-chatglm.js'),
  'utf8'
);

function createHarness() {
  const sendButton = {
    disabled: false,
    getAttribute: vi.fn(() => null),
    dispatchEvent: vi.fn(),
  };
  const editor = {
    tagName: 'TEXTAREA',
    offsetParent: {},
    selectionStart: 5,
    selectionEnd: 5,
    classList: { contains: vi.fn((name) => name === 'scroll-display-none') },
    closest: vi.fn((selector) => selector === '#search-input-box' ? {} : null),
    setRangeText: vi.fn(),
    dispatchEvent: vi.fn(),
  };
  const context = {
    chrome: {
      runtime: { lastError: null },
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
    },
    document: { activeElement: editor },
    window: {
      ButtonFinderUtils: { findButton: vi.fn(() => sendButton) },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    Event: class Event {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
    KeyboardEvent: class KeyboardEvent {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
    MouseEvent: class MouseEvent {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
  };

  vm.createContext(context);
  vm.runInContext(utilsSource, context);
  vm.runInContext(scriptSource, context);
  return { context, editor, sendButton };
}

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

describe('ChatGLM Enter behavior', () => {
  it('dispatches the verified mousedown send event for Enter', () => {
    const { context, sendButton } = createHarness();

    context.handleEnterSwap(trustedEnter());

    expect(sendButton.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(sendButton.dispatchEvent.mock.calls[0][0]).toMatchObject({
      type: 'mousedown',
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
    });
  });

  it('inserts a newline for Shift+Enter', () => {
    const { context, editor, sendButton } = createHarness();

    context.handleEnterSwap(trustedEnter({ shiftKey: true }));

    expect(editor.setRangeText).toHaveBeenCalledWith('\n', 5, 5, 'end');
    expect(sendButton.dispatchEvent).not.toHaveBeenCalled();
  });
});
