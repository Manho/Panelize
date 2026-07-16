// Z.ai Global Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const ZAI_GLOBAL_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: 'button.sendMessageButton'
  }
];

function isZaiGlobalInput(element) {
  return Boolean(
    element &&
    element.tagName === 'TEXTAREA' &&
    element.offsetParent !== null &&
    (
      element.placeholder === 'How can I help you today?' ||
      element.classList.contains('input-scroll')
    )
  );
}

function insertZaiGlobalNewline(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function dispatchZaiGlobalEnter(textarea) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true
  }));
}

function handleEnterSwap(event) {
  if (!event.isTrusted || event.code !== 'Enter' || event.isComposing || !enterKeyConfig?.enabled) {
    return;
  }

  const input = document.activeElement;
  if (!isZaiGlobalInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertZaiGlobalNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(ZAI_GLOBAL_SEND_BUTTON_SELECTORS);
  if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
    sendButton.click();
    return;
  }

  dispatchZaiGlobalEnter(input);
}

applyEnterSwapSetting();
