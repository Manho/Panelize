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
const aistudioEnterSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/enter-behavior-aistudio.js'),
  'utf8'
);

function createHarness({
  enabled = true,
  preset = 'default',
  newlineModifiers = { shift: true, ctrl: false, alt: false, meta: false },
  sendModifiers = { shift: false, ctrl: false, alt: false, meta: false },
  ctrlEnterSubmits = true,
  buttonState = 'run',
  initialValue = 'Hello AI Studio',
  isPromptInput = true
} = {}) {
  const hasSpin = buttonState === 'stop';
  const labelText =
    buttonState === 'stop'
      ? 'Stop'
      : buttonState === 'add'
        ? 'Add'
        : 'Run';

  const sendButton = {
    tagName: 'BUTTON',
    disabled: buttonState === 'disabled',
    className: `ms-button-primary${ctrlEnterSubmits ? ' ctrl-enter-submits' : ''}`,
    classList: {
      contains: vi.fn((token) =>
        token === 'ctrl-enter-submits' ? ctrlEnterSubmits : token === 'disabled' && buttonState === 'disabled'
      )
    },
    textContent: `${labelText} arrow_upward`,
    getAttribute: vi.fn((name) => {
      if (name === 'aria-disabled') {
        return buttonState === 'disabled' ? 'true' : 'false';
      }
      if (name === 'aria-label') {
        return labelText;
      }
      if (name === 'mattooltip') {
        if (buttonState === 'stop') {
          return 'Cancel generation';
        }
        return ctrlEnterSubmits ? 'Send prompt (⌘ + Enter)' : 'Send prompt (Enter)';
      }
      return null;
    }),
    querySelector: vi.fn((selector) => {
      if (selector === '.spin') {
        return hasSpin ? { className: 'material-symbols-outlined spin' } : null;
      }
      if (selector === '.run-button-label') {
        return { textContent: labelText };
      }
      return null;
    }),
    click: vi.fn()
  };

  const editor = {
    tagName: 'TEXTAREA',
    offsetParent: {},
    value: initialValue,
    selectionStart: initialValue.length,
    selectionEnd: initialValue.length,
    placeholder: isPromptInput ? 'Start typing a prompt' : 'Other input',
    className: isPromptInput ? 'textarea' : '',
    classList: {
      contains: vi.fn((token) => isPromptInput && token === 'textarea')
    },
    getAttribute: vi.fn((name) => {
      if (!isPromptInput) {
        return null;
      }
      if (name === 'formcontrolname') {
        return 'promptText';
      }
      if (name === 'aria-label') {
        return 'Enter a prompt';
      }
      return null;
    }),
    closest: vi.fn((selector) => {
      if (selector === 'ms-system-instructions') {
        return isPromptInput ? null : {};
      }
      if (selector.includes('ms-prompt-box')) {
        return isPromptInput ? {} : null;
      }
      return null;
    }),
    setRangeText: vi.fn((replacement, start, end) => {
      editor.value = editor.value.slice(0, start) + replacement + editor.value.slice(end);
      editor.selectionStart = editor.selectionEnd = start + replacement.length;
    }),
    dispatchEvent: vi.fn()
  };

  const context = {
    chrome: {
      runtime: { lastError: null },
      storage: {
        local: { get: vi.fn() },
        sync: {
          get: vi.fn((_defaults, callback) =>
            callback({
              enterKeyBehavior: {
                enabled,
                preset,
                newlineModifiers,
                sendModifiers
              }
            })
          )
        },
        onChanged: { addListener: vi.fn() }
      }
    },
    document: {
      activeElement: editor,
      querySelector: vi.fn((selector) => {
        if (
          selector.includes('ms-run-button') ||
          selector.includes('Run') ||
          selector.includes('Send prompt')
        ) {
          return sendButton;
        }
        return null;
      }),
      querySelectorAll: vi.fn((selector) => {
        if (
          selector.includes('ms-run-button') ||
          selector.includes('Run') ||
          selector.includes('Send prompt') ||
          selector === 'button'
        ) {
          return [sendButton];
        }
        return [];
      })
    },
    window: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getComputedStyle: vi.fn(() => ({
        display: 'inline-flex',
        visibility: 'visible',
        opacity: '1'
      }))
    },
    Event: class Event {
      constructor(type, options) {
        this.type = type;
        Object.assign(this, options);
      }
    }
  };
  context.window.document = context.document;
  context.SendButton = sendButton;

  sendButton.getBoundingClientRect = () => ({ width: 88, height: 36 });

  vm.createContext(context);
  vm.runInContext(buttonFinderSource, context);
  vm.runInContext(utilsSource, context);
  vm.runInContext(aistudioEnterSource, context);

  return { context, editor, sendButton };
}

function createEnterEvent(overrides = {}) {
  return {
    isTrusted: true,
    code: 'Enter',
    key: 'Enter',
    keyCode: 13,
    isComposing: false,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides
  };
}

describe('Google AI Studio Enter behavior customization', () => {
  describe('default AI Studio mode (.ctrl-enter-submits present)', () => {
    it('sends on plain Enter and inserts a newline on Shift+Enter when preset is default', () => {
      const { context, editor, sendButton } = createHarness({
        ctrlEnterSubmits: true
      });

      expect(context.isAiStudioCtrlEnterSubmitsMode()).toBe(true);

      const sendEvent = createEnterEvent();
      context.handleEnterSwap(sendEvent);

      expect(sendEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(sendEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).toHaveBeenCalledTimes(1);

      const newlineEvent = createEnterEvent({ shiftKey: true });
      context.handleEnterSwap(newlineEvent);

      expect(newlineEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(newlineEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(editor.setRangeText).toHaveBeenCalledWith('\n', 15, 15, 'end');
      expect(editor.value).toBe('Hello AI Studio\n');
      expect(editor.dispatchEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'input', bubbles: true })
      );
      expect(sendButton.click).toHaveBeenCalledTimes(1);
    });

    it('inserts a newline on plain Enter and sends on Shift+Enter when preset is swapped', () => {
      const { context, editor, sendButton } = createHarness({
        ctrlEnterSubmits: true,
        preset: 'swapped',
        newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
        sendModifiers: { shift: true, ctrl: false, alt: false, meta: false },
        initialValue: 'Line 1'
      });

      const plainEnter = createEnterEvent();
      context.handleEnterSwap(plainEnter);

      expect(plainEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(plainEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(editor.value).toBe('Line 1\n');
      expect(sendButton.click).not.toHaveBeenCalled();

      const shiftEnter = createEnterEvent({ shiftKey: true });
      context.handleEnterSwap(shiftEnter);

      expect(shiftEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(shiftEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).toHaveBeenCalledTimes(1);
    });

    it('supports Ctrl+Enter send preset and blocks unconfigured Alt+Enter stage shortcut', () => {
      const { context, sendButton } = createHarness({
        ctrlEnterSubmits: true,
        preset: 'ctrl_enter',
        newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
        sendModifiers: { shift: false, ctrl: true, alt: false, meta: false }
      });

      const altEnter = createEnterEvent({ altKey: true });
      context.handleEnterSwap(altEnter);

      expect(altEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(altEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).not.toHaveBeenCalled();

      const ctrlEnter = createEnterEvent({ ctrlKey: true });
      context.handleEnterSwap(ctrlEnter);

      expect(ctrlEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(ctrlEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).toHaveBeenCalledTimes(1);
    });
  });

  describe('alternative AI Studio mode (.ctrl-enter-submits absent / ENTER_SUBMITS)', () => {
    it('prevents native plain-Enter submit and inserts newline when newline is plain Enter and send is Shift+Enter', () => {
      const { context, editor, sendButton } = createHarness({
        ctrlEnterSubmits: false,
        preset: 'swapped',
        newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
        sendModifiers: { shift: true, ctrl: false, alt: false, meta: false },
        initialValue: 'First line'
      });

      expect(context.isAiStudioCtrlEnterSubmitsMode()).toBe(false);

      const plainEnter = createEnterEvent();
      context.handleEnterSwap(plainEnter);

      expect(plainEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(plainEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(editor.value).toBe('First line\n');
      expect(sendButton.click).not.toHaveBeenCalled();

      const shiftEnter = createEnterEvent({ shiftKey: true });
      context.handleEnterSwap(shiftEnter);

      expect(shiftEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(shiftEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).toHaveBeenCalledTimes(1);
    });

    it('supports Cmd+Enter send in non-.ctrl-enter-submits mode', () => {
      const { context, sendButton } = createHarness({
        ctrlEnterSubmits: false,
        preset: 'cmd_enter',
        newlineModifiers: { shift: false, ctrl: false, alt: false, meta: false },
        sendModifiers: { shift: false, ctrl: false, alt: false, meta: true }
      });

      const cmdEnter = createEnterEvent({ metaKey: true });
      context.handleEnterSwap(cmdEnter);

      expect(cmdEnter.preventDefault).toHaveBeenCalledTimes(1);
      expect(cmdEnter.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).toHaveBeenCalledTimes(1);
    });
  });

  describe('Stop/Add/disabled guard, IME composition, and disabled toggle', () => {
    it('never clicks ms-run-button when it is in Stop state (.spin / Cancel generation)', () => {
      const { context, sendButton } = createHarness({
        buttonState: 'stop'
      });

      const sendEvent = createEnterEvent();
      context.handleEnterSwap(sendEvent);

      expect(sendEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(sendEvent.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sendButton.click).not.toHaveBeenCalled();
    });

    it('never clicks ms-run-button when it is in Add or disabled state', () => {
      const addHarness = createHarness({ buttonState: 'add' });
      addHarness.context.handleEnterSwap(createEnterEvent());
      expect(addHarness.sendButton.click).not.toHaveBeenCalled();

      const disabledHarness = createHarness({ buttonState: 'disabled' });
      disabledHarness.context.handleEnterSwap(createEnterEvent());
      expect(disabledHarness.sendButton.click).not.toHaveBeenCalled();
    });

    it('ignores Enter during IME composition (isComposing: true or keyCode: 229)', () => {
      const { context, sendButton } = createHarness();

      const composingEvent = createEnterEvent({ isComposing: true });
      context.handleEnterSwap(composingEvent);
      expect(composingEvent.preventDefault).not.toHaveBeenCalled();
      expect(sendButton.click).not.toHaveBeenCalled();

      const ime229Event = createEnterEvent({ keyCode: 229 });
      context.handleEnterSwap(ime229Event);
      expect(ime229Event.preventDefault).not.toHaveBeenCalled();
      expect(sendButton.click).not.toHaveBeenCalled();
    });

    it('does not intercept Enter when enterKeyBehavior.enabled is false or focus is in system instructions', () => {
      const disabledToggle = createHarness({ enabled: false });
      const event = createEnterEvent();
      disabledToggle.context.handleEnterSwap(event);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(disabledToggle.sendButton.click).not.toHaveBeenCalled();

      const systemInstructionsInput = createHarness({ isPromptInput: false });
      const sysEvent = createEnterEvent();
      systemInstructionsInput.context.handleEnterSwap(sysEvent);
      expect(sysEvent.preventDefault).not.toHaveBeenCalled();
      expect(systemInstructionsInput.sendButton.click).not.toHaveBeenCalled();
    });
  });
});
