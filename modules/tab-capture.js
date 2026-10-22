// Captures the pixels of the current tab, cross-origin provider iframes
// included. chrome.tabs.captureVisibleTab is silent but needs the activeTab
// grant, which Chrome gives when the user invokes the extension on this page
// (toolbar icon, its shortcut or the context menu). Without that grant the
// Screen Capture API is used instead, and Chrome asks the user to confirm
// sharing this tab. That stream is kept for later snapshots, paused between
// them, until the user stops sharing or the page goes away. Frames never
// leave the page.

import { getCaptureCrop } from './share-snapshot.js';

export const TAB_CAPTURE_ERRORS = Object.freeze({
  CANCELLED: 'capture-cancelled',
  ENDED: 'capture-ended',
  UNSUPPORTED: 'capture-unsupported',
  WRONG_SURFACE: 'capture-wrong-surface',
  PERMISSION: 'capture-permission',
  NO_FRAME: 'capture-no-frame',
  TAB_HIDDEN: 'capture-tab-hidden'
});

export const TAB_CAPTURE_KINDS = Object.freeze({
  VISIBLE_TAB: 'visible-tab',
  DISPLAY_MEDIA: 'display-media'
});

/** chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. */
export const MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2;

/** Spacing between captureVisibleTab calls, with a margin over the quota. */
export const VISIBLE_TAB_CAPTURE_INTERVAL_MS = Math.ceil(1000 / MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND) + 50;

const VISIBLE_TAB_QUOTA_RETRIES = 3;

export class TabCaptureError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TabCaptureError';
    this.code = code;
  }
}

/** Frames to wait after the stream starts, so the "sharing this tab" bar settles. */
const SETTLE_FRAMES = 2;

/** Upper bound for one frame callback; capture streams can idle on static pages. */
const FRAME_WAIT_TIMEOUT_MS = 500;

/** Tries to get a frame taken after a grab() was asked for. */
const FRESH_FRAME_ATTEMPTS = 4;

/** Frame rate of a kept stream between snapshots, to keep it nearly free. */
export const IDLE_CAPTURE_FRAME_RATE = 1;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when captureVisibleTab failed because this tab has no activeTab grant. */
export function isCapturePermissionError(error) {
  const message = String(error?.message || error || '');
  return /'<all_urls>' or 'activeTab' permission/i.test(message)
    || /permission is required/i.test(message)
    || /cannot access contents of/i.test(message);
}

/** True when captureVisibleTab was called more often than Chrome allows. */
export function isCaptureQuotaError(error) {
  return /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(String(error?.message || error || ''));
}

/**
 * Spaces out calls: wait() resolves once `intervalMs` has passed since the
 * previous call started.
 * @param {number} intervalMs
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.wait]
 */
export function createCallThrottle(intervalMs, { now = () => Date.now(), wait = sleep } = {}) {
  let last = -Infinity;
  return {
    async wait() {
      const delay = last + intervalMs - now();
      if (delay > 0) {
        await wait(delay);
      }
      last = now();
    },
    /** Pushes the next call out, e.g. after Chrome reported the quota. */
    defer() {
      last = now();
    }
  };
}

// Shared by every capture in this page: the quota is per extension.
const visibleTabThrottle = createCallThrottle(VISIBLE_TAB_CAPTURE_INTERVAL_MS);

/**
 * Decodes a data: URL without fetch, which extension pages may restrict.
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl));
  if (!match) {
    throw new Error('Capture did not return an image');
  }
  const [, type = 'application/octet-stream', base64, data] = match;
  if (!base64) {
    return new Blob([decodeURIComponent(data)], { type });
  }
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type });
}

/**
 * Silent capture through chrome.tabs.captureVisibleTab. That takes whatever
 * tab is in front of the window, so each frame is only kept when this tab
 * was in front from before it was taken until after: switching tabs midway
 * would put another tab's pixels under this comparison's title.
 * @param {object} options
 * @param {number} [options.windowId] - Window showing this page, when tabId is unknown.
 * @param {number | null} [options.tabId] - This page's tab.
 * @param {typeof chrome.tabs} [options.tabs]
 * @param {ReturnType<typeof createCallThrottle>} [options.throttle]
 * @param {(blob: Blob) => Promise<ImageBitmap>} [options.decode]
 * @param {Document} [options.doc] - This page, which is hidden while another tab is in front.
 */
export function createVisibleTabSource({
  windowId,
  tabId = null,
  tabs = globalThis.chrome?.tabs,
  throttle = visibleTabThrottle,
  decode = (blob) => createImageBitmap(blob),
  doc = globalThis.document
} = {}) {
  if (typeof tabs?.captureVisibleTab !== 'function') {
    throw new TabCaptureError(TAB_CAPTURE_ERRORS.UNSUPPORTED, 'Tab capture is not available');
  }
  // Counts the times the page was hidden, so a switch away and back is seen too.
  let hidings = 0;
  const onVisibilityChange = () => {
    if (doc.visibilityState === 'hidden') {
      hidings += 1;
    }
  };
  doc?.addEventListener?.('visibilitychange', onVisibilityChange);
  const tabHidden = () => new TabCaptureError(TAB_CAPTURE_ERRORS.TAB_HIDDEN, 'This tab is not in front');
  /** Window to capture: the one this tab is in front of. */
  const findShowingWindow = async () => {
    if (doc?.visibilityState === 'hidden') {
      throw tabHidden();
    }
    if (tabId === null || typeof tabs.get !== 'function') {
      return windowId ?? null;
    }
    const tab = await tabs.get(tabId);
    if (!tab?.active) {
      throw tabHidden();
    }
    return tab.windowId;
  };
  return {
    kind: TAB_CAPTURE_KINDS.VISIBLE_TAB,
    async grab() {
      for (let attempt = 0; ; attempt += 1) {
        await throttle.wait();
        try {
          const hidingsBefore = hidings;
          const showingWindow = await findShowingWindow();
          const dataUrl = await tabs.captureVisibleTab(showingWindow, { format: 'png' });
          if (hidings !== hidingsBefore || await findShowingWindow() !== showingWindow) {
            throw tabHidden();
          }
          return await decode(dataUrlToBlob(dataUrl));
        } catch (error) {
          if (error instanceof TabCaptureError) {
            throw error;
          }
          if (isCapturePermissionError(error)) {
            throw new TabCaptureError(TAB_CAPTURE_ERRORS.PERMISSION, 'This tab has no capture grant', { cause: error });
          }
          if (!isCaptureQuotaError(error) || attempt >= VISIBLE_TAB_QUOTA_RETRIES) {
            throw error;
          }
          throttle.defer();
        }
      }
    },
    close() {
      doc?.removeEventListener?.('visibilitychange', onVisibilityChange);
    }
  };
}

function waitForVideoFrame(video, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_TIMEOUT_MS);
    video.requestVideoFrameCallback(() => {
      clearTimeout(timer);
      resolve();
    });
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Resolves with the capture time of the first frame taken at or after
 * `since`, or null when none comes in time. Frames already on their way can
 * be older than the page now is, so they are skipped. Without capture times
 * the next frame is taken as it is.
 */
function waitForVideoFrameSince(video, since) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(null), FRAME_WAIT_TIMEOUT_MS);
    const onFrame = (now, metadata) => {
      const capturedAt = metadata?.captureTime ?? now;
      if (typeof metadata?.captureTime !== 'number' || capturedAt >= since) {
        finish(capturedAt);
      } else if (!settled) {
        video.requestVideoFrameCallback(onFrame);
      }
    };
    video.requestVideoFrameCallback(onFrame);
  });
}

/**
 * A pixel in the corner of the page, nearly transparent, whose shade flips
 * on every grab. Tab capture sends a frame only when the page changes, so a
 * page that already painted its latest scroll would send nothing new and an
 * older frame could be taken instead; the flip makes Chrome send one.
 */
function createFrameTrigger() {
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.cssText = [
    'position: fixed', 'left: 0', 'bottom: 0', 'width: 1px', 'height: 1px',
    'pointer-events: none', 'z-index: 2147483647'
  ].join(';');
  let shade = false;
  return {
    pull() {
      if (!element.isConnected) {
        document.documentElement.appendChild(element);
      }
      shade = !shade;
      element.style.backgroundColor = shade ? 'rgba(0, 0, 0, 0.02)' : 'rgba(0, 0, 0, 0.01)';
    },
    remove() {
      element.remove();
    }
  };
}

function createCaptureHandle() {
  return `panelize-snapshot-${crypto.randomUUID()}`;
}

/**
 * Confirms the stream shows this tab. Chrome's "share this tab" dialog can
 * still switch to another surface; cropping that by our layout would produce
 * a wrong image.
 */
function assertCapturedThisTab(track, handle) {
  const settings = track.getSettings?.() || {};
  if (settings.displaySurface && settings.displaySurface !== 'browser') {
    throw new TabCaptureError(TAB_CAPTURE_ERRORS.WRONG_SURFACE, 'Another screen surface was shared');
  }
  if (handle && typeof track.getCaptureHandle === 'function') {
    const captured = track.getCaptureHandle();
    if (captured?.handle !== handle) {
      throw new TabCaptureError(TAB_CAPTURE_ERRORS.WRONG_SURFACE, 'Another tab was shared');
    }
  }
}

/**
 * At most the tab's size in device pixels. A larger frame makes Chrome raise
 * the device scale of the captured page to fill it, and reset and re-apply
 * that scale whenever the constraints change: the panels then lay out at
 * another size for a moment, which moves virtual lists such as DeepSeek's.
 */
function getTabCaptureSize() {
  const scale = window.devicePixelRatio || 1;
  return {
    width: { max: Math.round(window.innerWidth * scale) },
    height: { max: Math.round(window.innerHeight * scale) }
  };
}

/**
 * Sets the frame rate, with the tab's current size: constraints are
 * replaced as a whole, and the tab may have been resized meanwhile.
 */
function setCaptureFrameRate(track, frameRate) {
  if (!frameRate || typeof track.applyConstraints !== 'function') {
    return Promise.resolve();
  }
  return track.applyConstraints({ ...getTabCaptureSize(), frameRate }).catch((error) => {
    console.warn('[TabCapture] Could not change the capture frame rate:', error);
  });
}

/**
 * Capture through the Screen Capture API. The stream outlives a run, so
 * later snapshots do not ask again: start() before a run plays it at full
 * rate, stop() after it pauses it at IDLE_CAPTURE_FRAME_RATE, close() ends
 * it. Sharing can also end from Chrome's own "Stop sharing" bar.
 * @param {object} [options]
 * @param {() => void} [options.onEnded] - Sharing ended, whoever stopped it.
 * @returns {Promise<{kind: string, isActive: () => boolean, start: () => Promise<void>,
 *   grab: () => Promise<ImageBitmap>, stop: () => Promise<void>, close: () => void}>}
 */
export async function createDisplayMediaSource({ onEnded = () => {} } = {}) {
  const mediaDevices = navigator.mediaDevices;
  if (typeof mediaDevices?.getDisplayMedia !== 'function') {
    throw new TabCaptureError(TAB_CAPTURE_ERRORS.UNSUPPORTED, 'Screen capture is not available');
  }

  // A capture handle lets the stream prove it shows this very tab.
  let handle = null;
  if (typeof mediaDevices.setCaptureHandleConfig === 'function') {
    handle = createCaptureHandle();
    mediaDevices.setCaptureHandleConfig({
      handle,
      exposeOrigin: false,
      permittedOrigins: [window.location.origin]
    });
  }

  let stream;
  try {
    stream = await mediaDevices.getDisplayMedia({
      // The pointer would be drawn over the panels. Chrome ignores this for
      // tabs ("motion"), so the page also hides it while capturing.
      video: { displaySurface: 'browser', cursor: 'never', ...getTabCaptureSize() },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      monitorTypeSurfaces: 'exclude'
    });
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
      throw new TabCaptureError(TAB_CAPTURE_ERRORS.CANCELLED, 'Screen capture was cancelled', { cause: error });
    }
    throw error;
  }

  const [track] = stream.getVideoTracks();
  const video = document.createElement('video');
  const frameTrigger = createFrameTrigger();
  const activeFrameRate = track.getSettings?.().frameRate;
  let ended = false;
  const end = () => {
    if (ended) {
      return;
    }
    ended = true;
    stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    video.pause();
    video.srcObject = null;
    frameTrigger.remove();
    onEnded();
  };
  // Chrome's "Stop sharing" ends the track without calling close().
  track.addEventListener('ended', end, { once: true });
  const isActive = () => !ended && track.readyState === 'live';
  const assertActive = () => {
    if (!isActive()) {
      throw new TabCaptureError(TAB_CAPTURE_ERRORS.ENDED, 'Tab sharing has ended');
    }
    // Checked on every use: the shared surface must still be this tab.
    assertCapturedThisTab(track, handle);
  };
  const waitForFreshFrames = async () => {
    for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
      await waitForVideoFrame(video);
    }
  };

  try {
    assertCapturedThisTab(track, handle);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    await waitForFreshFrames();
  } catch (error) {
    end();
    throw error;
  }

  return {
    kind: TAB_CAPTURE_KINDS.DISPLAY_MEDIA,
    isActive,
    async start() {
      assertActive();
      await setCaptureFrameRate(track, activeFrameRate);
      await video.play();
      await waitForFreshFrames();
    },
    async grab() {
      assertActive();
      // Only a frame taken after this call shows what the page has painted
      // by now; the trigger makes Chrome take one. The bitmap takes the
      // video's current size, so a resized tab is measured again each time.
      for (let attempt = 0; attempt < FRESH_FRAME_ATTEMPTS; attempt += 1) {
        const since = performance.now();
        frameTrigger.pull();
        if (await waitForVideoFrameSince(video, since) !== null) {
          assertActive();
          return createImageBitmap(video);
        }
      }
      throw new TabCaptureError(TAB_CAPTURE_ERRORS.NO_FRAME, 'Tab sharing sent no new frame');
    },
    async stop() {
      if (!isActive()) {
        return;
      }
      video.pause();
      await setCaptureFrameRate(track, IDLE_CAPTURE_FRAME_RATE);
    },
    close: end
  };
}

/**
 * Opens a capture source for this tab, silent when Chrome allows it.
 * Call it straight from the user's click: the fallback needs the click's
 * user activation to show Chrome's share dialog.
 * @param {object} [options]
 * @param {number} [options.windowId]
 * @param {number | null} [options.tabId] - This page's tab, which silent capture is bound to.
 * @param {boolean} [options.preferVisibleTab]
 * @param {object | null} [options.keptSource] - A display media source from
 *   an earlier snapshot, used instead of asking again while it is active.
 * @param {() => void} [options.onEnded] - For a new display media source.
 * @returns {Promise<{source: object, fallbackReason: string | null, reused: boolean}>}
 *   fallbackReason is TAB_CAPTURE_ERRORS.PERMISSION when this tab has no
 *   activeTab grant, or UNSUPPORTED without the tabs API. Rejects with
 *   TAB_HIDDEN when another tab is in front.
 */
export async function openTabCaptureSource({
  windowId,
  tabId = null,
  preferVisibleTab = true,
  keptSource = null,
  onEnded
} = {}) {
  let fallbackReason = null;
  if (preferVisibleTab) {
    let source = null;
    try {
      source = createVisibleTabSource({ windowId, tabId });
      // Probe once: the grant can only be learned by trying.
      const probe = await source.grab();
      probe.close?.();
      return { source, fallbackReason, reused: false };
    } catch (error) {
      source?.close();
      // Sharing would not help while another tab is in front.
      if (!(error instanceof TabCaptureError) || error.code === TAB_CAPTURE_ERRORS.TAB_HIDDEN) {
        throw error;
      }
      fallbackReason = error.code;
    }
  }
  if (keptSource?.isActive()) {
    return { source: keptSource, fallbackReason, reused: true };
  }
  return { source: await createDisplayMediaSource({ onEnded }), fallbackReason, reused: false };
}

/**
 * Crops a captured frame to `rect` of the viewport.
 * @param {ImageBitmap} frame - Whole-tab frame.
 * @param {{left: number, top: number, width: number, height: number}} rect - CSS pixels.
 * @param {object} [options]
 * @param {number} [options.maxWidth] - Output width cap in pixels.
 * @returns {Promise<{bitmap: ImageBitmap, scale: number}>}
 */
export async function cropCapturedFrame(frame, rect, { maxWidth } = {}) {
  const crop = getCaptureCrop({
    frameWidth: frame.width,
    frameHeight: frame.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    rect,
    maxWidth
  });
  const bitmap = await createImageBitmap(frame, crop.sx, crop.sy, crop.sw, crop.sh, {
    resizeWidth: crop.width,
    resizeHeight: crop.height,
    resizeQuality: 'high'
  });
  return { bitmap, scale: crop.scale };
}
