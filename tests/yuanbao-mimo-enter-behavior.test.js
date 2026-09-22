import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-utils.js'),
  'utf8'
);

function createHarness(providerId, { enabled = true, yuanbaoState = null } = {}) {
  const scriptSource = readFileSync(
    resolve(process.cwd(), `content-scripts/enter-behavior-${providerId}.js`),
    'utf8'
  );
  const sendButton = {
    className: providerId === 'yuanbao'
      ? `SendButton_sendButton__test${
        yuanbaoState
          ? ` SendButton_${yuanbaoState}__test`
          : enabled ? '' : ' SendButton_disabled__test'
      }`
      : '',
    disabled: providerId === 'mimo' ? !enabled : false,
    getAttribute: vi.fn((name) => {
      if (name === 'data-state' && providerId === 'mimo') return 'closed';
      return null;
    }),
    click: vi.fn(),
  };
  const editor = {
    tagName: providerId === 'yuanbao' ? 'DIV' : 'TEXTAREA',
    offsetParent: {},
    selectionStart: 5,
    selectionEnd: 5,
    getAttribute: vi.fn((name) => (
      providerId === 'yuanbao' && name === 'contenteditable' ? 'true' : null
    )),
    classList: {
      contains: vi.fn((className) => providerId === 'yuanbao' && className === 'ql-editor'),
    },
    closest: vi.fn(() => providerId === 'mimo' ? {} : null),
    focus: vi.fn(),
    appendChild: vi.fn(),
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
  };

  vm.createContext(context);
  vm.runInContext(utilsSource, context);
  vm.runInContext(scriptSource, context);
  return { context, editor, sendButton };
}

function createEnterEvent(overrides = {}) {
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

describe.each(['yuanbao', 'mimo'])('%s Enter behavior', (providerId) => {
  it('sends through the enabled provider control', () => {
    const { context, sendButton } = createHarness(providerId);

    context.handleEnterSwap(createEnterEvent());

    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('does not send while the provider control is disabled', () => {
    const { context, sendButton } = createHarness(providerId, { enabled: false });

    context.handleEnterSwap(createEnterEvent());

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  if (providerId === 'yuanbao') {
    it.each(['sendNot', 'loading', 'sending'])(
      'does not send while the Yuanbao control is %s',
      (yuanbaoState) => {
        const { context, sendButton } = createHarness(providerId, { yuanbaoState });

        context.handleEnterSwap(createEnterEvent());

        expect(sendButton.click).not.toHaveBeenCalled();
      }
    );
  }

  it('inserts a newline for Shift+Enter', () => {
    const { context, editor, sendButton } = createHarness(providerId);

    context.handleEnterSwap(createEnterEvent({ shiftKey: true }));

    if (providerId === 'yuanbao') {
      expect(context.document.execCommand).toHaveBeenCalledWith('insertLineBreak', false);
    } else {
      expect(editor.setRangeText).toHaveBeenCalledWith('\n', 5, 5, 'end');
    }
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('ignores IME composition Enter', () => {
    const { context, sendButton } = createHarness(providerId);

    context.handleEnterSwap(createEnterEvent({ isComposing: true }));

    expect(sendButton.click).not.toHaveBeenCalled();
  });
});
