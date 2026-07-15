import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-utils.js'),
  'utf8'
);
const scriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-zai-global.js'),
  'utf8'
);

function createHarness() {
  const sendButton = {
    disabled: false,
    getAttribute: vi.fn(() => null),
    click: vi.fn(),
  };
  const editor = {
    tagName: 'TEXTAREA',
    offsetParent: {},
    placeholder: 'How can I help you today?',
    selectionStart: 4,
    selectionEnd: 4,
    classList: { contains: vi.fn((name) => name === 'input-scroll') },
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

describe('Z.ai Global Enter behavior', () => {
  it('clicks the verified send button for Enter', () => {
    const { context, sendButton } = createHarness();

    context.handleEnterSwap(trustedEnter());

    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('inserts a newline for Shift+Enter', () => {
    const { context, editor, sendButton } = createHarness();

    context.handleEnterSwap(trustedEnter({ shiftKey: true }));

    expect(editor.setRangeText).toHaveBeenCalledWith('\n', 4, 4, 'end');
    expect(sendButton.click).not.toHaveBeenCalled();
  });
});
