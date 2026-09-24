import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  LAYOUT_PANEL_COUNTS,
  getAutoAdjustedLayout,
  getAutoShrunkLayout
} from '../modules/layout-auto-adjust.js';

describe('LAYOUT_PANEL_COUNTS', () => {
  it('covers every layout offered by the multi-panel layout picker', () => {
    const html = readFileSync(resolve(process.cwd(), 'multi-panel/multi-panel.html'), 'utf8');
    const pickerLayouts = [...new Set([...html.matchAll(/data-layout="([^"]+)"/g)].map(([, layout]) => layout))];

    expect(pickerLayouts.length).toBeGreaterThan(0);
    expect(Object.keys(LAYOUT_PANEL_COUNTS).sort()).toEqual(pickerLayouts.sort());
  });

  it('matches rows x columns for every layout', () => {
    for (const [layout, count] of Object.entries(LAYOUT_PANEL_COUNTS)) {
      const [rows, cols] = layout.split('x').map(Number);
      expect(count, layout).toBe(rows * cols);
    }
  });
});

describe('Layout Auto-Adjust', () => {
  describe('getAutoAdjustedLayout', () => {
    describe('1xN layout sequence', () => {
      it('should upgrade from 1x2 to 1x3 when adding 3rd panel', () => {
        expect(getAutoAdjustedLayout('1x2', 3)).toBe('1x3');
      });

      it('should upgrade from 1x3 to 1x4 when adding 4th panel', () => {
        expect(getAutoAdjustedLayout('1x3', 4)).toBe('1x4');
      });

      it('should upgrade from 1x4 to 1x5 when adding 5th panel', () => {
        expect(getAutoAdjustedLayout('1x4', 5)).toBe('1x5');
      });

      it('should upgrade from 1x5 to 1x6 when adding 6th panel', () => {
        expect(getAutoAdjustedLayout('1x5', 6)).toBe('1x6');
      });

      it('should upgrade from 1x6 to 1x7 when adding 7th panel', () => {
        expect(getAutoAdjustedLayout('1x6', 7)).toBe('1x7');
      });

      it('should upgrade from 1x7 to 4x2 when adding 8th panel', () => {
        expect(getAutoAdjustedLayout('1x7', 8)).toBe('4x2');
      });

      it('should upgrade from 4x2 to 1x9 when adding 9th panel', () => {
        expect(getAutoAdjustedLayout('4x2', 9)).toBe('1x9');
      });

      it('should upgrade from 1x9 to 1x10 when adding 10th panel', () => {
        expect(getAutoAdjustedLayout('1x9', 10)).toBe('1x10');
      });

      it('should upgrade from 1x10 to 1x11 when adding 11th panel', () => {
        expect(getAutoAdjustedLayout('1x10', 11)).toBe('1x11');
      });

      it('should upgrade from 1x11 to 1x12 when adding 12th panel', () => {
        expect(getAutoAdjustedLayout('1x11', 12)).toBe('1x12');
      });

      it('should NOT upgrade when panel count fits within capacity', () => {
        expect(getAutoAdjustedLayout('1x2', 2)).toBeNull();
        expect(getAutoAdjustedLayout('1x3', 3)).toBeNull();
        expect(getAutoAdjustedLayout('1x4', 4)).toBeNull();
        expect(getAutoAdjustedLayout('1x5', 5)).toBeNull();
        expect(getAutoAdjustedLayout('1x6', 6)).toBeNull();
        expect(getAutoAdjustedLayout('1x7', 7)).toBeNull();
      });

      it('should NOT upgrade when adding within capacity', () => {
        // 1x2 布局，只有 1 个面板，添加第 2 个时不需要升级
        expect(getAutoAdjustedLayout('1x2', 2)).toBeNull();
        // 1x3 布局，只有 2 个面板，添加第 3 个时不需要升级
        expect(getAutoAdjustedLayout('1x3', 3)).toBeNull();
      });
    });

    describe('upper limit', () => {
      it('should return null when already at the 1x12 maximum', () => {
        expect(getAutoAdjustedLayout('1x12', 13)).toBeNull();
      });
    });

    describe('non-1xN layouts', () => {
      it('should return null for 2xN layouts', () => {
        expect(getAutoAdjustedLayout('2x2', 5)).toBeNull();
        expect(getAutoAdjustedLayout('2x3', 7)).toBeNull();
      });

      it('should return null for 3xN layouts', () => {
        expect(getAutoAdjustedLayout('3x1', 4)).toBeNull();
        expect(getAutoAdjustedLayout('3x2', 7)).toBeNull();
      });

      it('should return null for 2x1 layout', () => {
        expect(getAutoAdjustedLayout('2x1', 3)).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should handle 1x1 layout correctly', () => {
        expect(getAutoAdjustedLayout('1x1', 2)).toBe('1x2');
        expect(getAutoAdjustedLayout('1x1', 1)).toBeNull();
      });

      it('should return null for invalid layouts', () => {
        expect(getAutoAdjustedLayout('invalid', 3)).toBeNull();
        expect(getAutoAdjustedLayout('', 3)).toBeNull();
        expect(getAutoAdjustedLayout('1x12', 13)).toBeNull();
      });
    });
  });

  describe('getAutoShrunkLayout', () => {
    describe('1xN layout sequence', () => {
      it('should shrink from 1x3 to 1x2 when removing panel (3 -> 2)', () => {
        expect(getAutoShrunkLayout('1x3', 2)).toBe('1x2');
      });

      it('should shrink from 1x2 to 1x1 when removing panel (2 -> 1)', () => {
        expect(getAutoShrunkLayout('1x2', 1)).toBe('1x1');
      });

      it('should shrink from 1x4 to 1x3 when removing panel (3 panels remain)', () => {
        expect(getAutoShrunkLayout('1x4', 3)).toBe('1x3');
      });

      it('should shrink from 1x5 to 1x4 when removing panel (4 panels remain)', () => {
        expect(getAutoShrunkLayout('1x5', 4)).toBe('1x4');
      });

      it('should shrink from 1x6 to 1x5 when removing panel (5 panels remain)', () => {
        expect(getAutoShrunkLayout('1x6', 5)).toBe('1x5');
      });

      it('should shrink from 1x7 to 1x6 when removing panel (6 panels remain)', () => {
        expect(getAutoShrunkLayout('1x7', 6)).toBe('1x6');
      });

      it('should shrink from 1x8 to 1x7 when removing panel (7 panels remain)', () => {
        expect(getAutoShrunkLayout('1x8', 7)).toBe('1x7');
      });

      it('should shrink from 4x2 to 1x7 when removing panel (7 panels remain)', () => {
        expect(getAutoShrunkLayout('4x2', 7)).toBe('1x7');
      });

      it('should shrink from 1x10 to 1x9 when removing panel (9 panels remain)', () => {
        expect(getAutoShrunkLayout('1x10', 9)).toBe('1x9');
      });

      it('should shrink from 1x11 to 1x10 when removing panel (10 panels remain)', () => {
        expect(getAutoShrunkLayout('1x11', 10)).toBe('1x10');
      });

      it('should shrink from 1x12 to 1x11 when removing panel (11 panels remain)', () => {
        expect(getAutoShrunkLayout('1x12', 11)).toBe('1x11');
      });

      it('should shrink from 1x9 to 4x2 when removing panel (8 panels remain)', () => {
        expect(getAutoShrunkLayout('1x9', 8)).toBe('4x2');
      });
    });

    describe('no shrink needed', () => {
      it('should NOT shrink when panel count matches column count', () => {
        expect(getAutoShrunkLayout('1x3', 3)).toBeNull();
        expect(getAutoShrunkLayout('1x2', 2)).toBeNull();
        expect(getAutoShrunkLayout('1x1', 1)).toBeNull();
      });

      it('should NOT shrink when panel count exceeds column count', () => {
        // e.g., in 1x2 layout but has 3 panels (should not happen in practice)
        expect(getAutoShrunkLayout('1x2', 3)).toBeNull();
        expect(getAutoShrunkLayout('1x3', 4)).toBeNull();
      });

      it('should maintain minimum 1x1 layout', () => {
        // Already at minimum, can't shrink further
        expect(getAutoShrunkLayout('1x1', 1)).toBeNull();
      });
    });

    describe('non-1xN layouts', () => {
      it('should return null for 2xN layouts (no auto-shrink)', () => {
        expect(getAutoShrunkLayout('2x2', 2)).toBeNull();
        expect(getAutoShrunkLayout('2x3', 4)).toBeNull();
      });

      it('should return null for 3xN layouts (no auto-shrink)', () => {
        expect(getAutoShrunkLayout('3x1', 2)).toBeNull();
        expect(getAutoShrunkLayout('3x2', 5)).toBeNull();
      });
    });

    describe('edge cases', () => {
      it('should return null for invalid layouts', () => {
        expect(getAutoShrunkLayout('invalid', 2)).toBeNull();
        expect(getAutoShrunkLayout('', 1)).toBeNull();
        expect(getAutoShrunkLayout('2x1', 1)).toBeNull();
      });

      it('should shrink to 1x1 when going from 2 panels to 1', () => {
        expect(getAutoShrunkLayout('1x2', 1)).toBe('1x1');
      });

      it('should shrink to 1x1 when going from 3 panels to 1', () => {
        expect(getAutoShrunkLayout('1x3', 1)).toBe('1x1');
      });
    });
  });
});
