// Captures the panel grid for a share snapshot. "Current view" lines every
// conversation up on the shared prompt and takes one frame. "Full answers"
// scrolls all panels in lock-step, takes one frame per step and stitches
// each panel's conversation, laid out like the grid on screen. Provider
// pages are scrolled through the content script's PANELIZE_SNAPSHOT_*
// messages and put back afterwards.

import {
  CANVAS_MAX_AREA,
  CANVAS_MAX_DIMENSION,
  SNAPSHOT_MAX_CAPTURE_WIDTH,
  SNAPSHOT_MAX_OUTPUT_HEIGHT
} from './share-snapshot.js';
import {
  STITCH_GRID_GAP,
  STITCH_FULL_PANEL_TOLERANCE,
  STITCH_GRID_PADDING,
  STITCH_MIN_VISIBLE_WIDTH,
  addStitchScreen,
  allocateRowContentHeights,
  createStitchTrack,
  fitCanvasScale,
  getDominantColor,
  getNextStitchScrollTop,
  getRemainingStitchHeight,
  groupCellsIntoRows,
  layoutStitchedGrid
} from './snapshot-stitch.js';
import { cropCapturedFrame } from './tab-capture.js';

export const SNAPSHOT_MODES = Object.freeze({
  CURRENT: 'current',
  FULL: 'full'
});

export const SNAPSHOT_MESSAGES = Object.freeze({
  PREPARE: 'PANELIZE_SNAPSHOT_PREPARE',
  SCROLL: 'PANELIZE_SNAPSHOT_SCROLL',
  RESTORE: 'PANELIZE_SNAPSHOT_RESTORE',
  STATE: 'PANELIZE_SNAPSHOT_STATE'
});

const HOST_CONTEXT = 'multi-panel';
const STATE_CONTEXT = 'multi-panel-snapshot';

// Matching the prompt walks the whole page text; scrolling waits for paint.
const PREPARE_TIMEOUT_MS = 2500;
const SCROLL_TIMEOUT_MS = 1500;
const RESTORE_TIMEOUT_MS = 1500;

/** Upper bound on captures for one snapshot, whatever the pages report. */
export const MAX_STITCH_SCREENS = 60;

/** Height of the strip sampled for the fill color under shorter answers. */
const FILL_SAMPLE_HEIGHT = 24;
/** Frame pixels an edge may be off by float error and still count as on a row. */
const EDGE_EPSILON = 0.01;

export class SnapshotCancelledError extends Error {
  constructor() {
    super('Snapshot cancelled');
    this.name = 'SnapshotCancelledError';
  }
}

/**
 * The window, grid or a panel changed size during a capture, so the panels
 * are no longer where they were measured and the frames cannot be cropped.
 */
export class SnapshotLayoutChangedError extends Error {
  constructor() {
    super('The layout changed during the snapshot');
    this.name = 'SnapshotLayoutChangedError';
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new SnapshotCancelledError();
  }
}

/**
 * Returns a check that throws SnapshotLayoutChangedError once the window
 * size, device scale, grid box, grid scroll or a panel's box differs from
 * now, e.g. after a tiling window manager re-tiles the window or a panel
 * divider is dragged mid-capture.
 * @param {HTMLElement} grid
 * @param {SnapshotPanel[]} panels
 */
function watchLayout(grid, panels) {
  const boxOf = (element) => {
    const box = element.getBoundingClientRect();
    return [box.left, box.top, box.width, box.height];
  };
  const read = () => [
    window.innerWidth, window.innerHeight, window.devicePixelRatio,
    ...boxOf(grid), grid.scrollLeft, grid.scrollTop,
    ...panels.flatMap((panel) => [...boxOf(panel.element), ...boxOf(panel.iframe)])
  ]
    .map((value) => Math.round(value * 100))
    .join(',');
  const measured = read();
  return () => {
    if (read() !== measured) {
      throw new SnapshotLayoutChangedError();
    }
  };
}

/**
 * Request/response over postMessage with the provider frames. Replies are
 * accepted only from the frame that was asked.
 * @param {Window} [host]
 */
export function createSnapshotBridge(host = window) {
  const pending = new Map();
  let nextId = 0;
  const sessionId = `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const onMessage = (event) => {
    const data = event.data;
    if (!data || data.type !== SNAPSHOT_MESSAGES.STATE || data.context !== STATE_CONTEXT) {
      return;
    }
    const entry = pending.get(data.requestId);
    if (!entry || event.source !== entry.target) {
      return;
    }
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    entry.resolve(data);
  };
  host.addEventListener('message', onMessage);

  return {
    sessionId,
    /**
     * @returns {Promise<object | null>} The frame's state, or null when it
     *   did not answer in time (no content script, still loading).
     */
    request(iframe, type, data = {}, timeoutMs = SCROLL_TIMEOUT_MS) {
      const target = iframe?.contentWindow;
      if (!target) {
        return Promise.resolve(null);
      }
      nextId += 1;
      const requestId = `${sessionId}-${nextId}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          resolve(null);
        }, timeoutMs);
        pending.set(requestId, { target, resolve, timer });
        try {
          target.postMessage({ ...data, type, context: HOST_CONTEXT, requestId, sessionId }, '*');
        } catch (error) {
          pending.delete(requestId);
          clearTimeout(timer);
          resolve(null);
        }
      });
    },
    dispose() {
      host.removeEventListener('message', onMessage);
      pending.forEach((entry) => {
        clearTimeout(entry.timer);
        entry.resolve(null);
      });
      pending.clear();
    }
  };
}

function toRect({ left, top, right, bottom }) {
  return { left, top, right, bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Intersection of two rectangles, possibly empty. */
export function intersectRects(a, b) {
  return toRect({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.max(Math.max(a.left, b.left), Math.min(a.right, b.right)),
    bottom: Math.max(Math.max(a.top, b.top), Math.min(a.bottom, b.bottom))
  });
}

/**
 * Panels worth capturing: rendered and fully inside the visible part of the
 * grid, so a scrolled grid never yields half panels. When none fits, as in a
 * window narrower than one column, the most visible panel is taken instead.
 * @param {{rect: DOMRectReadOnly, hidden?: boolean}[]} panels
 * @param {ReturnType<typeof toRect>} visibleGrid
 * @returns {{captured: object[], outOfView: object[]}} Panels to capture,
 *   and the rendered ones left out.
 */
export function selectVisiblePanels(panels, visibleGrid) {
  const shown = panels.filter((panel) => !panel.hidden);
  const visibleOf = new Map(shown.map((panel) => [panel, intersectRects(panel.rect, visibleGrid)]));
  let captured = shown.filter((panel) => {
    const visible = visibleOf.get(panel);
    // The grid only scrolls sideways, so columns are what get cut.
    return visible.height > 0 && visible.width >= panel.rect.width - STITCH_FULL_PANEL_TOLERANCE;
  });
  if (captured.length === 0) {
    const area = (panel) => visibleOf.get(panel).width * visibleOf.get(panel).height;
    const best = shown
      .filter((panel) => visibleOf.get(panel).width >= STITCH_MIN_VISIBLE_WIDTH && visibleOf.get(panel).height > 0)
      .reduce((most, panel) => (!most || area(panel) > area(most) ? panel : most), null);
    captured = best ? [best] : [];
  }
  return { captured, outOfView: shown.filter((panel) => !captured.includes(panel)) };
}

/**
 * Part of the grid to capture: the captured panels plus the grid padding
 * around them, within the visible grid. Sideways, the padding is as wide on
 * both sides: a scrolled grid snaps a panel flush to its edge.
 * @param {{rect: DOMRectReadOnly}[]} panels
 * @param {ReturnType<typeof toRect>} visibleGrid
 */
export function getCaptureArea(panels, visibleGrid) {
  if (panels.length === 0) {
    return visibleGrid;
  }
  const left = Math.min(...panels.map((panel) => panel.rect.left));
  const right = Math.max(...panels.map((panel) => panel.rect.right));
  const paddingX = Math.max(0, Math.min(STITCH_GRID_PADDING, left - visibleGrid.left, visibleGrid.right - right));
  return intersectRects(toRect({
    left: left - paddingX,
    top: Math.min(...panels.map((panel) => panel.rect.top)) - STITCH_GRID_PADDING,
    right: right + paddingX,
    bottom: Math.max(...panels.map((panel) => panel.rect.bottom)) + STITCH_GRID_PADDING
  }), visibleGrid);
}

/**
 * Where the parts of one panel sit on screen, in page CSS pixels.
 * @param {object} options
 * @param {DOMRectReadOnly} options.panelRect - The .panel-item.
 * @param {DOMRectReadOnly} options.iframeRect
 * @param {object} options.state - The frame's PANELIZE_SNAPSHOT_STATE.
 * @param {ReturnType<typeof toRect>} options.visibleGrid
 * @returns {{left: number, right: number, top: number, headBottom: number,
 *   contentLeft: number, contentRight: number, zoom: number}}
 *   Columns of the cell, the panel header plus everything above the
 *   conversation (head), and the conversation's columns.
 */
export function getPanelCellGeometry({ panelRect, iframeRect, state, visibleGrid }) {
  const left = Math.max(panelRect.left, visibleGrid.left);
  const right = Math.min(panelRect.right, visibleGrid.right);
  const zoom = state.viewport?.width > 0 ? iframeRect.width / state.viewport.width : 1;
  const clip = state.clip;
  return {
    left,
    right,
    top: panelRect.top,
    headBottom: Math.min(panelRect.bottom, iframeRect.top + clip.top * zoom),
    contentLeft: Math.max(left, iframeRect.left + clip.left * zoom),
    contentRight: Math.min(right, iframeRect.left + clip.right * zoom),
    zoom
  };
}

/**
 * Output scale and the content height budget, in CSS pixels, for a stitched
 * grid of `gridWidth` CSS pixels.
 * @param {object} options
 * @param {number} options.frameScale - Captured pixels per CSS pixel.
 * @param {number} options.gridWidth
 * @param {(scale: number) => number} options.getChromeHeight - Frame height
 *   around the content, in output pixels.
 * @param {number} [options.maxOutputHeight]
 */
export function getStitchBudget({
  frameScale,
  gridWidth,
  getChromeHeight,
  maxOutputHeight = SNAPSHOT_MAX_OUTPUT_HEIGHT
}) {
  const scale = Math.min(frameScale, SNAPSHOT_MAX_CAPTURE_WIDTH / gridWidth);
  const chrome = getChromeHeight(scale);
  let height = Math.max(0, (maxOutputHeight - chrome) / scale);
  // Canvas limits only bite for unusual sizes, but must never be crossed.
  const fitted = fitCanvasScale(gridWidth, height, scale, {
    maxDimension: CANVAS_MAX_DIMENSION,
    maxArea: CANVAS_MAX_AREA
  });
  if (fitted < scale) {
    height = Math.floor(height * fitted / scale);
  }
  return { scale, contentHeight: Math.floor(height) };
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

/**
 * Crops page CSS rectangle `rect` from a whole-tab frame at `scale`.
 * `height` overrides the output height, e.g. to end a segment exactly where
 * the next one starts.
 * @param {object} [options]
 * @param {boolean} [options.inside] - Keep the top and bottom edges to rows
 *   wholly inside `rect`. A stitched screen of a page scaled to fit its
 *   panel starts and ends between rows, and the row it shares with the page's
 *   header or composer would show as a line at every seam.
 */
function cropPageRect(frame, rect, scale, height = Math.max(1, Math.round(rect.height * scale)), { inside = false } = {}) {
  const frameScaleX = frame.width / window.innerWidth;
  const frameScaleY = frame.height / window.innerHeight;
  // Round edges rather than sizes, so adjacent rectangles share their edge.
  const left = Math.round(rect.left * frameScaleX);
  const frameTop = rect.top * frameScaleY;
  const frameBottom = (rect.top + rect.height) * frameScaleY;
  // The margin keeps float error from dropping a whole row.
  const top = inside ? Math.ceil(frameTop - EDGE_EPSILON) : Math.round(frameTop);
  const bottom = inside ? Math.floor(frameBottom + EDGE_EPSILON) : Math.round(frameBottom);
  return createImageBitmap(
    frame,
    left,
    top,
    Math.max(1, Math.round((rect.left + rect.width) * frameScaleX) - left),
    Math.max(1, bottom - top),
    { resizeWidth: Math.max(1, Math.round(rect.width * scale)), resizeHeight: height, resizeQuality: 'high' }
  );
}

function sampleFillColor(bitmap) {
  if (!bitmap) {
    return null;
  }
  const height = Math.min(bitmap.height, FILL_SAMPLE_HEIGHT);
  const canvas = createCanvas(bitmap.width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, bitmap.height - height, bitmap.width, height, 0, 0, bitmap.width, height);
  return getDominantColor(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/**
 * Lines the panels up and hides floating buttons, fades and overlay
 * scrollbars. Stitching also un-sticks headings and always starts from the
 * latest turn.
 * @param {object} options
 * @param {string} options.prompt
 * @param {boolean} [options.stitch]
 * @param {boolean} [options.hideCursor] - Hide the pointer, which tab
 *   sharing can draw into the frames.
 */
async function prepareAll(bridge, panels, { prompt, stitch = false, hideCursor = false }, signal) {
  const states = await Promise.all(panels.map((panel) => bridge.request(
    panel.iframe,
    SNAPSHOT_MESSAGES.PREPARE,
    { align: Boolean(prompt), prompt: prompt || '', stitch, hideFloating: true, hideCursor },
    PREPARE_TIMEOUT_MS
  )));
  throwIfAborted(signal);
  return states;
}

function restoreAll(bridge, panels) {
  return Promise.all(panels.map((panel) => bridge.request(
    panel.iframe,
    SNAPSHOT_MESSAGES.RESTORE,
    {},
    RESTORE_TIMEOUT_MS
  )));
}

function isUsableState(state) {
  return Boolean(state && !state.error && state.clip && state.clip.bottom > state.clip.top);
}

/**
 * @typedef {object} SnapshotPanel
 * @property {string} id
 * @property {string} name - Provider name shown in notes.
 * @property {HTMLIFrameElement} iframe
 * @property {HTMLElement} element - The .panel-item.
 */

/**
 * @typedef {object} SnapshotCaptureResult
 * @property {CanvasImageSource & {width: number, height: number}} content
 * @property {number} scale - Output pixels per CSS pixel.
 * @property {string[]} names - Providers in the image, in grid order.
 * @property {string[]} currentViewOnly - Providers shown as on screen in full mode.
 * @property {string[]} outOfView - Open providers left out because they were
 *   not fully on screen, in grid order.
 * @property {string[]} truncated - Providers whose answer was cut short to
 *   fit the image, in grid order.
 * @property {string[]} interrupted - Providers whose page stopped answering
 *   or scrolling partway, so only the start of their answer is shown, in
 *   grid order.
 * @property {number} screens - Captures taken.
 * @property {SnapshotAlignment[]} alignment - Where each panel started and ended.
 */

/**
 * @typedef {object} SnapshotAlignment
 * @property {string} name
 * @property {'prompt' | 'user-turn' | 'top' | null} alignedBy - What the
 *   capture started from; null when the panel was left as it was.
 * @property {number | null} originalScrollTop
 * @property {number | null} startScrollTop
 * @property {number | null} endScrollTop
 * @property {number | null} maxScrollTop
 */

function describeAlignment(name, firstState, lastState = firstState) {
  const usable = isUsableState(firstState);
  return {
    name,
    alignedBy: usable ? firstState.alignedBy || null : null,
    originalScrollTop: usable ? firstState.originalScrollTop ?? null : null,
    startScrollTop: usable ? firstState.scrollTop : null,
    endScrollTop: isUsableState(lastState) ? lastState.scrollTop : null,
    maxScrollTop: isUsableState(lastState) ? lastState.maxScrollTop : null
  };
}

/** Panels to capture, the area around them and the names left out. */
function readPanels(panels, grid) {
  const visibleGrid = intersectRects(grid.getBoundingClientRect(), toRect({
    left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight
  }));
  const { captured, outOfView } = selectVisiblePanels(panels.map((panel) => ({
    ...panel,
    rect: panel.element.getBoundingClientRect(),
    hidden: !panel.element.isConnected || panel.element.checkVisibility?.() === false
  })), visibleGrid);
  return {
    captured,
    area: getCaptureArea(captured, visibleGrid),
    outOfView: orderByGrid(outOfView).map((panel) => panel.name)
  };
}

function orderByGrid(panels) {
  return groupCellsIntoRows(panels).flat();
}

/**
 * Current view: aligns each conversation on the prompt, then takes one frame
 * of the visible grid.
 * @param {object} options
 * @param {{grab: () => Promise<ImageBitmap>}} options.source
 * @param {HTMLElement} options.grid - #panel-grid.
 * @param {SnapshotPanel[]} options.panels
 * @param {string} options.prompt - Shared prompt to align on; '' leaves panels as they are.
 * @param {boolean} [options.hideCursor]
 * @param {(signal?: AbortSignal) => Promise<void>} [options.beforeGrab] - Runs
 *   before each frame, e.g. to wait for the pointer to keep still.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<SnapshotCaptureResult>}
 */
export async function captureCurrentView({
  source, grid, panels, prompt, hideCursor = false, beforeGrab = async () => {}, signal
}) {
  const bridge = createSnapshotBridge();
  const checkLayout = watchLayout(grid, panels);
  const { captured, area, outOfView } = readPanels(panels, grid);
  const visiblePanels = orderByGrid(captured);
  try {
    const states = await prepareAll(bridge, visiblePanels, { prompt, hideCursor }, signal);
    await beforeGrab(signal);
    const frame = await source.grab();
    try {
      throwIfAborted(signal);
      checkLayout();
      const { bitmap, scale } = await cropCapturedFrame(frame, area, {
        maxWidth: SNAPSHOT_MAX_CAPTURE_WIDTH
      });
      return {
        content: bitmap,
        scale,
        names: visiblePanels.map((panel) => panel.name),
        currentViewOnly: [],
        outOfView,
        truncated: [],
        interrupted: [],
        screens: 1,
        alignment: visiblePanels.map((panel, index) => describeAlignment(panel.name, states[index]))
      };
    } finally {
      frame.close?.();
    }
  } finally {
    await restoreAll(bridge, visiblePanels);
    bridge.dispose();
  }
}

/**
 * Full answers: stitches every visible panel's conversation from the
 * prompt down, one frame per lock-step scroll, within the output limits.
 * Panels whose page does not answer are shown as on screen.
 * @param {object} options
 * @param {{grab: () => Promise<ImageBitmap>}} options.source
 * @param {HTMLElement} options.grid
 * @param {SnapshotPanel[]} options.panels
 * @param {string} options.prompt
 * @param {(scale: number) => number} options.getChromeHeight - See getStitchBudget.
 * @param {boolean} [options.hideCursor]
 * @param {(signal?: AbortSignal) => Promise<void>} [options.beforeGrab] - Runs
 *   before each frame, e.g. to wait for the pointer to keep still.
 * @param {AbortSignal} [options.signal]
 * @param {(progress: {step: number, total: number}) => void} [options.onProgress]
 * @returns {Promise<SnapshotCaptureResult>}
 */
export async function captureFullAnswers({
  source, grid, panels, prompt, getChromeHeight, hideCursor = false, beforeGrab = async () => {}, signal,
  onProgress = () => {}
}) {
  const bridge = createSnapshotBridge();
  const checkLayout = watchLayout(grid, panels);
  const { captured: visiblePanels, area, outOfView } = readPanels(panels, grid);
  const bitmaps = [];
  try {
    const states = await prepareAll(bridge, visiblePanels, { prompt, stitch: true, hideCursor }, signal);
    await beforeGrab(signal);
    let frame = await source.grab();
    let screens = 1;
    try {
      throwIfAborted(signal);
      checkLayout();
      const frameScale = frame.width / window.innerWidth;
      const { scale, contentHeight: budget } = getStitchBudget({
        frameScale,
        gridWidth: area.width,
        getChromeHeight
      });

      // Head (panel header and anything above the conversation) comes from
      // the first frame; so does the whole panel when its page did not answer.
      const cells = await Promise.all(visiblePanels.map(async (panel, index) => {
        const state = states[index];
        const iframeRect = panel.iframe.getBoundingClientRect();
        const panelRect = panel.rect;
        if (!isUsableState(state)) {
          const rect = intersectRects(panelRect, area);
          const head = await cropPageRect(frame, rect, scale);
          bitmaps.push(head);
          return {
            panel, rect: { left: rect.left, top: panelRect.top, width: rect.width },
            fallback: true, headHeight: rect.height, head, track: null, segments: []
          };
        }
        const geometry = getPanelCellGeometry({ panelRect, iframeRect, state, visibleGrid: area });
        const headHeight = Math.max(0, geometry.headBottom - geometry.top);
        const head = headHeight > 0
          ? await cropPageRect(frame, toRect({
            left: geometry.left, top: geometry.top, right: geometry.right, bottom: geometry.headBottom
          }), scale)
          : null;
        if (head) {
          bitmaps.push(head);
        }
        return {
          panel,
          rect: { left: geometry.left, top: panelRect.top, width: geometry.right - geometry.left },
          fallback: false,
          geometry,
          iframeTop: iframeRect.top,
          headHeight,
          head,
          state,
          track: createStitchTrack(state),
          segments: []
        };
      }));

      // Pages scaled to fit their panel are measured in their own CSS pixels;
      // the image is planned in this page's.
      const zoomOf = (cell) => cell.geometry.zoom;

      // Caps per row so capturing stops once the image is full.
      const rows = groupCellsIntoRows(cells);
      const rowBudget = budget - STITCH_GRID_PADDING * 2 - STITCH_GRID_GAP * Math.max(0, rows.length - 1);
      const estimates = rows.map((row) => {
        const fixed = Math.max(...row.map((cell) => cell.headHeight));
        const content = Math.max(0, ...row.map((cell) => (
          cell.track ? cell.headHeight + getRemainingStitchHeight(cell.track) * zoomOf(cell) - fixed : 0
        )));
        return { fixed, content };
      });
      const planned = allocateRowContentHeights(estimates, rowBudget);
      const slack = planned.truncated
        ? 0
        : Math.max(0, rowBudget - estimates.reduce((sum, row) => sum + row.fixed + row.content, 0));
      rows.forEach((row, rowIndex) => {
        row.forEach((cell) => {
          if (cell.track) {
            // Cells with a taller head get less room for the conversation.
            const cap = Math.max(0, planned.caps[rowIndex] + slack + estimates[rowIndex].fixed - cell.headHeight);
            cell.track.cap = cap / zoomOf(cell);
          }
        });
      });

      const takeSegments = async (currentFrame, frameIndex, statesByCell) => {
        for (const cell of cells) {
          const state = statesByCell.get(cell);
          if (!cell.track || cell.track.done || !state) {
            continue;
          }
          const segment = addStitchScreen(cell.track, state, frameIndex);
          if (!segment) {
            continue;
          }
          const { geometry } = cell;
          const top = cell.iframeTop + segment.top * zoomOf(cell);
          const contentTop = segment.contentTop * zoomOf(cell);
          const height = segment.height * zoomOf(cell);
          // Rounded where it is drawn, so it ends where the next one starts.
          const bitmap = await cropPageRect(currentFrame, toRect({
            left: geometry.contentLeft,
            right: geometry.contentRight,
            top,
            bottom: top + height
          }), scale, Math.max(1, Math.round((contentTop + height) * scale) - Math.round(contentTop * scale)), { inside: true });
          bitmaps.push(bitmap);
          cell.segments.push({ bitmap, contentTop, height });
        }
      };

      const estimateTotal = () => screens + Math.max(0, ...cells.map((cell) => (
        cell.track && !cell.track.done
          ? Math.ceil(getRemainingStitchHeight(cell.track) / cell.track.step)
          : 0
      )));

      await takeSegments(frame, 0, new Map(cells.map((cell) => [cell, cell.state])));
      onProgress({ step: screens, total: estimateTotal() });

      while (screens < MAX_STITCH_SCREENS && cells.some((cell) => cell.track && !cell.track.done)) {
        throwIfAborted(signal);
        const active = cells.filter((cell) => cell.track && !cell.track.done);
        const nextStates = await Promise.all(active.map((cell) => bridge.request(
          cell.panel.iframe,
          SNAPSHOT_MESSAGES.SCROLL,
          { scrollTop: getNextStitchScrollTop(cell.track, cell.state) },
          SCROLL_TIMEOUT_MS
        )));
        throwIfAborted(signal);
        const statesByCell = new Map();
        active.forEach((cell, index) => {
          const state = nextStates[index];
          if (!isUsableState(state)) {
            // The page stopped answering (e.g. it navigated): keep what we
            // have and say it is not the whole answer.
            cell.track.done = true;
            cell.interrupted = true;
            return;
          }
          cell.state = state;
          statesByCell.set(cell, state);
        });
        if (statesByCell.size === 0) {
          break;
        }
        frame.close?.();
        await beforeGrab(signal);
        frame = await source.grab();
        throwIfAborted(signal);
        checkLayout();
        await takeSegments(frame, screens, statesByCell);
        screens += 1;
        onProgress({ step: screens, total: estimateTotal() });
      }

      const content = drawStitchedGrid({ cells, rows, area, scale, budget, grid });
      // Short of its end because the page stopped answering or scrolling.
      const isInterrupted = (cell) => Boolean(cell.interrupted || cell.track?.stalled);
      const isCut = (cell) => Boolean(cell.track)
        && (cell.track.truncated || !cell.track.done || content.cut.has(cell));
      return {
        content: content.canvas,
        scale,
        names: orderByGrid(cells).map((cell) => cell.panel.name),
        currentViewOnly: orderByGrid(cells).filter((cell) => cell.fallback).map((cell) => cell.panel.name),
        outOfView,
        truncated: orderByGrid(cells).filter((cell) => !isInterrupted(cell) && isCut(cell)).map((cell) => cell.panel.name),
        interrupted: orderByGrid(cells).filter(isInterrupted).map((cell) => cell.panel.name),
        screens,
        alignment: orderByGrid(cells).map((cell) => describeAlignment(
          cell.panel.name,
          states[visiblePanels.indexOf(cell.panel)],
          cell.state
        ))
      };
    } finally {
      frame.close?.();
    }
  } finally {
    bitmaps.forEach((bitmap) => bitmap.close?.());
    await restoreAll(bridge, visiblePanels);
    bridge.dispose();
  }
}

function getStitchedCellHeight(cell) {
  if (cell.fallback) {
    return cell.headHeight;
  }
  const content = cell.segments.reduce((end, segment) => Math.max(end, segment.contentTop + segment.height), 0);
  return cell.headHeight + content;
}

function drawStitchedGrid({ cells, rows, area, scale, budget, grid }) {
  // Fit what was actually captured, which can differ from the estimate.
  const rowBudget = budget - STITCH_GRID_PADDING * 2 - STITCH_GRID_GAP * Math.max(0, rows.length - 1);
  const fitted = allocateRowContentHeights(rows.map((row) => {
    const fixed = Math.max(...row.map((cell) => cell.headHeight));
    const content = Math.max(0, ...row.map((cell) => getStitchedCellHeight(cell) - fixed));
    return { fixed, content };
  }), rowBudget);
  // Cells taller than their row's cap lose the end of their answer.
  const cut = new Set();
  const layout = layoutStitchedGrid({
    rows: rows.map((row, rowIndex) => {
      const fixed = Math.max(...row.map((cell) => cell.headHeight));
      return row.map((cell) => {
        const full = getStitchedCellHeight(cell);
        const height = Math.min(full, fixed + fitted.caps[rowIndex]);
        if (height < full) {
          cut.add(cell);
        }
        return { rect: cell.rect, height };
      });
    }),
    gridLeft: area.left,
    gridWidth: area.width
  });

  const canvas = createCanvas(layout.width * scale, layout.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = window.getComputedStyle(grid).backgroundColor || '#e0e0e0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const px = (value) => Math.round(value * scale);

  rows.forEach((row, rowIndex) => {
    const placedRow = layout.rows[rowIndex];
    row.forEach((cell, cellIndex) => {
      const placed = placedRow.cells[cellIndex];
      const x = px(placed.x);
      const y = px(placed.y);
      const width = px(placed.width);
      const height = px(placed.height);
      const lastSegment = cell.segments[cell.segments.length - 1];
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, width, height);
      ctx.clip();
      // Below shorter answers, continue the page's own background.
      ctx.fillStyle = sampleFillColor(lastSegment?.bitmap || cell.head) || '#ffffff';
      ctx.fillRect(x, y, width, height);
      if (cell.head) {
        ctx.drawImage(cell.head, x, y, width, px(cell.headHeight));
      }
      if (!cell.fallback) {
        const contentX = x + px(cell.geometry.contentLeft - cell.rect.left);
        const contentY = y + px(cell.headHeight);
        cell.segments.forEach((segment) => {
          ctx.drawImage(segment.bitmap, contentX, contentY + px(segment.contentTop), segment.bitmap.width, segment.bitmap.height);
        });
      }
      ctx.restore();
    });
  });
  return { canvas, cut };
}
