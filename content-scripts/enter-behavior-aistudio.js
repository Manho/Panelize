// Google AI Studio Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const AI_STUDIO_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: 'ms-prompt-box ms-run-button button'
  },
  {
    type: 'css',
    value: 'ms-run-button button.run-button'
  },
  {
    type: 'css',
    value: 'button[aria-label*="Run" i]'
  },
  {
    type: 'css',
    value: 'button[mattooltip*="Send prompt" i]'
  }
];

function isAiStudioInput(element) {
  if (!element || element.tagName !== 'TEXTAREA' || element.offsetParent === null) {
    return false;
  }

  if (element.closest?.('ms-system-instructions')) {
    return false;
  }

  const ariaLabel = String(element.getAttribute?.('aria-label') || '');
  const placeholder = String(element.placeholder || element.getAttribute?.('placeholder') || '');
  const className = String(element.className || '');

  return Boolean(
    element.getAttribute?.('formcontrolname') === 'promptText' ||
    element.classList?.contains?.('textarea') ||
    /\btextarea\b/.test(className) ||
    ariaLabel === 'Enter a prompt' ||
    /prompt/i.test(ariaLabel) ||
    /prompt/i.test(placeholder) ||
    element.closest?.('ms-prompt-box, ms-autosize-textarea')
  );
}

function findRawAiStudioRunButton() {
  if (typeof document.querySelector === 'function') {
    const direct =
      document.querySelector('ms-prompt-box ms-run-button button') ||
      document.querySelector('ms-run-button button.run-button') ||
      document.querySelector('ms-run-button button');
    if (direct) {
      return direct;
    }
  }
  return window.ButtonFinderUtils?.findButton?.(AI_STUDIO_SEND_BUTTON_SELECTORS) || null;
}

/**
 * AI Studio defaults to CTRL_ENTER_SUBMITS (marked by .ctrl-enter-submits on
 * <ms-run-button>'s button), where plain Enter inserts a newline and
 * Ctrl+Enter / Cmd+Enter submits. Users can switch AI Studio to ENTER_SUBMITS
 * in preferences, which removes .ctrl-enter-submits.
 */
function isAiStudioCtrlEnterSubmitsMode(button = findRawAiStudioRunButton()) {
  if (!button) {
    return true;
  }
  if (typeof button.classList?.contains === 'function') {
    return button.classList.contains('ctrl-enter-submits');
  }
  return /\bctrl-enter-submits\b/.test(String(button.className || ''));
}

function isAiStudioSendEnabled(sendButton) {
  if (typeof window.ButtonFinderUtils?.isAiStudioSendControl === 'function') {
    return window.ButtonFinderUtils.isAiStudioSendControl(sendButton) === true;
  }
  if (!sendButton || sendButton.disabled === true || sendButton.getAttribute?.('aria-disabled') === 'true') {
    return false;
  }
  if (sendButton.querySelector?.('.spin')) {
    return false;
  }
  const ariaLabel = String(sendButton.getAttribute?.('aria-label') || '').trim();
  const matTooltip = String(sendButton.getAttribute?.('mattooltip') || sendButton.getAttribute?.('matTooltip') || '').trim();
  const textContent = String(sendButton.textContent || '').trim();
  if (
    /(cancel generation|\bstop\b)/i.test(ariaLabel) ||
    /(cancel generation|\bstop\b)/i.test(matTooltip) ||
    /stop/i.test(textContent) ||
    /^add(\s|$)/i.test(textContent) ||
    /^add$/i.test(ariaLabel)
  ) {
    return false;
  }
  return true;
}

function findAiStudioSendButton() {
  if (typeof window.ButtonFinderUtils?.findSendButton === 'function') {
    const button = window.ButtonFinderUtils.findSendButton('aistudio');
    if (button && isAiStudioSendEnabled(button)) {
      return button;
    }
  }
  const candidate = window.ButtonFinderUtils?.findButton?.(AI_STUDIO_SEND_BUTTON_SELECTORS) || null;
  return isAiStudioSendEnabled(candidate) ? candidate : null;
}

function setAiStudioTextareaValue(textarea, nextValue) {
  const prototype =
    (typeof window !== 'undefined' && window.HTMLTextAreaElement?.prototype) ||
    (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null);
  const nativeSetter = prototype
    ? Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    : null;

  if (nativeSetter) {
    try {
      nativeSetter.call(textarea, nextValue);
      return;
    } catch (error) {
      // Fall back to direct value assignment on synthetic test objects.
    }
  }

  textarea.value = nextValue;
}

function insertAiStudioNewline(textarea) {
  const currentValue = typeof textarea.value === 'string' ? textarea.value : null;
  const start = typeof textarea.selectionStart === 'number'
    ? textarea.selectionStart
    : (currentValue !== null ? currentValue.length : 0);
  const end = typeof textarea.selectionEnd === 'number'
    ? textarea.selectionEnd
    : start;

  if (typeof textarea.setRangeText === 'function') {
    textarea.setRangeText('\n', start, end, 'end');
  }

  if (currentValue !== null && textarea.value === currentValue) {
    const nextValue = currentValue.slice(0, start) + '\n' + currentValue.slice(end);
    setAiStudioTextareaValue(textarea, nextValue);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
  }

  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function handleEnterSwap(event) {
  if (
    !event ||
    !event.isTrusted ||
    (event.code !== 'Enter' && event.code !== 'NumpadEnter' && event.key !== 'Enter') ||
    event.isComposing ||
    event.keyCode === 229 ||
    !enterKeyConfig?.enabled
  ) {
    return;
  }

  const input = document.activeElement;
  if (!isAiStudioInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertAiStudioNewline(input);
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();

    const sendButton = findAiStudioSendButton();
    if (sendButton) {
      sendButton.click();
    }
    return;
  }

  // Block any unconfigured Enter modifier combinations (such as AI Studio's
  // native Ctrl+Enter/Cmd+Enter submit in .ctrl-enter-submits mode, plain Enter
  // submit in non-.ctrl-enter-submits mode, or Alt+Enter stage/append).
  event.preventDefault();
  event.stopImmediatePropagation();
}

applyEnterSwapSetting();
