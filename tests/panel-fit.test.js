import { describe, expect, it } from 'vitest';
import {
  PANEL_FIT_BOUNCE_MS,
  PANEL_FIT_MIN_SCALE,
  PANEL_FIT_TOLERANCE_PX,
  applyPanelFitScale,
  createPanelFitState,
  getPanelFitScale,
  getPanelPageWidth,
  updatePanelFitState
} from '../modules/panel-fit.js';

function fit(steps) {
  return steps.reduce((state, step) => updatePanelFitState(state, step), createPanelFitState());
}

describe('getPanelPageWidth', () => {
  it('keeps the panel width when the page fits or reports nothing', () => {
    expect(getPanelPageWidth(320, 0)).toBe(320);
    expect(getPanelPageWidth(320, 300)).toBe(320);
    expect(getPanelPageWidth(320, 320 + PANEL_FIT_TOLERANCE_PX)).toBe(320);
  });

  it('widens the page to what it needs', () => {
    expect(getPanelPageWidth(320, 375)).toBe(375);
    expect(getPanelPageWidth(320, 400.2)).toBe(401);
  });

  it('stops at the smallest scale', () => {
    expect(getPanelPageWidth(320, 1400)).toBe(320 / PANEL_FIT_MIN_SCALE);
  });

  it('ignores a panel with no width', () => {
    expect(getPanelPageWidth(0, 728)).toBe(0);
  });
});

describe('updatePanelFitState', () => {
  it('scales a page that needs more room down to the panel', () => {
    const state = fit([{ available: 320, needed: 375, now: 0 }]);
    expect(state.pageWidth).toBe(375);
    expect(getPanelFitScale(state)).toBeCloseTo(320 / 375);
  });

  it('gives the room back once the page no longer needs it', () => {
    const state = fit([
      { available: 320, needed: 728, now: 0 },
      { available: 320, needed: 468, now: 5000 }
    ]);
    expect(state.pageWidth).toBe(468);
    expect(fit([
      { available: 320, needed: 728, now: 0 },
      { available: 320, needed: 0, now: 5000 }
    ]).pageWidth).toBe(320);
  });

  it('holds the wider width for a page that flips between layouts', () => {
    const flipped = fit([
      { available: 320, needed: 400, now: 0 },
      { available: 320, needed: 0, now: 5000 },
      { available: 320, needed: 400, now: 5000 + PANEL_FIT_BOUNCE_MS - 1 }
    ]);
    expect(flipped.locked).toBe(true);
    const held = updatePanelFitState(flipped, { available: 320, needed: 0, now: 9000 });
    expect(held.pageWidth).toBe(400);
    expect(getPanelFitScale(held)).toBeCloseTo(0.8);
  });

  it('starts over when the panel width changes', () => {
    const locked = fit([
      { available: 320, needed: 400, now: 0 },
      { available: 320, needed: 0, now: 100 },
      { available: 320, needed: 400, now: 200 }
    ]);
    const resized = updatePanelFitState(locked, { available: 500, needed: 0, now: 300 });
    expect(resized.locked).toBe(false);
    expect(resized.pageWidth).toBe(500);
    expect(getPanelFitScale(resized)).toBe(1);
  });

  it('lets a slow change back to a wider layout through without locking', () => {
    const state = fit([
      { available: 320, needed: 400, now: 0 },
      { available: 320, needed: 0, now: 100 },
      { available: 320, needed: 400, now: 100 + PANEL_FIT_BOUNCE_MS }
    ]);
    expect(state.locked).toBe(false);
    expect(state.pageWidth).toBe(400);
  });
});

describe('applyPanelFitScale', () => {
  it('scales the frame only when the page is wider than the panel', () => {
    const iframe = document.createElement('iframe');
    applyPanelFitScale(iframe, 0.8);
    expect(iframe.classList.contains('panel-fitted')).toBe(true);
    expect(iframe.style.getPropertyValue('--panel-fit-scale')).toBe('0.8');
    applyPanelFitScale(iframe, 1);
    expect(iframe.classList.contains('panel-fitted')).toBe(false);
    expect(iframe.style.getPropertyValue('--panel-fit-scale')).toBe('');
  });
});
