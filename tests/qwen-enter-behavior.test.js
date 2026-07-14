import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-utils.js'),
  'utf8'
);

function createEnterBehaviorHarness(providerId) {
  const scriptSource = readFileSync(
    resolve(process.cwd(), `content-scripts/enter-behavior-${providerId}.js`),
    'utf8'
  );
  const sendButton = {
    disabled: false,
    getAttribute: vi.fn(() => null),
    click: vi.fn(),
  };
  const editor = {
    tagName: providerId === 'qwen-cn' ? 'DIV' : 'TEXTAREA',
    offsetParent: {},
    selectionStart: 5,
    selectionEnd: 5,
    getAttribute: vi.fn((name) => {
      if (providerId !== 'qwen-cn') return null;
      return {
        'data-slate-editor': 'true',
        contenteditable: 'true',
        role: 'textbox',
      }[name] || null;
    }),
    focus: vi.fn(),
    appendChild: vi.fn(),
    classList: {
      contains: vi.fn((className) => (
        providerId === 'qwen-global' && className === 'message-input-textarea'
      )),
    },
    closest: vi.fn((selector) => (
      providerId === 'qwen-cn' && selector === '[data-chat-input-body="true"]' ? {} : null
    )),
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
    document: {
      activeElement: editor,
      createTextNode: vi.fn((text) => ({ textContent: text })),
      execCommand: vi.fn(() => true),
    },
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

function createTrustedEnterEvent(overrides = {}) {
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

describe.each(['qwen-cn', 'qwen-global'])('%s Enter behavior', (providerId) => {
  it('clicks the verified send control for Enter', () => {
    const { context, sendButton } = createEnterBehaviorHarness(providerId);

    context.handleEnterSwap(createTrustedEnterEvent());

    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('inserts a newline for Shift+Enter', () => {
    const { context, editor, sendButton } = createEnterBehaviorHarness(providerId);

    context.handleEnterSwap(createTrustedEnterEvent({ shiftKey: true }));

    if (providerId === 'qwen-cn') {
      expect(context.document.execCommand).toHaveBeenCalledWith('insertLineBreak', false);
    } else {
      expect(editor.setRangeText).toHaveBeenCalledWith('\n', 5, 5, 'end');
    }
    expect(sendButton.click).not.toHaveBeenCalled();
  });
});
