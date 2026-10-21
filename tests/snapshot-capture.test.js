import { describe, expect, it, vi } from 'vitest';
import {
  SNAPSHOT_MESSAGES,
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
