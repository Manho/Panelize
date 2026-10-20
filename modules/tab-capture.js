// Captures the pixels of the current tab, cross-origin provider iframes
// included, through the Screen Capture API. Chrome asks the user to confirm
// sharing this tab each time, so no extension permission is needed. The stream
// is read once and stopped; the frame never leaves the page.

import { getCaptureCrop } from './share-snapshot.js';

export const TAB_CAPTURE_ERRORS = Object.freeze({
  CANCELLED: 'capture-cancelled',
  UNSUPPORTED: 'capture-unsupported',
  WRONG_SURFACE: 'capture-wrong-surface'
});

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

function waitForVideoFrame(video) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FRAME_WAIT_TIMEOUT_MS);
    video.requestVideoFrameCallback(() => {
      clearTimeout(timer);
      resolve();
    });
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
 * Captures the area of `element` currently visible in this tab.
 * @param {Element} element - Area to keep, e.g. the panel grid.
 * @param {object} [options]
 * @param {number} [options.maxWidth] - Output width cap in pixels.
 * @returns {Promise<{bitmap: ImageBitmap, scale: number}>} The cropped
 *   capture and its output pixels per CSS pixel.
 */
export async function captureElementInCurrentTab(element, { maxWidth } = {}) {
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

    const crop = getCaptureCrop({
      frameWidth: video.videoWidth,
      frameHeight: video.videoHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      rect: element.getBoundingClientRect(),
      maxWidth
    });
    const bitmap = await createImageBitmap(video, crop.sx, crop.sy, crop.sw, crop.sh, {
      resizeWidth: crop.width,
      resizeHeight: crop.height,
      resizeQuality: 'high'
    });
    return { bitmap, scale: crop.scale };
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
}
