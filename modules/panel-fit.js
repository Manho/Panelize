/**
 * Fit-to-width for provider pages that are wider than their panel.
 *
 * The provider frame reports the width its layout needs (PANELIZE_PAGE_WIDTH).
 * When that is wider than the panel, the iframe is given that width and scaled
 * down to the panel, so the page lays out at a real, wider viewport (media
 * queries, vw/vh and fixed elements keep working) and nothing is cut off.
 */

/** Pages are never shrunk below this; wider overflow stays cut. */
export const PANEL_FIT_MIN_SCALE = 0.4;
/** Overflow up to this many pixels is left alone. */
export const PANEL_FIT_TOLERANCE_PX = 4;
/**
 * A page that needs more room again this soon after being given less is
 * flipping between layouts; it keeps the wider width until the panel resizes.
 */
export const PANEL_FIT_BOUNCE_MS = 1500;

/**
 * @param {number} available - Panel content width in CSS pixels.
 * @param {number} needed - Width the page reports it needs; 0 when unknown.
 * @returns {number} Width to lay the page out at.
 */
export function getPanelPageWidth(available, needed) {
  if (!(available > 0) || !(needed > available + PANEL_FIT_TOLERANCE_PX)) {
    return available;
  }
  return Math.min(Math.ceil(needed), Math.floor(available / PANEL_FIT_MIN_SCALE));
}

/** @returns {{available: number, pageWidth: number, shrunkAt: number, locked: boolean}} */
export function createPanelFitState() {
  return { available: 0, pageWidth: 0, shrunkAt: -Infinity, locked: false };
}

/**
 * @param {ReturnType<typeof createPanelFitState>} state
 * @param {{available: number, needed: number, now: number}} input
 * @returns {ReturnType<typeof createPanelFitState>}
 */
export function updatePanelFitState(state, { available, needed, now }) {
  const next = { ...state };
  if (available !== state.available) {
    Object.assign(next, createPanelFitState(), { available, pageWidth: state.pageWidth });
  }
  const target = getPanelPageWidth(available, needed);
  if (target < next.pageWidth && available === state.available) {
    if (next.locked) {
      return next;
    }
    next.shrunkAt = now;
  } else if (target > next.pageWidth && now - next.shrunkAt < PANEL_FIT_BOUNCE_MS) {
    next.locked = true;
  }
  next.pageWidth = target;
  return next;
}

/** @returns {number} Scale the page is drawn at, 1 when it fits. */
export function getPanelFitScale(state) {
  if (!(state.available > 0) || !(state.pageWidth > state.available)) {
    return 1;
  }
  return state.available / state.pageWidth;
}

/**
 * @param {HTMLIFrameElement} iframe
 * @param {number} scale
 */
export function applyPanelFitScale(iframe, scale) {
  if (scale < 1) {
    iframe.style.setProperty('--panel-fit-scale', String(scale));
    iframe.classList.add('panel-fitted');
  } else {
    iframe.style.removeProperty('--panel-fit-scale');
    iframe.classList.remove('panel-fitted');
  }
}
