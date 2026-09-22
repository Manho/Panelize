// MiMo Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const MIMO_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: 'button[data-track-id="home_send_btn"]'
  }
];

function isMimoInput(element) {
  return Boolean(
    element &&
    element.tagName === 'TEXTAREA' &&
    element.offsetParent !== null &&
    element.closest('div[class*="rounded-2xl"]')
  );
}

function insertMimoNewline(textarea) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));
}

function handleEnterSwap(event) {
  if (!event.isTrusted || event.code !== 'Enter' || event.isComposing || !enterKeyConfig?.enabled) {
    return;
  }

  const input = document.activeElement;
  if (!isMimoInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertMimoNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(MIMO_SEND_BUTTON_SELECTORS);
  if (
    sendButton &&
    !sendButton.disabled &&
    sendButton.getAttribute('aria-disabled') !== 'true' &&
    sendButton.getAttribute('data-state') !== 'open'
  ) {
    sendButton.click();
  }
}

applyEnterSwapSetting();
