// Sends window messages to a provider content script the way the
// Multi-Panel page does: from the embedding window, on the extension origin.

/** Origin of the extension pages under the mocked chrome.runtime.getURL. */
export const EXTENSION_ORIGIN = chrome.runtime.getURL('').replace(/\/+$/, '');

/**
 * The content script only trusts its parent window. Tests that never stub
 * `window.parent` get a stand-in, as if the page were a panel frame.
 * @returns {object} The parent window messages appear to come from.
 */
export function ensureMultiPanelParent() {
  if (window.parent === window) {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: { postMessage: () => {} },
    });
  }
  return window.parent;
}

/**
 * @param {object} data - Message payload.
 * @param {object} [sender] - Overrides to simulate another sender.
 * @param {unknown} [sender.source] - Defaults to the embedding window.
 * @param {string} [sender.origin] - Defaults to the extension origin.
 */
export function dispatchMultiPanelMessage(data, sender = {}) {
  const source = Object.prototype.hasOwnProperty.call(sender, 'source')
    ? sender.source
    : ensureMultiPanelParent();
  const origin = Object.prototype.hasOwnProperty.call(sender, 'origin')
    ? sender.origin
    : EXTENSION_ORIGIN;
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
}
