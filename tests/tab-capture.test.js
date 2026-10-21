import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDLE_CAPTURE_FRAME_RATE,
  MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
  TAB_CAPTURE_ERRORS,
  TAB_CAPTURE_KINDS,
  TabCaptureError,
  VISIBLE_TAB_CAPTURE_INTERVAL_MS,
  createCallThrottle,
  createDisplayMediaSource,
  createVisibleTabSource,
  dataUrlToBlob,
  isCapturePermissionError,
  isCaptureQuotaError,
  openTabCaptureSource
} from '../modules/tab-capture.js';

// Chrome's error messages; the permission one was observed in Chrome for Testing 151.
const PERMISSION_MESSAGE = "Either the '<all_urls>' or 'activeTab' permission is required.";
const QUOTA_MESSAGE = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.';

function createClock() {
  let time = 1000;
  const waits = [];
  return {
    waits,
    now: () => time,
    wait: async (ms) => {
      waits.push(ms);
      time += ms;
    },
    advance: (ms) => {
      time += ms;
    }
  };
}

describe('capture error classification', () => {
  it('recognizes the missing activeTab grant', () => {
    expect(isCapturePermissionError(new Error(PERMISSION_MESSAGE))).toBe(true);
    expect(isCapturePermissionError(new Error(QUOTA_MESSAGE))).toBe(false);
    expect(isCapturePermissionError(undefined)).toBe(false);
  });

  it('recognizes the capture quota', () => {
    expect(isCaptureQuotaError(new Error(QUOTA_MESSAGE))).toBe(true);
    expect(isCaptureQuotaError(new Error(PERMISSION_MESSAGE))).toBe(false);
  });
});

describe('createCallThrottle', () => {
  it('keeps calls under the captureVisibleTab quota', async () => {
    expect(MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).toBe(2);
    expect(VISIBLE_TAB_CAPTURE_INTERVAL_MS).toBeGreaterThan(1000 / MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND);

    const clock = createClock();
    const throttle = createCallThrottle(VISIBLE_TAB_CAPTURE_INTERVAL_MS, clock);
    await throttle.wait();
    await throttle.wait();
    clock.advance(200);
    await throttle.wait();
    expect(clock.waits).toEqual([VISIBLE_TAB_CAPTURE_INTERVAL_MS, VISIBLE_TAB_CAPTURE_INTERVAL_MS - 200]);
  });

  it('does not wait when calls are already spaced out', async () => {
    const clock = createClock();
    const throttle = createCallThrottle(500, clock);
    await throttle.wait();
    clock.advance(900);
    await throttle.wait();
    expect(clock.waits).toEqual([]);
  });
});

describe('dataUrlToBlob', () => {
  it('decodes base64 PNG data', async () => {
    const blob = dataUrlToBlob('data:image/png;base64,iVBORw0KGgo=');
    expect(blob.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('rejects anything that is not a data URL', () => {
    expect(() => dataUrlToBlob('https://example.com/x.png')).toThrow('did not return an image');
  });
});

describe('createVisibleTabSource', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const immediateThrottle = () => ({ wait: vi.fn(async () => {}), defer: vi.fn() });

  it('captures the window as PNG through the throttle', async () => {
    const tabs = { captureVisibleTab: vi.fn(async () => PNG) };
    const throttle = immediateThrottle();
    const decode = vi.fn(async (blob) => ({ width: 10, height: 10, type: blob.type }));
    const source = createVisibleTabSource({ windowId: 7, tabs, throttle, decode });

    expect(source.kind).toBe(TAB_CAPTURE_KINDS.VISIBLE_TAB);
    expect(await source.grab()).toEqual({ width: 10, height: 10, type: 'image/png' });
    expect(tabs.captureVisibleTab).toHaveBeenCalledWith(7, { format: 'png' });
    expect(throttle.wait).toHaveBeenCalledTimes(1);
  });

  it('turns the missing grant into a permission error for the fallback', async () => {
    const tabs = { captureVisibleTab: vi.fn(async () => { throw new Error(PERMISSION_MESSAGE); }) };
    const source = createVisibleTabSource({ tabs, throttle: immediateThrottle(), decode: vi.fn() });
    const error = await source.grab().catch((caught) => caught);
    expect(error).toBeInstanceOf(TabCaptureError);
    expect(error.code).toBe(TAB_CAPTURE_ERRORS.PERMISSION);
  });

  it('retries after the quota error and gives up after a few attempts', async () => {
    const tabs = {
      captureVisibleTab: vi.fn()
        .mockRejectedValueOnce(new Error(QUOTA_MESSAGE))
        .mockResolvedValueOnce(PNG)
    };
    const throttle = immediateThrottle();
    const source = createVisibleTabSource({ tabs, throttle, decode: async () => 'frame' });
    expect(await source.grab()).toBe('frame');
    expect(throttle.defer).toHaveBeenCalledTimes(1);
    expect(throttle.wait).toHaveBeenCalledTimes(2);

    const failing = createVisibleTabSource({
      tabs: { captureVisibleTab: vi.fn(async () => { throw new Error(QUOTA_MESSAGE); }) },
      throttle: immediateThrottle(),
      decode: vi.fn()
    });
    await expect(failing.grab()).rejects.toThrow('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
  });

  it('is unsupported without the tabs API', () => {
    expect(() => createVisibleTabSource({ tabs: {} })).toThrow(TabCaptureError);
  });
});

describe('tab sharing kept between snapshots', () => {
  let calls;
  let tracks;
  let capturedHandle;
  const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalSrcObject = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');

  /** A browser-tab track as Chrome hands it out; end() is Chrome's "Stop sharing". */
  function createTrack() {
    const track = new EventTarget();
    track.readyState = 'live';
    track.stop = vi.fn(() => { track.readyState = 'ended'; });
    track.getSettings = () => ({ displaySurface: 'browser', frameRate: 30 });
    track.getCaptureHandle = () => ({ handle: capturedHandle });
    track.applyConstraints = vi.fn(async () => {});
    track.end = () => {
      track.readyState = 'ended';
      track.dispatchEvent(new Event('ended'));
    };
    return track;
  }

  beforeEach(() => {
    calls = [];
    tracks = [];
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        setCaptureHandleConfig: ({ handle }) => { capturedHandle = handle; },
        getDisplayMedia: vi.fn(async (constraints) => {
          calls.push(constraints);
          const track = createTrack();
          tracks.push(track);
          return { getTracks: () => [track], getVideoTracks: () => [track] };
        })
      }
    });
    // happy-dom only takes its own MediaStream.
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      configurable: true,
      get() { return this.testSrcObject ?? null; },
      set(value) { this.testSrcObject = value; }
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async function play() {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function pause() {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
    });
    HTMLVideoElement.prototype.requestVideoFrameCallback = function requestVideoFrameCallback(callback) {
      queueMicrotask(() => callback(0, {}));
      return 1;
    };
    globalThis.createImageBitmap = vi.fn(async (video) => ({ width: 1280, height: 800, video }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete HTMLVideoElement.prototype.requestVideoFrameCallback;
    if (originalSrcObject) {
      Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', originalSrcObject);
    }
    globalThis.createImageBitmap = originalCreateImageBitmap;
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', originalMediaDevices);
    } else {
      delete navigator.mediaDevices;
    }
  });

  it('asks for this tab without the pointer', async () => {
    const source = await createDisplayMediaSource();
    expect(calls).toHaveLength(1);
    expect(calls[0].video).toEqual({ displaySurface: 'browser', cursor: 'never' });
    expect(calls[0].preferCurrentTab).toBe(true);
    expect(source.kind).toBe(TAB_CAPTURE_KINDS.DISPLAY_MEDIA);
    source.close();
  });

  it('reuses the kept stream for the next snapshot, paused and slowed down in between', async () => {
    const first = await openTabCaptureSource({ preferVisibleTab: false });
    expect(first.reused).toBe(false);
    const { source } = first;
    const bitmap = await source.grab();
    expect(bitmap.video.srcObject).toBeTruthy();

    await source.stop();
    expect(bitmap.video.paused).toBe(true);
    expect(tracks[0].applyConstraints).toHaveBeenLastCalledWith({ frameRate: IDLE_CAPTURE_FRAME_RATE });
    expect(tracks[0].stop).not.toHaveBeenCalled();

    const second = await openTabCaptureSource({ preferVisibleTab: false, keptSource: source });
    expect(second).toMatchObject({ source, reused: true });
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(1);

    await source.start();
    expect(bitmap.video.paused).toBe(false);
    expect(tracks[0].applyConstraints).toHaveBeenLastCalledWith({ frameRate: 30 });
    await expect(source.grab()).resolves.toMatchObject({ width: 1280 });
    source.close();
  });

  it('asks again once sharing was stopped from Chrome', async () => {
    const onEnded = vi.fn();
    const { source } = await openTabCaptureSource({ preferVisibleTab: false, onEnded });

    tracks[0].end();

    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(source.isActive()).toBe(false);
    const error = await source.start().catch((caught) => caught);
    expect(error).toBeInstanceOf(TabCaptureError);
    expect(error.code).toBe(TAB_CAPTURE_ERRORS.ENDED);
    await expect(source.grab()).rejects.toMatchObject({ code: TAB_CAPTURE_ERRORS.ENDED });

    const next = await openTabCaptureSource({ preferVisibleTab: false, keptSource: source });
    expect(next.reused).toBe(false);
    expect(next.source).not.toBe(source);
    expect(navigator.mediaDevices.getDisplayMedia).toHaveBeenCalledTimes(2);
    next.source.close();
  });

  it('stops every track when closed, e.g. from Stop or when the page goes away, and reports it once', async () => {
    const onEnded = vi.fn();
    const source = await createDisplayMediaSource({ onEnded });

    source.close();
    source.close();

    expect(tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(source.isActive()).toBe(false);
    // Stopping the track itself fires no "ended" event, and none is needed.
    tracks[0].end();
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it('refuses a kept stream that no longer shows this tab', async () => {
    const source = await createDisplayMediaSource();
    capturedHandle = 'panelize-snapshot-another-page';

    await expect(source.start()).rejects.toMatchObject({ code: TAB_CAPTURE_ERRORS.WRONG_SURFACE });
    await expect(source.grab()).rejects.toMatchObject({ code: TAB_CAPTURE_ERRORS.WRONG_SURFACE });
    source.close();
  });

  it('still tries the silent capture first while a stream is kept', async () => {
    const kept = await createDisplayMediaSource();
    const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,iVBORw0KGgo=');
    const previousTabs = chrome.tabs;
    chrome.tabs = { captureVisibleTab };
    try {
      const opened = await openTabCaptureSource({ keptSource: kept });
      expect(opened.source.kind).toBe(TAB_CAPTURE_KINDS.VISIBLE_TAB);
      expect(opened.reused).toBe(false);
      expect(captureVisibleTab).toHaveBeenCalledTimes(1);
    } finally {
      chrome.tabs = previousTabs;
      kept.close();
    }
  });
});
