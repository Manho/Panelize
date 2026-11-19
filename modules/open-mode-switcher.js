/**
 * In-place open-mode switching between a normal browser tab and a standalone
 * popup window. Moves the existing tab across windows so the Multi-Panel page
 * and all embedded provider iframes keep their live state without reloading.
 */

export const DEFAULT_POPUP_WIDTH = 1400;
export const DEFAULT_POPUP_HEIGHT = 900;
export const PRESERVED_STATE_KEY = 'preservedState';
export const HANDOFF_QUERY_PARAM = 'openModeHandoff';

const TRANSIENT_TAB_EDIT_ERROR_PATTERN = /tabs cannot be edited right now/i;
const DEFAULT_TRANSIENT_MAX_RETRIES = 4;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 60;

/**
 * Thrown only when the host environment lacks the tab/window APIs required for
 * in-place tab adoption (indicating a legacy recreate fallback is needed).
 */
export class OpenModeSwitchUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OpenModeSwitchUnsupportedError';
  }
}

/**
 * Returns true when Chrome rejected a tab/window mutation because the tab strip
 * is momentarily locked (for example, while the user is dragging a tab).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isTransientTabEditError(error) {
  const message = typeof error === 'string' ? error : error?.message;
  return typeof message === 'string' && TRANSIENT_TAB_EDIT_ERROR_PATTERN.test(message);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries a Chrome tab/window mutation on transient tab-strip-busy errors.
 *
 * @template T
 * @param {() => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<T>}
 */
export async function retryOnTransientTabEditError(
  operation,
  {
    maxRetries = DEFAULT_TRANSIENT_MAX_RETRIES,
    retryDelayMs = DEFAULT_TRANSIENT_RETRY_DELAY_MS,
    sleep = defaultSleep
  } = {}
) {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientTabEditError(error) || attempt >= maxRetries) {
        throw error;
      }
      attempt += 1;
      await sleep(retryDelayMs);
    }
  }
}

export function createHandoffStorageKey(token) {
  return `${PRESERVED_STATE_KEY}:${token}`;
}

export function generateHandoffToken() {
  if (typeof globalThis?.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getHandoffTokenFromUrl(urlString) {
  if (!urlString) {
    return null;
  }
  try {
    const token = new URL(urlString).searchParams.get(HANDOFF_QUERY_PARAM);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

export function stripHandoffTokenFromUrl(urlString) {
  if (!urlString) {
    return null;
  }
  try {
    const parsed = new URL(urlString);
    if (!parsed.searchParams.has(HANDOFF_QUERY_PARAM)) {
      return null;
    }
    parsed.searchParams.delete(HANDOFF_QUERY_PARAM);
    return parsed.toString();
  } catch {
    return null;
  }
}

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
 * @param {number} [options.maxRetries]
 * @param {number} [options.retryDelayMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
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
    popupHeight = DEFAULT_POPUP_HEIGHT,
    maxRetries = DEFAULT_TRANSIENT_MAX_RETRIES,
    retryDelayMs = DEFAULT_TRANSIENT_RETRY_DELAY_MS,
    sleep = defaultSleep
  } = {}
) {
  if (
    typeof chromeApi?.windows?.getCurrent !== 'function' ||
    typeof chromeApi?.tabs?.getCurrent !== 'function' ||
    typeof chromeApi?.windows?.create !== 'function'
  ) {
    throw new OpenModeSwitchUnsupportedError('Required chrome.windows/tabs APIs are unavailable');
  }

  const [currentWindow, currentTab] = await Promise.all([
    chromeApi.windows.getCurrent(),
    chromeApi.tabs.getCurrent()
  ]);

  if (!currentWindow || currentTab?.id == null) {
    throw new OpenModeSwitchUnsupportedError('Unable to resolve current tab or window');
  }

  const retryOptions = { maxRetries, retryDelayMs, sleep };
  const wasPopup = currentWindow.type === 'popup';

  if (!wasPopup) {
    const previousNormalWindowId = currentWindow.id ?? currentTab.windowId ?? null;
    const popupWindow = await retryOnTransientTabEditError(
      () =>
        chromeApi.windows.create({
          tabId: currentTab.id,
          type: 'popup',
          width: popupWidth,
          height: popupHeight,
          focused: true
        }),
      retryOptions
    );

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
      await retryOnTransientTabEditError(
        () =>
          chromeApi.tabs.move(currentTab.id, {
            windowId: targetWindow.id,
            index: -1
          }),
        retryOptions
      );
      moved = true;
    } catch (moveError) {
      if (isTransientTabEditError(moveError)) {
        throw moveError;
      }
      // Target window may have closed concurrently or refused cross-type move;
      // fall through to creating a new normal window adopting the existing tab.
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

  const normalWindow = await retryOnTransientTabEditError(
    () =>
      chromeApi.windows.create({
        tabId: currentTab.id,
        type: 'normal',
        focused: true
      }),
    retryOptions
  );

  return {
    mode: 'tab',
    isPopupWindow: false,
    windowId: normalWindow?.id ?? null,
    tabId: currentTab.id,
    previousNormalWindowId: normalWindow?.id ?? null
  };
}
