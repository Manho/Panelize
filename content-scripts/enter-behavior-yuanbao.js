// Yuanbao Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const YUANBAO_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: '#yuanbao-send-btn'
  }
];

function isYuanbaoInput(element) {
  return Boolean(
    element &&
    element.tagName === 'DIV' &&
    element.getAttribute('contenteditable') === 'true' &&
    element.classList.contains('ql-editor') &&
    element.offsetParent !== null
  );
}

function isYuanbaoSendEnabled(sendButton) {
  const className = String(sendButton?.className || '');
  return Boolean(
    sendButton &&
    sendButton.getAttribute('aria-disabled') !== 'true' &&
    !/(disabled|sendNot|loading|sending)/i.test(className)
  );
}

function insertYuanbaoNewline(editor) {
  editor.focus();

  let inserted = false;
  try {
    inserted = document.execCommand('insertLineBreak', false);
  } catch (error) {
    // Fall back to a text node when execCommand is unavailable.
  }

  if (!inserted) {
    editor.appendChild(document.createTextNode('\n'));
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

function handleEnterSwap(event) {
  if (!event.isTrusted || event.code !== 'Enter' || event.isComposing || !enterKeyConfig?.enabled) {
    return;
  }

  const input = document.activeElement;
  if (!isYuanbaoInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertYuanbaoNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(YUANBAO_SEND_BUTTON_SELECTORS);
  if (isYuanbaoSendEnabled(sendButton)) {
    sendButton.click();
  }
}

applyEnterSwapSetting();
