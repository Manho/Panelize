// Captures the pixels of the current tab, cross-origin provider iframes
// included. chrome.tabs.captureVisibleTab is silent but needs the activeTab
// grant, which Chrome gives when the user invokes the extension on this page
// (toolbar icon, its shortcut or the context menu). Without that grant the
// Screen Capture API is used instead, and Chrome asks the user to confirm
// sharing this tab. Frames never leave the page.

import { getCaptureCrop } from './share-snapshot.js';

export const TAB_CAPTURE_ERRORS = Object.freeze({
  CANCELLED: 'capture-cancelled',
  UNSUPPORTED: 'capture-unsupported',
  WRONG_SURFACE: 'capture-wrong-surface',
  PERMISSION: 'capture-permission'
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
 * Silent capture through chrome.tabs.captureVisibleTab.
 * @param {object} options
 * @param {number} [options.windowId] - Window showing this page.
 * @param {typeof chrome.tabs} [options.tabs]
 * @param {ReturnType<typeof createCallThrottle>} [options.throttle]
 * @param {(blob: Blob) => Promise<ImageBitmap>} [options.decode]
 */
export function createVisibleTabSource({
  windowId,
  tabs = globalThis.chrome?.tabs,
  throttle = visibleTabThrottle,
  decode = (blob) => createImageBitmap(blob)
} = {}) {
  if (typeof tabs?.captureVisibleTab !== 'function') {
    throw new TabCaptureError(TAB_CAPTURE_ERRORS.UNSUPPORTED, 'Tab capture is not available');
  }
  return {
    kind: TAB_CAPTURE_KINDS.VISIBLE_TAB,
    async grab() {
      for (let attempt = 0; ; attempt += 1) {
        await throttle.wait();
        try {
          const dataUrl = await tabs.captureVisibleTab(windowId ?? null, { format: 'png' });
          return await decode(dataUrlToBlob(dataUrl));
        } catch (error) {
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
    close() {}
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
 * Capture through the Screen Capture API. One stream serves every frame of
 * a run; close() stops it.
 * @returns {Promise<{kind: string, grab: () => Promise<ImageBitmap>, close: () => void}>}
 */
export async function createDisplayMediaSource() {
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
      video: { displaySurface: 'browser' },
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

  const video = document.createElement('video');
  const close = () => {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  try {
    const [track] = stream.getVideoTracks();
    assertCapturedThisTab(track, handle);
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
      await waitForVideoFrame(video);
    }
  } catch (error) {
    close();
    throw error;
  }

  return {
    kind: TAB_CAPTURE_KINDS.DISPLAY_MEDIA,
    async grab() {
      // A frame rendered after the latest scroll; a static page may not
      // produce one, and then the current frame is still up to date.
      for (let frame = 0; frame < SETTLE_FRAMES; frame += 1) {
        await waitForVideoFrame(video);
      }
      return createImageBitmap(video);
    },
    close
  };
}

/**
 * Opens a capture source for this tab, silent when Chrome allows it.
 * Call it straight from the user's click: the fallback needs the click's
 * user activation to show Chrome's share dialog.
 * @param {object} [options]
 * @param {number} [options.windowId]
 * @param {boolean} [options.preferVisibleTab]
 * @returns {Promise<{source: object, fallbackReason: string | null}>}
 *   fallbackReason is TAB_CAPTURE_ERRORS.PERMISSION when this tab has no
 *   activeTab grant, or UNSUPPORTED without the tabs API.
 */
export async function openTabCaptureSource({ windowId, preferVisibleTab = true } = {}) {
  let fallbackReason = null;
  if (preferVisibleTab) {
    try {
      const source = createVisibleTabSource({ windowId });
      // Probe once: the grant can only be learned by trying.
      const probe = await source.grab();
      probe.close?.();
      return { source, fallbackReason };
    } catch (error) {
      if (!(error instanceof TabCaptureError)) {
        throw error;
      }
      fallbackReason = error.code;
    }
  }
  return { source: await createDisplayMediaSource(), fallbackReason };
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
