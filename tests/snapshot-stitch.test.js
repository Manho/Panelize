import { describe, expect, it } from 'vitest';
import {
  STITCH_STEP_RATIO,
  addStitchScreen,
  allocateRowContentHeights,
  createStitchTrack,
  fitCanvasScale,
  getDominantColor,
  getNextStitchScrollTop,
  getRemainingStitchHeight,
  getStitchStep,
  getStitchedHeight,
  groupCellsIntoRows,
  layoutStitchedGrid
} from '../modules/snapshot-stitch.js';

/** Simulates a panel scrolling to the requested positions. */
function runPanel({ clip, scrollTop, contentHeight, cap }) {
  const clipHeight = clip.bottom - clip.top;
  const maxScrollTop = Math.max(0, contentHeight - clip.bottom);
  const track = createStitchTrack({ clip, scrollTop, maxScrollTop }, cap);
  let position = scrollTop;
  let frame = 0;
  while (!track.done) {
    addStitchScreen(track, { scrollTop: position, maxScrollTop }, frame);
    const next = getNextStitchScrollTop(track, { maxScrollTop });
    if (next === null) break;
    position = Math.min(maxScrollTop, Math.max(0, next));
    frame += 1;
    if (frame > 100) throw new Error('did not finish');
  }
  return { track, frames: frame + 1, clipHeight };
}

describe('stitch planning', () => {
  it('steps by three quarters of the visible conversation', () => {
    expect(STITCH_STEP_RATIO).toBe(0.75);
    expect(getStitchStep(600)).toBe(450);
    expect(getStitchStep(0)).toBe(1);
  });

  it('covers the conversation from the aligned message to the end without gaps or overlap', () => {
    const clip = { top: 60, bottom: 660 };
    const { track } = runPanel({ clip, scrollTop: 1000, contentHeight: 4000 });

    expect(track.done).toBe(true);
    expect(track.truncated).toBe(false);
    expect(track.segments[0]).toMatchObject({ frameIndex: 0, top: 60, height: 450, contentTop: 0 });
    let expectedTop = 0;
    track.segments.forEach((segment) => {
      expect(segment.contentTop).toBe(expectedTop);
      expect(segment.top).toBeGreaterThanOrEqual(clip.top);
      expect(segment.top + segment.height).toBeLessThanOrEqual(clip.bottom);
      expectedTop += segment.height;
    });
    // From the clip top at scrollTop 1000 down to the content end.
    expect(getStitchedHeight(track)).toBe(4000 - (1000 + 60));
    expect(getRemainingStitchHeight(track)).toBe(0);
  });

  it('takes the whole visible conversation when it fits on one screen', () => {
    const { track, frames } = runPanel({ clip: { top: 0, bottom: 500 }, scrollTop: 0, contentHeight: 300 });
    expect(frames).toBe(1);
    expect(track.segments).toEqual([{ frameIndex: 0, top: 0, height: 500, contentTop: 0 }]);
  });

  it('stops at the cap and marks the panel truncated', () => {
    const { track } = runPanel({ clip: { top: 0, bottom: 600 }, scrollTop: 0, contentHeight: 10000, cap: 2000 });
    expect(getStitchedHeight(track)).toBe(2000);
    expect(track.truncated).toBe(true);
  });

  it('finishes when the page stops scrolling', () => {
    const clip = { top: 0, bottom: 600 };
    const track = createStitchTrack({ clip, scrollTop: 0, maxScrollTop: 3000 });
    addStitchScreen(track, { scrollTop: 0, maxScrollTop: 3000 }, 0);
    // The page ignored the scroll request.
    addStitchScreen(track, { scrollTop: 0, maxScrollTop: 3000 }, 1);
    expect(track.done).toBe(true);
    expect(track.segments).toHaveLength(1);
  });

  it('follows content that grows while scrolling', () => {
    const clip = { top: 0, bottom: 600 };
    const track = createStitchTrack({ clip, scrollTop: 0, maxScrollTop: 400 });
    addStitchScreen(track, { scrollTop: 0, maxScrollTop: 400 }, 0);
    addStitchScreen(track, { scrollTop: 400, maxScrollTop: 1400 }, 1);
    expect(track.done).toBe(false);
    expect(track.end).toBe(2000);
  });
});

describe('grid layout', () => {
  const cell = (left, top, width = 500) => ({ rect: { left, top, width }, height: 0 });

  it('groups panels into rows as on screen', () => {
    const cells = [cell(504, 300), cell(0, 0), cell(504, 1), cell(0, 300)];
    const rows = groupCellsIntoRows(cells);
    expect(rows.map((row) => row.map((item) => [item.rect.left, item.rect.top]))).toEqual([
      [[0, 0], [504, 1]],
      [[0, 300], [504, 300]]
    ]);
  });

  it('makes each row as tall as its tallest cell', () => {
    const rows = [
      [{ rect: { left: 10, top: 0, width: 500 }, height: 900 }, { rect: { left: 514, top: 0, width: 500 }, height: 2000 }],
      [{ rect: { left: 10, top: 400, width: 1004 }, height: 300 }]
    ];
    const grid = layoutStitchedGrid({ rows, gridLeft: 6, gridWidth: 1012 });
    expect(grid.width).toBe(1012);
    expect(grid.rows[0]).toMatchObject({ y: 4, height: 2000 });
    expect(grid.rows[0].cells.map((item) => item.x)).toEqual([4, 508]);
    expect(grid.rows[1]).toMatchObject({ y: 4 + 2000 + 4, height: 300 });
    expect(grid.height).toBe(4 + 2000 + 4 + 300 + 4);
  });
});

describe('allocateRowContentHeights', () => {
  it('keeps everything when it fits', () => {
    expect(allocateRowContentHeights([{ fixed: 50, content: 1000 }, { fixed: 50, content: 500 }], 5000))
      .toEqual({ caps: [1000, 500], truncated: false });
  });

  it('cuts the tallest rows to a shared cap', () => {
    const { caps, truncated } = allocateRowContentHeights([
      { fixed: 100, content: 6000 },
      { fixed: 100, content: 500 }
    ], 3000);
    expect(truncated).toBe(true);
    expect(caps).toEqual([2300, 500]);
    expect(caps[0] + caps[1] + 200).toBe(3000);
  });

  it('splits evenly when every row is long', () => {
    const { caps } = allocateRowContentHeights([
      { fixed: 0, content: 9000 },
      { fixed: 0, content: 9000 }
    ], 4000);
    expect(caps).toEqual([2000, 2000]);
  });
});

describe('getDominantColor', () => {
  it('returns the most common color', () => {
    const pixels = [
      255, 255, 255, 255,
      250, 251, 252, 255,
      20, 20, 20, 255
    ];
    expect(getDominantColor(pixels)).toBe('rgb(255, 255, 255)');
    expect(getDominantColor([])).toBe('rgb(255, 255, 255)');
  });
});

describe('fitCanvasScale', () => {
  const limits = { maxDimension: 32767, maxArea: 268435456 };

  it('keeps the wanted scale within limits', () => {
    expect(fitCanvasScale(1400, 4000, 2, limits)).toBe(2);
  });

  it('shrinks the scale past the dimension or area limit', () => {
    expect(fitCanvasScale(1000, 20000, 2, limits)).toBeCloseTo(32767 / 20000);
    expect(fitCanvasScale(15000, 15000, 2, limits)).toBeCloseTo(Math.sqrt(268435456 / (15000 * 15000)));
  });
});
