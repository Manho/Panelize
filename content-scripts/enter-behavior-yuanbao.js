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
  return window.ButtonFinderUtils?.isYuanbaoSendControl(sendButton) === true;
}

function insertYuanbaoNewline(editor) {
  editor.focus();

  for (const command of ['insertParagraph', 'insertLineBreak']) {
    try {
      if (document.execCommand(command, false)) {
        return;
      }
    } catch (error) {
      // Try the other native editing command.
    }
  }

  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    return;
  }
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const lineBreak = document.createElement('br');
  range.insertNode(lineBreak);
  range.setStartAfter(lineBreak);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
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
