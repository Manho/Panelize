import { describe, expect, it, vi } from 'vitest';
import {
  PANEL_RESIZE_MIN_WIDTH,
  getColumnTemplate,
  getColumnWeights,
  isValidColumnWeights,
  resizeColumns,
  setupPanelResize
} from '../modules/panel-resize.js';

describe('resizeColumns', () => {
  it('trades width with the neighbor when the columns fit the window', () => {
    expect(resizeColumns([600, 600, 600], 0, 150, { scrolls: false, available: 1800 }))
      .toEqual([750, 450, 600]);
    expect(resizeColumns([600, 600, 600], 1, -100, { scrolls: false, available: 1800 }))
      .toEqual([600, 500, 700]);
  });

  it('keeps both neighbors at least the minimum width', () => {
    expect(resizeColumns([600, 600], 0, 900, { scrolls: false, available: 1200 }))
      .toEqual([1200 - PANEL_RESIZE_MIN_WIDTH, PANEL_RESIZE_MIN_WIDTH]);
    expect(resizeColumns([600, 600], 0, -900, { scrolls: false, available: 1200 }))
      .toEqual([PANEL_RESIZE_MIN_WIDTH, 1200 - PANEL_RESIZE_MIN_WIDTH]);
  });

  it('does not force columns already narrower than the minimum wider', () => {
    expect(resizeColumns([150, 150], 0, 10, { scrolls: false, available: 300 })).toEqual([150, 150]);
  });

  it('grows a column alone when the columns scroll sideways', () => {
    expect(resizeColumns([320, 320, 320, 320], 1, 100, { scrolls: true, available: 1000 }))
      .toEqual([320, 420, 320, 320]);
  });

  it('shrinks a scrolling column no further than fitting the window again', () => {
    expect(resizeColumns([320, 320, 320, 320], 1, -100, { scrolls: true, available: 1000 }))
      .toEqual([320, 220, 320, 320]);
    expect(resizeColumns([320, 320, 320, 320], 1, -300, { scrolls: true, available: 1240 }))
      .toEqual([320, 280, 320, 320]);
  });
});

describe('getColumnWeights', () => {
  it('weights columns that fit the window by their share of it', () => {
    expect(getColumnWeights([750, 450, 600], 1800, 400)).toEqual([1.25, 0.75, 1]);
  });

  it('weights scrolling columns against the layout minimum', () => {
    expect(getColumnWeights([480, 320, 320], 900, 320)).toEqual([1.5, 1, 1]);
  });

  it('works for layouts without a minimum', () => {
    expect(getColumnWeights([300, 500], 800, 0)).toEqual([0.75, 1.25]);
  });
});

describe('getColumnTemplate', () => {
  it('gives each column a minimum and a share in proportion to its weight', () => {
    expect(getColumnTemplate([1.5, 1], 320)).toBe('minmax(480px, 1.5fr) minmax(320px, 1fr)');
    expect(getColumnTemplate([0.75, 1.25], 0)).toBe('minmax(0px, 0.75fr) minmax(0px, 1.25fr)');
  });

  it('reproduces the dragged widths', () => {
    const widths = [750, 450, 600];
    const weights = getColumnWeights(widths, 1800, 400);
    // 1fr resolves to available / sum(weights) when no minimum binds.
    const fr = 1800 / weights.reduce((total, weight) => total + weight, 0);
    expect(weights.map((weight) => weight * fr)).toEqual(widths);
  });
});

describe('isValidColumnWeights', () => {
  it('accepts positive weights for every column only', () => {
    expect(isValidColumnWeights([1, 1.5], 2)).toBe(true);
    expect(isValidColumnWeights([1, 1.5], 3)).toBe(false);
    expect(isValidColumnWeights([1, 0], 2)).toBe(false);
    expect(isValidColumnWeights([1, 'x'], 2)).toBe(false);
    expect(isValidColumnWeights(null, 2)).toBe(false);
  });
});

describe('setupPanelResize', () => {
  it('does nothing on a page without a panel grid', async () => {
    const storage = { get: vi.fn(), set: vi.fn() };
    await expect(setupPanelResize({ grid: null, getLayout: () => '1x3', storage, label: '' }))
      .resolves.toBeUndefined();
    expect(storage.get).not.toHaveBeenCalled();
  });
});
