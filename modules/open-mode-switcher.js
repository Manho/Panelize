/**
 * In-place open-mode switching between a normal browser tab and a standalone
 * popup window. Moves the existing tab across windows so the Multi-Panel page
 * and all embedded provider iframes keep their live state without reloading.
 */

export const DEFAULT_POPUP_WIDTH = 1400;
export const DEFAULT_POPUP_HEIGHT = 900;

/**
 * Finds the best existing normal browser window that can accept the tab when
 * returning from popup mode to tab mode.
 *
 * @param {typeof chrome} chromeApi
 * @param {object} [options]
 * @param {number|null} [options.preferredWindowId] - Normal window the tab originally came from.
 * @param {boolean} [options.incognito] - Required incognito profile match.
 * @returns {Promise<chrome.windows.Window|null>}
 */
export async function findTargetNormalWindow(
  chromeApi,
  { preferredWindowId = null, incognito = undefined } = {}
) {
  if (typeof chromeApi?.windows?.getAll !== 'function') {
    return null;
  }

  const normalWindows = await chromeApi.windows.getAll({ windowTypes: ['normal'] });
  const candidates = (Array.isArray(normalWindows) ? normalWindows : []).filter(
    (win) =>
      win &&
      win.id != null &&
      (typeof incognito !== 'boolean' || Boolean(win.incognito) === incognito)
  );

  if (candidates.length === 0) {
    return null;
  }

  if (preferredWindowId != null) {
    const preferred = candidates.find((win) => win.id === preferredWindowId);
    if (preferred) {
      return preferred;
    }
  }

  if (typeof chromeApi?.windows?.getLastFocused === 'function') {
    try {
      const lastFocused = await chromeApi.windows.getLastFocused({ windowTypes: ['normal'] });
      if (lastFocused?.id != null) {
        const matched = candidates.find((win) => win.id === lastFocused.id);
        if (matched) {
          return matched;
        }
      }
    } catch {
      // Ignore if Chrome has no focused normal window matching the filter.
    }
  }

  return candidates.find((win) => win.state !== 'minimized') || candidates[0];
}

/**
 * Moves the current extension tab in-place between a normal browser window and
 * a standalone popup window without reloading the document or its iframes.
 *
 * @param {typeof chrome} chromeApi
 * @param {object} [options]
 * @param {number|null} [options.preferredNormalWindowId] - Normal window to prefer when returning to tab mode.
 * @param {number} [options.popupWidth]
 * @param {number} [options.popupHeight]
 * @returns {Promise<{
 *   mode: 'tab'|'popup',
 *   isPopupWindow: boolean,
 *   windowId: number|null,
 *   tabId: number,
 *   previousNormalWindowId: number|null
 * }>}
 */
export async function switchTabOpenMode(
  chromeApi,
  {
    preferredNormalWindowId = null,
    popupWidth = DEFAULT_POPUP_WIDTH,
    popupHeight = DEFAULT_POPUP_HEIGHT
  } = {}
) {
  if (
    typeof chromeApi?.windows?.getCurrent !== 'function' ||
    typeof chromeApi?.tabs?.getCurrent !== 'function' ||
    typeof chromeApi?.windows?.create !== 'function'
  ) {
    throw new Error('Required chrome.windows/tabs APIs are unavailable');
  }

  const [currentWindow, currentTab] = await Promise.all([
    chromeApi.windows.getCurrent(),
    chromeApi.tabs.getCurrent()
  ]);

  if (!currentWindow || currentTab?.id == null) {
    throw new Error('Unable to resolve current tab or window');
  }

  const wasPopup = currentWindow.type === 'popup';

  if (!wasPopup) {
    const previousNormalWindowId = currentWindow.id ?? currentTab.windowId ?? null;
    const popupWindow = await chromeApi.windows.create({
      tabId: currentTab.id,
      type: 'popup',
      width: popupWidth,
      height: popupHeight,
      focused: true
    });

    return {
      mode: 'popup',
      isPopupWindow: true,
      windowId: popupWindow?.id ?? null,
      tabId: currentTab.id,
      previousNormalWindowId
    };
  }

  const targetWindow = await findTargetNormalWindow(chromeApi, {
    preferredWindowId: preferredNormalWindowId,
    incognito: currentWindow.incognito
  });

  if (targetWindow && typeof chromeApi?.tabs?.move === 'function') {
    let moved = false;
    try {
      await chromeApi.tabs.move(currentTab.id, {
        windowId: targetWindow.id,
        index: -1
      });
      moved = true;
    } catch {
      // Fall through to creating a new normal window adopting the existing tab.
    }

    if (moved) {
      if (typeof chromeApi?.tabs?.update === 'function') {
        try {
          await chromeApi.tabs.update(currentTab.id, { active: true });
        } catch {
          // Best-effort activation after the tab has already moved.
        }
      }
      if (typeof chromeApi?.windows?.update === 'function') {
        try {
          const updateInfo = targetWindow.state === 'minimized'
            ? { state: 'normal', focused: true }
            : { focused: true };
          await chromeApi.windows.update(targetWindow.id, updateInfo);
        } catch {
          // Best-effort focus after the tab has already moved.
        }
      }

      return {
        mode: 'tab',
        isPopupWindow: false,
        windowId: targetWindow.id,
        tabId: currentTab.id,
        previousNormalWindowId: targetWindow.id
      };
    }
  }

  const normalWindow = await chromeApi.windows.create({
    tabId: currentTab.id,
    type: 'normal',
    focused: true
  });

  return {
    mode: 'tab',
    isPopupWindow: false,
    windowId: normalWindow?.id ?? null,
    tabId: currentTab.id,
    previousNormalWindowId: normalWindow?.id ?? null
  };
}
