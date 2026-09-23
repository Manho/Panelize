/**
 * Layout capacity table and auto-adjust rules for the multi-panel grid.
 * Kept separate from multi-panel.js so tests exercise the production logic.
 */

export const LAYOUT_PANEL_COUNTS = {
  '1x1': 1,
  '1x2': 2,
  '1x3': 3,
  '1x4': 4,
  '1x5': 5,
  '1x6': 6,
  '1x7': 7,
  '1x8': 8,
  '1x9': 9,
  '1x10': 10,
  '1x11': 11,
  '1x12': 12,
  '2x1': 2,
  '2x2': 4,
  '2x3': 6,
  '2x4': 8,
  '2x5': 10,
  '2x6': 12,
  '3x1': 3,
  '3x2': 6,
  '3x3': 9,
  '4x2': 8
};

/**
 * Calculates whether layout adjustment is needed based on current layout and panel count
 * Only auto-expands columns in 1xN layout sequence
 * @param {string} currentLayout - Current layout, e.g., '1x2'
 * @param {number} newPanelCount - Total panel count after adding
 * @returns {string|null} - New layout name, or null if no adjustment needed
 */
export function getAutoAdjustedLayout(currentLayout, newPanelCount) {
  if (currentLayout === '4x2' && newPanelCount === 9) {
    return '1x9';
  }

  // Only handle 1xN layouts.
  const match = currentLayout.match(/^1x(\d+)$/);
  if (!match) return null;

  const currentCols = parseInt(match[1]);
  const currentCapacity = LAYOUT_PANEL_COUNTS[currentLayout];

  // Keep the current layout while the new panel still fits.
  if (newPanelCount <= currentCapacity) return null;

  if (currentLayout === '1x7' && newPanelCount === 8) {
    return '4x2';
  }

  // Advance to the next 1xN layout.
  const nextCols = currentCols + 1;
  const nextLayout = `1x${nextCols}`;

  // 1x8 remains manual because auto-expand prefers 4x2 for the 8th panel.
  if (LAYOUT_PANEL_COUNTS[nextLayout]) {
    return nextLayout;
  }

  return null;
}

/**
 * Calculates whether layout shrink is needed based on current layout and panel count
 * Only auto-shrinks columns in 1xN layout sequence
 * @param {string} currentLayout - Current layout, e.g., '1x3'
 * @param {number} newPanelCount - Total panel count after removing
 * @returns {string|null} - New layout name, or null if no adjustment needed
 */
export function getAutoShrunkLayout(currentLayout, newPanelCount) {
  if (currentLayout === '1x9' && newPanelCount === 8) {
    return '4x2';
  }

  if (currentLayout === '4x2' && newPanelCount === 7) {
    return '1x7';
  }

  // Only handle 1xN layouts (consistent with auto-expand behavior)
  const match = currentLayout.match(/^1x(\d+)$/);
  if (!match) return null;

  const currentCols = parseInt(match[1]);

  // No need to shrink if panel count already matches or exceeds column count
  if (newPanelCount >= currentCols) return null;

  // Shrink to match panel count (minimum 1x1)
  const targetCols = Math.max(newPanelCount, 1);
  const targetLayout = `1x${targetCols}`;

  if (LAYOUT_PANEL_COUNTS[targetLayout]) {
    return targetLayout;
  }

  return null;
}
