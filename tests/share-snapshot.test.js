import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_MAX_CAPTURE_WIDTH,
  SNAPSHOT_MAX_PROMPT_CHARS,
  SNAPSHOT_SITE_LABEL,
  SNAPSHOT_THEMES,
  composeSnapshot,
  getCaptureCrop,
  getSnapshotFileName,
  getSnapshotLayout,
  getSnapshotTheme,
  normalizePromptText,
  wrapTextLines
} from '../modules/share-snapshot.js';

/** Every character is 10px wide. */
const measure = (text) => Array.from(text).length * 10;

/** Records canvas calls so drawing can be asserted without a real canvas. */
function createRecordingCanvas() {
  const calls = [];
  const state = { font: '', fillStyle: '', textAlign: '', textBaseline: '' };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'measureText') {
        return (text) => ({ width: measure(text) });
      }
      if (['fillRect', 'fillText', 'drawImage'].includes(prop)) {
        return (...args) => calls.push({
          op: prop,
          args,
          fillStyle: target.fillStyle,
          font: target.font
        });
      }
      return target[prop];
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
  return {
    calls,
    width: 0,
    height: 0,
    getContext: () => ctx
  };
}

describe('normalizePromptText', () => {
  it('collapses whitespace and newlines', () => {
    expect(normalizePromptText('  Compare\n\nthese\tanswers  ')).toBe('Compare these answers');
  });

  it('caps very long prompts with an ellipsis', () => {
    const result = normalizePromptText('a'.repeat(SNAPSHOT_MAX_PROMPT_CHARS + 50));
    expect(Array.from(result)).toHaveLength(SNAPSHOT_MAX_PROMPT_CHARS + 1);
    expect(result.endsWith('…')).toBe(true);
  });

  it('counts emoji and CJK as single characters', () => {
    expect(normalizePromptText('你好😀世界', 3)).toBe('你好😀…');
  });

  it('handles empty input', () => {
    expect(normalizePromptText(undefined)).toBe('');
    expect(normalizePromptText('   ')).toBe('');
  });
});

describe('wrapTextLines', () => {
  it('keeps short text on one line', () => {
    expect(wrapTextLines('Hello world', 200, measure)).toEqual(['Hello world']);
  });

  it('wraps at word boundaries', () => {
    expect(wrapTextLines('one two three four', 90, measure)).toEqual(['one two', 'three', 'four']);
  });

  it('truncates the last allowed line with an ellipsis', () => {
    const lines = wrapTextLines('alpha beta gamma delta epsilon zeta', 110, measure, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('alpha beta');
    expect(lines[1].endsWith('…')).toBe(true);
    expect(measure(lines[1])).toBeLessThanOrEqual(110);
  });

  it('breaks CJK text per character', () => {
    const lines = wrapTextLines('比较不同的人工智能回答', 50, measure, 3);
    expect(lines).toEqual(['比较不同的', '人工智能回', '答']);
  });

  it('breaks a single word wider than the line', () => {
    const lines = wrapTextLines('x'.repeat(25), 100, measure, 3);
    expect(lines).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('returns no lines for empty text', () => {
    expect(wrapTextLines('', 100, measure)).toEqual([]);
  });
});

describe('getCaptureCrop', () => {
  const rect = { left: 0, top: 52, width: 1280, height: 600 };

  it('maps CSS pixels onto a high-DPI frame', () => {
    expect(getCaptureCrop({
      frameWidth: 2560,
      frameHeight: 1600,
      viewportWidth: 1280,
      viewportHeight: 800,
      rect
    })).toEqual({ sx: 0, sy: 104, sw: 2560, sh: 1200, width: 2560, height: 1200, scale: 2 });
  });

  it('downscales captures wider than the cap', () => {
    const crop = getCaptureCrop({
      frameWidth: 4050,
      frameHeight: 2592,
      viewportWidth: 1200,
      viewportHeight: 768,
      rect: { left: 0, top: 0, width: 1200, height: 768 }
    });
    expect(crop.sw).toBe(4050);
    expect(crop.width).toBe(SNAPSHOT_MAX_CAPTURE_WIDTH);
    expect(crop.height).toBe(Math.round(2592 * (SNAPSHOT_MAX_CAPTURE_WIDTH / 4050)));
    expect(crop.scale).toBeCloseTo(SNAPSHOT_MAX_CAPTURE_WIDTH / 1200);
  });

  it('clamps the area to the viewport', () => {
    const crop = getCaptureCrop({
      frameWidth: 1000,
      frameHeight: 500,
      viewportWidth: 1000,
      viewportHeight: 500,
      rect: { left: -10, top: 400, width: 1100, height: 300 }
    });
    expect(crop).toMatchObject({ sx: 0, sy: 400, sw: 1000, sh: 100 });
  });

  it('rejects empty frames and areas outside the viewport', () => {
    expect(() => getCaptureCrop({
      frameWidth: 0, frameHeight: 0, viewportWidth: 100, viewportHeight: 100, rect
    })).toThrow('no size');
    expect(() => getCaptureCrop({
      frameWidth: 100, frameHeight: 100, viewportWidth: 100, viewportHeight: 100,
      rect: { left: 0, top: 200, width: 100, height: 50 }
    })).toThrow('outside the viewport');
  });
});

describe('getSnapshotLayout', () => {
  it('stacks prompt strip, capture and watermark strip', () => {
    const layout = getSnapshotLayout({
      captureWidth: 2000,
      captureHeight: 1000,
      scale: 2,
      promptLineCount: 2,
      showWatermark: true
    });

    expect(layout.header).toMatchObject({ y: 0, height: (12 * 2 + 22 * 2) * 2 });
    expect(layout.capture).toEqual({ x: 0, y: 136, width: 2000, height: 1000 });
    expect(layout.footer).toMatchObject({ y: 1136, height: 88, iconSize: 40 });
    expect(layout.width).toBe(2000);
    expect(layout.height).toBe(136 + 1000 + 88);
    expect(layout.maxTextWidth).toBe(2000 - 64);
  });

  it('omits the prompt strip without a prompt and the watermark when disabled', () => {
    const layout = getSnapshotLayout({
      captureWidth: 800,
      captureHeight: 600,
      scale: 1,
      promptLineCount: 0,
      showWatermark: false
    });
    expect(layout.header).toBeNull();
    expect(layout.footer).toBeNull();
    expect(layout.capture).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(layout.height).toBe(600);
  });
});

describe('getSnapshotTheme', () => {
  it('matches the comparison page colors', () => {
    expect(getSnapshotTheme('dark')).toBe(SNAPSHOT_THEMES.dark);
    expect(getSnapshotTheme('light')).toBe(SNAPSHOT_THEMES.light);
    expect(getSnapshotTheme(undefined)).toBe(SNAPSHOT_THEMES.light);
    expect(SNAPSHOT_THEMES.light.surface).toBe('#ffffff');
    expect(SNAPSHOT_THEMES.dark.surface).toBe('#2d2d2d');
  });
});

describe('composeSnapshot', () => {
  const capture = { width: 1000, height: 500, id: 'capture' };
  const icon = { width: 128, height: 128, id: 'icon' };

  it('draws the prompt, the capture and the Panelize strip', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      capture,
      scale: 1,
      icon,
      prompt: 'Which answer is best?',
      theme: 'dark',
      showWatermark: true,
      footerText: 'Compared with Panelize'
    });

    expect(canvas.width).toBe(1000);
    expect(canvas.height).toBe(layout.height);
    expect(layout.header).not.toBeNull();
    expect(layout.footer).not.toBeNull();

    const texts = canvas.calls.filter((call) => call.op === 'fillText');
    expect(texts.map((call) => call.args[0])).toEqual([
      'Which answer is best?',
      'Compared with Panelize',
      ` · ${SNAPSHOT_SITE_LABEL}`
    ]);
    expect(texts[0].fillStyle).toBe(SNAPSHOT_THEMES.dark.text);
    expect(texts[2].fillStyle).toBe(SNAPSHOT_THEMES.dark.muted);

    const images = canvas.calls.filter((call) => call.op === 'drawImage');
    expect(images[0].args).toEqual([capture, 0, layout.capture.y, 1000, 500]);
    expect(images[1].args[0]).toBe(icon);

    const backgrounds = canvas.calls.filter((call) => call.op === 'fillRect');
    expect(backgrounds[0]).toMatchObject({ fillStyle: SNAPSHOT_THEMES.dark.surface });
  });

  it('wraps long prompts to at most three lines', () => {
    const canvas = createRecordingCanvas();
    composeSnapshot(canvas, {
      capture: { width: 400, height: 300 },
      scale: 1,
      prompt: 'word '.repeat(200),
      showWatermark: false,
      footerText: 'Compared with Panelize'
    });
    const texts = canvas.calls.filter((call) => call.op === 'fillText').map((call) => call.args[0]);
    expect(texts).toHaveLength(3);
    expect(texts[2].endsWith('…')).toBe(true);
    texts.forEach((text) => expect(measure(text)).toBeLessThanOrEqual(400 - 32));
  });

  it('draws only the capture without prompt or watermark', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      capture,
      scale: 1,
      prompt: '   ',
      showWatermark: false,
      footerText: 'Compared with Panelize'
    });
    expect(layout.height).toBe(500);
    expect(canvas.calls.map((call) => call.op)).toEqual(['drawImage']);
  });
});

describe('getSnapshotFileName', () => {
  it('uses a sortable local timestamp', () => {
    expect(getSnapshotFileName(new Date(2026, 9, 20, 9, 5, 3))).toBe('panelize-comparison-20261020-090503.png');
  });
});
