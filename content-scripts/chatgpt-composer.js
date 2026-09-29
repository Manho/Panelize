// Shared lookup for ChatGPT's main composer, used by every ChatGPT content script.
// Loaded before the other ChatGPT scripts (see manifest.json), so they can read
// window.PanelizeChatgptComposer when they need the composer.

(function() {
  'use strict';

  // Current composer first; `#prompt-textarea` is the legacy layout, still
  // served to some accounts.
  const EDITOR_SELECTORS = Object.freeze([
    'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]',
    '#prompt-textarea'
  ]);

  function isRendered(element) {
    return element.offsetParent !== null && element.getAttribute('aria-hidden') !== 'true';
  }

  function isEditor(element) {
    return Boolean(element?.matches) && EDITOR_SELECTORS.some(selector => element.matches(selector));
  }

  // ChatGPT can keep more than one composer in the DOM (for example per
  // placement), so prefer a rendered one over whichever comes first.
  function findEditor() {
    let firstMatch = null;
    for (const selector of EDITOR_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        if (isRendered(element)) {
          return element;
        }
        firstMatch = firstMatch || element;
      }
    }
    return firstMatch;
  }

  // The form holding `editor`, where its own send button lives.
  function findForm(editor = findEditor()) {
    return editor?.closest('form') || null;
  }

  window.PanelizeChatgptComposer = Object.freeze({
    EDITOR_SELECTORS,
    isEditor,
    findEditor,
    findForm
  });
})();
