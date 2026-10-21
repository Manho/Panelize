// Planning for "Full answers" snapshots: every panel scrolls in lock-step,
// one tab capture per step serves all of them, and each panel's
// conversation is stitched from the new part of every screen. Pure helpers,
// in CSS pixels unless noted.

/** Share of the visible conversation taken from each screen. The rest, at
 * the bottom, is where floating buttons and fades sit; it is only used on
 * the last screen. */
export const STITCH_STEP_RATIO = 0.75;

/** Gap and padding of #panel-grid. */
export const STITCH_GRID_GAP = 4;
export const STITCH_GRID_PADDING = 4;

/** Panels narrower than this on screen are left out. */
export const STITCH_MIN_VISIBLE_WIDTH = 40;

const ROW_TOLERANCE_PX = 2;

/**
 * Scroll distance between two captures.
 * @param {number} clipHeight - Visible conversation height.
 */
export function getStitchStep(clipHeight) {
  return Math.max(1, Math.floor(clipHeight * STITCH_STEP_RATIO));
}

/**
 * Starts tracking one panel.
 * @param {object} state - First PANELIZE_SNAPSHOT_STATE of the panel.
 * @param {{top: number, bottom: number}} state.clip - Frame viewport pixels.
 * @param {number} state.scrollTop
 * @param {number} state.maxScrollTop
 * @param {number} cap - Most content to keep, or Infinity.
 */
export function createStitchTrack({ clip, scrollTop, maxScrollTop }, cap = Infinity) {
  const clipHeight = Math.max(0, clip.bottom - clip.top);
  const start = scrollTop + clip.top;
  return {
    clip,
    step: getStitchStep(clipHeight),
    start,
    coveredUntil: start,
    // Where the conversation ends, in content pixels; updated as it grows.
    end: maxScrollTop + clip.bottom,
    cap,
    done: clipHeight === 0,
    truncated: false,
    segments: []
  };
}

/** Content still to capture, capped. */
export function getRemainingStitchHeight(track) {
  return Math.max(0, Math.min(track.end, track.start + track.cap) - track.coveredUntil);
}

/**
 * Adds the part of a screen not yet covered. Mutates and returns `track`.
 * @param {ReturnType<typeof createStitchTrack>} track
 * @param {{scrollTop: number, maxScrollTop: number}} state - Panel state at this capture.
 * @param {number} frameIndex - Capture the segment comes from.
 * @returns {{frameIndex: number, top: number, height: number, contentTop: number} | null}
 *   Segment in frame viewport pixels (top) and its offset in the stitched
 *   content (contentTop).
 */
export function addStitchScreen(track, { scrollTop, maxScrollTop }, frameIndex) {
  if (track.done) {
    return null;
  }
  const { clip } = track;
  track.end = Math.max(track.end, maxScrollTop + clip.bottom);
  const atEnd = scrollTop >= maxScrollTop - 1;
  // Each screen starts where the last one stopped; only the last screen
  // reaches down to the bottom of the visible conversation.
  const visibleTop = scrollTop + clip.top;
  const visibleBottom = scrollTop + clip.bottom;
  const limit = track.start + track.cap;

  const from = Math.max(track.coveredUntil, visibleTop);
  let to = atEnd ? visibleBottom : Math.min(visibleBottom, visibleTop + track.step);
  to = Math.min(to, limit);

  let segment = null;
  if (to > from) {
    segment = {
      frameIndex,
      top: from - scrollTop,
      height: to - from,
      contentTop: from - track.start
    };
    track.segments.push(segment);
    track.coveredUntil = to;
  }

  if (track.coveredUntil >= limit && track.end > limit) {
    track.truncated = true;
    track.done = true;
  } else if (track.coveredUntil >= track.end || !segment) {
    // Done, or the page did not scroll any further than last time.
    track.done = true;
  }
  return segment;
}

/**
 * Where to scroll the panel for the next capture, so the next segment starts
 * right at the top of the visible conversation; null when done.
 */
export function getNextStitchScrollTop(track, { maxScrollTop }) {
  if (track.done) {
    return null;
  }
  return Math.min(maxScrollTop, track.coveredUntil - track.clip.top);
}

/** Height of the stitched content so far. */
export function getStitchedHeight(track) {
  return track.coveredUntil - track.start;
}

/**
 * Groups on-screen panel rectangles into grid rows, top to bottom, each
 * sorted left to right.
 * @template {{rect: {top: number, left: number}}} T
 * @param {T[]} cells
 * @returns {T[][]}
 */
export function groupCellsIntoRows(cells) {
  const rows = [];
  [...cells]
    .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
    .forEach((cell) => {
      const row = rows.find((candidate) => Math.abs(candidate[0].rect.top - cell.rect.top) <= ROW_TOLERANCE_PX);
      if (row) {
        row.push(cell);
      } else {
        rows.push([cell]);
      }
    });
  rows.forEach((row) => row.sort((a, b) => a.rect.left - b.rect.left));
  return rows;
}

/**
 * Splits a height budget over grid rows. Each row needs its fixed part
 * (panel header, provider header) plus content; when everything does not
 * fit, the content of the tallest rows is cut to a common cap.
 * @param {{fixed: number, content: number}[]} rows - Largest cell of each row.
 * @param {number} budget - Height available to all rows together.
 * @returns {{caps: number[], truncated: boolean}} Content cap per row.
 */
export function allocateRowContentHeights(rows, budget) {
  const fixed = rows.reduce((sum, row) => sum + row.fixed, 0);
  const total = rows.reduce((sum, row) => sum + row.fixed + row.content, 0);
  if (total <= budget) {
    return { caps: rows.map((row) => row.content), truncated: false };
  }
  let available = Math.max(0, budget - fixed);
  // Water-fill: short rows keep everything, the rest share what is left.
  const order = rows.map((row, index) => ({ index, content: row.content }))
    .sort((a, b) => a.content - b.content);
  const caps = new Array(rows.length).fill(0);
  let remaining = order.length;
  for (const { index, content } of order) {
    const share = Math.floor(available / remaining);
    caps[index] = Math.min(content, share);
    available -= caps[index];
    remaining -= 1;
  }
  return { caps, truncated: true };
}

/**
 * Places cells as on screen: same columns, each row as tall as its tallest
 * cell.
 * @param {object} options
 * @param {{rect: {left: number, top: number, width: number}, height: number}[][]} options.rows
 * @param {number} options.gridLeft - Left edge of the visible grid.
 * @param {number} options.gridWidth
 * @param {number} [options.gap]
 * @param {number} [options.padding]
 * @returns {{width: number, height: number, rows: {y: number, height: number,
 *   cells: {x: number, y: number, width: number, height: number}[]}[]}}
 */
export function layoutStitchedGrid({
  rows,
  gridLeft,
  gridWidth,
  gap = STITCH_GRID_GAP,
  padding = STITCH_GRID_PADDING
}) {
  let y = padding;
  const placed = rows.map((row, rowIndex) => {
    const height = Math.max(...row.map((cell) => cell.height));
    const rowY = y + (rowIndex > 0 ? gap : 0);
    y = rowY + height;
    return {
      y: rowY,
      height,
      cells: row.map((cell) => ({
        x: Math.round(cell.rect.left - gridLeft),
        y: rowY,
        width: Math.round(cell.rect.width),
        height
      }))
    };
  });
  return { width: Math.round(gridWidth), height: y + padding, rows: placed };
}

/**
 * Most common color among pixels, to fill below shorter answers.
 * @param {Uint8ClampedArray | number[]} data - RGBA pixels.
 * @returns {string} CSS rgb() color.
 */
export function getDominantColor(data) {
  const counts = new Map();
  let best = null;
  let bestCount = 0;
  for (let index = 0; index + 3 < data.length; index += 4) {
    // Quantize so antialiasing noise does not split one background.
    const key = ((data[index] >> 3) << 10) | ((data[index + 1] >> 3) << 5) | (data[index + 2] >> 3);
    const entry = counts.get(key) || { count: 0, r: data[index], g: data[index + 1], b: data[index + 2] };
    entry.count += 1;
    counts.set(key, entry);
    if (entry.count > bestCount) {
      best = entry;
      bestCount = entry.count;
    }
  }
  return best ? `rgb(${best.r}, ${best.g}, ${best.b})` : 'rgb(255, 255, 255)';
}

/**
 * Largest output scale that keeps a canvas within Chrome's limits.
 * @param {number} width - CSS pixels.
 * @param {number} height - CSS pixels.
 * @param {number} scale - Wanted output pixels per CSS pixel.
 * @param {{maxDimension: number, maxArea: number}} limits
 */
export function fitCanvasScale(width, height, scale, { maxDimension, maxArea }) {
  const byDimension = Math.min(maxDimension / width, maxDimension / height);
  const byArea = Math.sqrt(maxArea / (width * height));
  return Math.min(scale, byDimension, byArea);
}
