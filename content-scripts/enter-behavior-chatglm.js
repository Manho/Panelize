// ChatGLM Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const CHATGLM_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: '#search-input-box .enter.is-main-chat .enter-icon-container'
  }
];

function isChatGLMInput(element) {
  return Boolean(
    element &&
    element.tagName === 'TEXTAREA' &&
    element.offsetParent !== null &&
    element.classList.contains('scroll-display-none') &&
    element.closest('#search-input-box')
  );
}

function insertChatGLMNewline(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function dispatchChatGLMEnter(textarea) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }));
}

function dispatchChatGLMSend(sendButton) {
  // ChatGLM submits from its mousedown handler; HTMLElement.click() skips it.
  sendButton.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    buttons: 1
  }));
}

function handleEnterSwap(event) {
  if (!event.isTrusted || event.code !== 'Enter' || event.isComposing || !enterKeyConfig?.enabled) {
    return;
  }

  const input = document.activeElement;
  if (!isChatGLMInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertChatGLMNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(CHATGLM_SEND_BUTTON_SELECTORS);
  if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
    dispatchChatGLMSend(sendButton);
    return;
  }

  dispatchChatGLMEnter(input);
}

applyEnterSwapSetting();
