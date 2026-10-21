import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_MESSAGES,
  SnapshotLayoutChangedError,
  captureCurrentView,
  captureFullAnswers,
  createSnapshotBridge,
  getPanelCellGeometry,
  getStitchBudget,
  intersectRects,
  selectVisiblePanels
} from '../modules/snapshot-capture.js';

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function messageEvent(data, source) {
  const event = new Event('message');
  Object.defineProperty(event, 'data', { value: data });
  Object.defineProperty(event, 'source', { value: source });
  return event;
}

describe('createSnapshotBridge', () => {
  function createFrame(host, reply) {
    const contentWindow = {
      postMessage: vi.fn((message) => {
        const answer = reply(message);
        if (answer) {
          queueMicrotask(() => host.dispatchEvent(messageEvent(answer, answer.source || contentWindow)));
        }
      })
    };
    return { contentWindow };
  }

  it('sends the request to the frame and resolves with its state', async () => {
    const host = new EventTarget();
    const bridge = createSnapshotBridge(host);
    const frame = createFrame(host, (message) => ({
      type: SNAPSHOT_MESSAGES.STATE,
      context: 'multi-panel-snapshot',
      requestId: message.requestId,
      scrollTop: 120
    }));
    const state = await bridge.request(frame, SNAPSHOT_MESSAGES.PREPARE, { align: true, prompt: 'Hi' });
    expect(state.scrollTop).toBe(120);
    expect(frame.contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: SNAPSHOT_MESSAGES.PREPARE,
      context: 'multi-panel',
      align: true,
      prompt: 'Hi',
      sessionId: bridge.sessionId
    }), '*');
    bridge.dispose();
  });

  it('ignores replies from another frame and times out', async () => {
    vi.useFakeTimers();
    try {
      const host = new EventTarget();
      const bridge = createSnapshotBridge(host);
      const impostor = {};
      const frame = createFrame(host, (message) => ({
        type: SNAPSHOT_MESSAGES.STATE,
        context: 'multi-panel-snapshot',
        requestId: message.requestId,
        source: impostor
      }));
      const pending = bridge.request(frame, SNAPSHOT_MESSAGES.SCROLL, { scrollTop: 10 }, 500);
      await vi.advanceTimersByTimeAsync(600);
      expect(await pending).toBeNull();
      bridge.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves null for frames without a window', async () => {
    const bridge = createSnapshotBridge(new EventTarget());
    expect(await bridge.request({}, SNAPSHOT_MESSAGES.RESTORE)).toBeNull();
    bridge.dispose();
  });
});

describe('panel geometry', () => {
  const visibleGrid = rect(0, 50, 1200, 700);

  it('intersects rectangles', () => {
    expect(intersectRects(rect(0, 0, 100, 100), rect(50, 50, 100, 100))).toMatchObject({ left: 50, top: 50, width: 50, height: 50 });
    expect(intersectRects(rect(0, 0, 10, 10), rect(50, 50, 10, 10))).toMatchObject({ width: 0, height: 0 });
  });

  it('skips hidden panels and panels scrolled out of the grid', () => {
    const panels = [
      { id: 'a', rect: rect(4, 54, 590, 690) },
      { id: 'b', rect: rect(598, 54, 590, 690), hidden: true },
      { id: 'c', rect: rect(1180, 54, 590, 690) },
      { id: 'd', rect: rect(1100, 54, 590, 690) }
    ];
    expect(selectVisiblePanels(panels, visibleGrid).map((panel) => panel.id)).toEqual(['a', 'd']);
  });

  it('maps the conversation clip of a frame onto the page', () => {
    const geometry = getPanelCellGeometry({
      panelRect: rect(1000, 54, 590, 690),
      iframeRect: rect(1000, 90, 590, 654),
      state: { clip: { left: 0, top: 56, right: 560, bottom: 534 }, viewport: { width: 590, height: 654 } },
      visibleGrid
    });
    expect(geometry).toEqual({
      left: 1000,
      right: 1200,
      top: 54,
      headBottom: 146,
      contentLeft: 1000,
      contentRight: 1200,
      zoom: 1
    });
  });
});

describe('getStitchBudget', () => {
  it('keeps the device scale and leaves room for the frame', () => {
    const budget = getStitchBudget({ frameScale: 2, gridWidth: 1200, getChromeHeight: (scale) => 300 * scale });
    expect(budget).toEqual({ scale: 2, contentHeight: (8000 - 600) / 2 });
  });

  it('caps the output width at 2560 pixels', () => {
    const budget = getStitchBudget({ frameScale: 2, gridWidth: 1600, getChromeHeight: () => 0 });
    expect(budget.scale).toBe(1.6);
    expect(budget.contentHeight).toBe(5000);
  });
});

describe('captureCurrentView', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    document.body.innerHTML = '';
  });

  /** A panel whose page answers every snapshot request. */
  function createPanel(name, left, state) {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => rect(left, 0, 400, 600);
    document.body.appendChild(element);
    const messages = [];
    const contentWindow = {
      postMessage: vi.fn((message) => {
        messages.push(message);
        queueMicrotask(() => window.dispatchEvent(messageEvent({
          type: SNAPSHOT_MESSAGES.STATE,
          context: 'multi-panel-snapshot',
          requestId: message.requestId,
          clip: { left: 0, top: 50, right: 400, bottom: 500 },
          viewport: { width: 400, height: 560 },
          ...state
        }, contentWindow)));
      })
    };
    return { panel: { id: name, name, iframe: { contentWindow }, element }, messages };
  }

  it('hides floating controls, and the pointer when asked, and reports where each panel started', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() }));
    const grid = document.createElement('div');
    grid.getBoundingClientRect = () => rect(0, 0, 800, 600);
    const chat = createPanel('ChatGPT', 0, { alignedBy: 'prompt', scrollTop: 900, originalScrollTop: 2000, maxScrollTop: 2000 });
    const quiet = createPanel('DeepSeek', 400, { alignedBy: null, scrollTop: 300, originalScrollTop: 300, maxScrollTop: 1000 });
    const frame = { width: window.innerWidth, height: window.innerHeight, close: vi.fn() };

    const result = await captureCurrentView({
      source: { grab: async () => frame },
      grid,
      panels: [chat.panel, quiet.panel],
      prompt: 'Explain HTTPS',
      hideCursor: true
    });

    expect(chat.messages[0]).toMatchObject({
      type: SNAPSHOT_MESSAGES.PREPARE, align: true, prompt: 'Explain HTTPS', stitch: false, hideFloating: true, hideCursor: true
    });
    // Everything is put back afterwards.
    expect(chat.messages.at(-1).type).toBe(SNAPSHOT_MESSAGES.RESTORE);
    expect(quiet.messages.at(-1).type).toBe(SNAPSHOT_MESSAGES.RESTORE);
    expect(result.alignment).toEqual([
      { name: 'ChatGPT', alignedBy: 'prompt', originalScrollTop: 2000, startScrollTop: 900, endScrollTop: 900, maxScrollTop: 2000 },
      { name: 'DeepSeek', alignedBy: null, originalScrollTop: 300, startScrollTop: 300, endScrollTop: 300, maxScrollTop: 1000 }
    ]);
    expect(frame.close).toHaveBeenCalled();
  });
});

/** A panel whose page scrolls to wherever it is asked, in a 2000px conversation. */
function createScrollingPanel(name, left, clip = { left: 0, top: 50, right: 400, bottom: 500 }) {
  const element = document.createElement('div');
  element.getBoundingClientRect = () => rect(left, 0, 400, 600);
  document.body.appendChild(element);
  const messages = [];
  const contentWindow = {
    postMessage: vi.fn((message) => {
      messages.push(message);
      queueMicrotask(() => window.dispatchEvent(messageEvent({
        type: SNAPSHOT_MESSAGES.STATE,
        context: 'multi-panel-snapshot',
        requestId: message.requestId,
        clip: { left: 0, top: 50, right: 400, bottom: 500 },
        viewport: { width: 400, height: 560 },
        alignedBy: 'prompt',
        scrollTop: message.scrollTop ?? 0,
        originalScrollTop: 0,
        maxScrollTop: 2000
      }, contentWindow)));
    })
  };
  const iframe = { contentWindow, getBoundingClientRect: () => rect(left, 40, 400, 560) };
  return { panel: { id: name, name, iframe, element }, messages };
}

function createGrid() {
  const grid = document.createElement('div');
  grid.getBoundingClientRect = () => rect(0, 0, 800, 600);
  return grid;
}

/**
 * Frames of the whole tab; `onGrab(count)` runs before each is returned.
 * `frameScale` is captured pixels per CSS pixel.
 */
function createSource(onGrab, frameScale = 1) {
  const frames = [];
  let count = 0;
  return {
    frames,
    grab: vi.fn(async () => {
      count += 1;
      onGrab(count);
      const frame = { width: window.innerWidth * frameScale, height: window.innerHeight * frameScale, close: vi.fn() };
      frames.push(frame);
      return frame;
    })
  };
}

describe('a window resized during a capture', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    window.innerWidth = originalInnerWidth;
    document.body.innerHTML = '';
  });

  it('stops full answers rather than crop panels that moved, and puts the pages back', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() }));
    const chat = createScrollingPanel('ChatGPT', 0);
    const deep = createScrollingPanel('DeepSeek', 400);
    // A tiling window manager widens the window after the first screen.
    const source = createSource((count) => {
      if (count === 3) window.innerWidth = originalInnerWidth * 2;
    });

    await expect(captureFullAnswers({
      source,
      grid: createGrid(),
      panels: [chat.panel, deep.panel],
      prompt: 'Explain HTTPS',
      getChromeHeight: () => 100
    })).rejects.toBeInstanceOf(SnapshotLayoutChangedError);

    expect(source.grab).toHaveBeenCalledTimes(3);
    expect(chat.messages.at(-1).type).toBe(SNAPSHOT_MESSAGES.RESTORE);
    expect(deep.messages.at(-1).type).toBe(SNAPSHOT_MESSAGES.RESTORE);
    expect(source.frames.every((frame) => frame.close.mock.calls.length > 0)).toBe(true);
  });

  it('stops the current view when the window changed before the frame', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 800, height: 600, close: vi.fn() }));
    const chat = createScrollingPanel('ChatGPT', 0);
    const source = createSource(() => {
      window.innerWidth = originalInnerWidth / 2;
    });

    await expect(captureCurrentView({
      source,
      grid: createGrid(),
      panels: [chat.panel],
      prompt: 'Explain HTTPS'
    })).rejects.toBeInstanceOf(SnapshotLayoutChangedError);

    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();
    expect(chat.messages.at(-1).type).toBe(SNAPSHOT_MESSAGES.RESTORE);
    expect(source.frames[0].close).toHaveBeenCalled();
  });

  it('captures full answers when the window keeps its size', async () => {
    globalThis.createImageBitmap = vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() }));
    // jsdom has no canvas: a 2D context that draws nothing.
    const context = new Proxy({}, {
      get: (target, key) => (key in target ? target[key] : key === 'getImageData'
        ? () => ({ data: new Uint8ClampedArray(4) })
        : () => {}),
      set: (target, key, value) => { target[key] = value; return true; }
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    const chat = createScrollingPanel('ChatGPT', 0);
    const source = createSource(() => {});

    try {
      const result = await captureFullAnswers({
        source,
        grid: createGrid(),
        panels: [chat.panel],
        prompt: 'Explain HTTPS',
        getChromeHeight: () => 100
      });
      expect(result.currentViewOnly).toEqual([]);
      expect(result.screens).toBe(source.grab.mock.calls.length);
      expect(result.screens).toBeGreaterThan(1);
    } finally {
      getContext.mockRestore();
    }
  });
});

describe('stitched screens', () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;

  afterEach(() => {
    globalThis.createImageBitmap = originalCreateImageBitmap;
    document.body.innerHTML = '';
  });

  it('meet without a gap or an overlap at a fractional scale', async () => {
    globalThis.createImageBitmap = vi.fn(async (frame, sx, sy, sw, sh, options) => ({
      width: options.resizeWidth, height: options.resizeHeight, close: vi.fn()
    }));
    const draws = [];
    // jsdom has no canvas: a 2D context that records what is drawn.
    const context = new Proxy({}, {
      get: (target, key) => {
        if (key in target) return target[key];
        if (key === 'drawImage') return (...args) => draws.push(args);
        if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => {};
      },
      set: (target, key, value) => { target[key] = value; return true; }
    });
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    // A page header ending between two pixels, like Gemini's.
    const chat = createScrollingPanel('Gemini', 0, { left: 0, top: 50.4, right: 400, bottom: 500 });
    const source = createSource(() => {}, 1.37);

    try {
      const result = await captureFullAnswers({
        source,
        grid: createGrid(),
        panels: [chat.panel],
        prompt: 'Explain HTTPS',
        getChromeHeight: () => 100
      });
      expect(result.screens).toBeGreaterThan(2);
      // Head first, then one draw per screen, top to bottom.
      const placed = draws.filter((args) => args.length === 5).slice(1)
        .map(([, , y, , height]) => ({ y, height }));
      expect(placed).toHaveLength(result.screens);
      placed.slice(1).forEach((segment, index) => {
        expect(segment.y).toBe(placed[index].y + placed[index].height);
      });
    } finally {
      getContext.mockRestore();
    }
  });
});
