// Qwen China Enter/Shift+Enter behavior swap
// Depends on enter-behavior-utils.js and button-finder-utils.js.

const QWEN_CN_SEND_BUTTON_SELECTORS = [
  {
    type: 'css',
    value: '[data-chat-input-layout="true"] button[aria-label="发送消息"]'
  }
];

function isQwenChinaInput(element) {
  return Boolean(
    element &&
    element.tagName === 'DIV' &&
    element.getAttribute('data-slate-editor') === 'true' &&
    element.getAttribute('contenteditable') === 'true' &&
    element.getAttribute('role') === 'textbox' &&
    element.offsetParent !== null &&
    element.closest('[data-chat-input-body="true"]')
  );
}

function insertQwenChinaNewline(editor) {
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

function dispatchQwenChinaEnter(editor, shiftKey = false) {
  editor.dispatchEvent(new KeyboardEvent('keydown', {
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
  if (!isQwenChinaInput(input)) {
    return;
  }

  if (matchesModifiers(event, enterKeyConfig.newlineModifiers)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    insertQwenChinaNewline(input);
    return;
  }

  if (!matchesModifiers(event, enterKeyConfig.sendModifiers)) {
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();

  const sendButton = window.ButtonFinderUtils?.findButton(QWEN_CN_SEND_BUTTON_SELECTORS);
  if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
    sendButton.click();
    return;
  }

  dispatchQwenChinaEnter(input);
}

applyEnterSwapSetting();
