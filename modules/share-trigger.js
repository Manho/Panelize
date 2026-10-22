// Invoking the extension on the Multi-Panel page itself (toolbar icon, its
// shortcut or the context menu) takes a snapshot there instead of opening
// another Panelize tab. That same gesture gives the page Chrome's activeTab
// grant, so the capture needs no confirmation dialog.

export const SHARE_SNAPSHOT_ACTION = 'shareSnapshot';

/** Command Chrome runs for the toolbar icon's keyboard shortcut. */
export const EXECUTE_ACTION_COMMAND = '_execute_action';

export const MULTI_PANEL_PAGE_PATH = 'multi-panel/multi-panel.html';

function stripQueryAndHash(url) {
  return String(url || '').split(/[?#]/)[0];
}

/**
 * True when `url` is the Multi-Panel page, whatever its query or hash.
 * @param {string | undefined} url
 * @param {string} multiPanelUrl - chrome.runtime.getURL(MULTI_PANEL_PAGE_PATH).
 */
export function isMultiPanelPageUrl(url, multiPanelUrl) {
  return Boolean(url) && stripQueryAndHash(url) === stripQueryAndHash(multiPanelUrl);
}

/**
 * Whether `tab` shows the Multi-Panel page. Falls back to the extension's own
 * contexts when Chrome leaves the tab URL out.
 * @param {chrome.tabs.Tab | undefined} tab
 * @param {typeof chrome.runtime} [runtime]
 */
export async function isMultiPanelTab(tab, runtime = globalThis.chrome?.runtime) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
    return false;
  }
  const multiPanelUrl = runtime.getURL(MULTI_PANEL_PAGE_PATH);
  const url = tab.url || tab.pendingUrl;
  if (url) {
    return isMultiPanelPageUrl(url, multiPanelUrl);
  }
  if (typeof runtime.getContexts !== 'function') {
    return false;
  }
  try {
    const contexts = await runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] });
    return contexts.some((context) => context.frameId === 0
      && isMultiPanelPageUrl(context.documentUrl, multiPanelUrl));
  } catch (error) {
    return false;
  }
}

/**
 * The shortcut bound to the toolbar icon, as Chrome shows it (e.g. "⇧⌘E" or
 * "Ctrl+Shift+E"), or '' when the user removed it.
 * @param {chrome.commands.Command[]} commands - chrome.commands.getAll() result.
 */
export function getExecuteActionShortcut(commands) {
  const command = (commands || []).find((item) => item?.name === EXECUTE_ACTION_COMMAND);
  return String(command?.shortcut || '').trim();
}
