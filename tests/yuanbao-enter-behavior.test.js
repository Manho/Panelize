import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const utilsSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-utils.js'),
  'utf8'
);
const buttonFinderSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/button-finder-utils.js'),
  'utf8'
);

function createHarness({
  enabled = true,
  yuanbaoState = null,
  yuanbaoIcon = '0 0 48 48',
} = {}) {
  const scriptSource = readFileSync(
    resolve(process.cwd(), 'content-scripts/enter-behavior-yuanbao.js'),
    'utf8'
  );
  const sendButton = {
    className: `SendButton_sendButton__test${
        yuanbaoState
          ? ` SendButton_${yuanbaoState}__test`
          : enabled ? '' : ' SendButton_disabled__test'
      }`,
    disabled: false,
    getAttribute: vi.fn((name) => {
      if (name === 'aria-label') {
        return yuanbaoState === 'sendStop' ? 'Stop Answering' : 'Send';
      }
      return null;
    }),
    querySelector: vi.fn(() => ({
      getAttribute: vi.fn((name) => name === 'viewBox'
        ? yuanbaoIcon
        : null),
    })),
    click: vi.fn(),
  };
  const editor = {
    tagName: 'DIV',
    offsetParent: {},
    selectionStart: 5,
    selectionEnd: 5,
    getAttribute: vi.fn((name) => (
      name === 'contenteditable' ? 'true' : null
    )),
    classList: {
      contains: vi.fn((className) => className === 'ql-editor'),
    },
    parentElement: null,
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
      querySelector: vi.fn(() => sendButton),
      createElement: vi.fn((tagName) => ({ tagName })),
      execCommand: vi.fn(() => true),
    },
    window: {
      ButtonFinderUtils: { findButton: vi.fn(() => sendButton) },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getSelection: vi.fn(),
    },
    Event: class Event {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    },
  };

  vm.createContext(context);
  vm.runInContext(buttonFinderSource, context);
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

describe('Yuanbao Enter behavior', () => {
  it('sends through the enabled provider control', () => {
    const { context, sendButton } = createHarness();

    context.handleEnterSwap(createEnterEvent());

    expect(sendButton.click).toHaveBeenCalledTimes(1);
  });

  it('does not send while the provider control is disabled', () => {
    const { context, sendButton } = createHarness({ enabled: false });

    context.handleEnterSwap(createEnterEvent());

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it.each(['sendNot', 'loading', 'sending', 'sendStop'])(
    'does not send while the Yuanbao control is %s',
    (yuanbaoState) => {
      const { context, sendButton } = createHarness({ yuanbaoState });

      context.handleEnterSwap(createEnterEvent());

      expect(sendButton.click).not.toHaveBeenCalled();
    }
  );

  it('ignores an unknown Yuanbao icon and accepts the observed Chinese send labels', () => {
    const { context, sendButton } = createHarness({ yuanbaoIcon: '0 0 24 24' });
    context.handleEnterSwap(createEnterEvent());
    expect(sendButton.click).not.toHaveBeenCalled();

    sendButton.querySelector.mockReturnValue({
      getAttribute: vi.fn(() => '0 0 48 48'),
    });
    for (const label of ['发送', '發送']) {
      sendButton.getAttribute.mockImplementation((name) => name === 'aria-label' ? label : null);
      context.handleEnterSwap(createEnterEvent());
    }
    expect(sendButton.click).toHaveBeenCalledTimes(2);
  });

  it('inserts a newline for Shift+Enter', () => {
    const { context, sendButton } = createHarness();

    context.handleEnterSwap(createEnterEvent({ shiftKey: true }));

    expect(context.document.execCommand).toHaveBeenCalledWith('insertParagraph', false);
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('ignores IME composition Enter', () => {
    const { context, sendButton } = createHarness();

    context.handleEnterSwap(createEnterEvent({ isComposing: true }));

    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('inserts a paragraph at the caret if the first editing command fails', () => {
    const { context, sendButton } = createHarness();
    context.document.execCommand.mockReturnValueOnce(false).mockReturnValueOnce(true);
    context.handleEnterSwap(createEnterEvent({ shiftKey: true }));
    expect(context.document.execCommand.mock.calls.map(([command]) => command))
      .toEqual(['insertParagraph', 'insertLineBreak']);
    expect(sendButton.click).not.toHaveBeenCalled();
  });

  it('uses the selection rather than appending at the end when native commands fail', () => {
    const { context, editor } = createHarness();
    const range = {
      deleteContents: vi.fn(),
      insertNode: vi.fn(),
      setStartAfter: vi.fn(),
      collapse: vi.fn(),
    };
    const selection = {
      anchorNode: {},
      rangeCount: 1,
      getRangeAt: vi.fn(() => range),
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    };
    editor.contains = vi.fn(() => true);
    context.window.getSelection.mockReturnValue(selection);
    context.document.execCommand.mockReturnValue(false);

    context.handleEnterSwap(createEnterEvent({ shiftKey: true }));

    expect(range.insertNode).toHaveBeenCalledWith({ tagName: 'br' });
    expect(range.setStartAfter).toHaveBeenCalledWith(range.insertNode.mock.calls[0][0]);
    expect(editor.appendChild).not.toHaveBeenCalled();
    expect(editor.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'input' }));
  });
});
