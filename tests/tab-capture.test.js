import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
  TAB_CAPTURE_ERRORS,
  TAB_CAPTURE_KINDS,
  TabCaptureError,
  VISIBLE_TAB_CAPTURE_INTERVAL_MS,
  createCallThrottle,
  createVisibleTabSource,
  dataUrlToBlob,
  isCapturePermissionError,
  isCaptureQuotaError
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
