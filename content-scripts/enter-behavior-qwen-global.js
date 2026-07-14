// Qwen Global Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const QWEN_GLOBAL_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: '#message-input-container .chat-prompt-send-button button.send-button'
  },
  {
    type: 'css',
    value: '.message-input-container .chat-prompt-send-button button.send-button'
  }
];

function isQwenGlobalInput(element) {
  return Boolean(
    element &&
    element.tagName === 'TEXTAREA' &&
    element.offsetParent !== null &&
    element.classList.contains('message-input-textarea')
  );
}

function insertQwenGlobalNewline(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function dispatchQwenGlobalEnter(textarea, shiftKey = false) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    shiftKey,
    bubbles: true,
    cancelable: true
  }));
}

function handleEnterSwap(event) {
  if (!event.isTrusted || event.code !== 'Enter' || event.isComposing || !enterKeyConfig?.enabled) {
    return;
  }

  const input = document.activeElement;
  if (!isQwenGlobalInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertQwenGlobalNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(QWEN_GLOBAL_SEND_BUTTON_SELECTORS);
  if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
    sendButton.click();
    return;
  }

  dispatchQwenGlobalEnter(input);
}

applyEnterSwapSetting();
