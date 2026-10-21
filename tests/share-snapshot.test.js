import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_BRAND_NAME,
  SNAPSHOT_FONT_FAMILY,
  SNAPSHOT_FRAME_STYLES,
  SNAPSHOT_MAX_CAPTURE_WIDTH,
  SNAPSHOT_MAX_PROMPT_CHARS,
  SNAPSHOT_SITE_LABEL,
  composeSnapshot,
  formatProviderList,
  formatSnapshotMeta,
  getCaptureCrop,
  getSnapshotFileName,
  getSnapshotFrameChromeHeight,
  getSnapshotFrameLayout,
  getSnapshotFrameStyle,
  normalizePromptText,
  toLanguageTag,
  wrapTextLines
} from '../modules/share-snapshot.js';

/** Every character is 10px wide. */
const measure = (text) => Array.from(text).length * 10;

/** Records canvas calls so drawing can be asserted without a real canvas. */
function createRecordingCanvas() {
  const calls = [];
  const state = { font: '', fillStyle: '', textAlign: '', textBaseline: '', letterSpacing: '0px' };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === 'measureText') {
        return (text) => ({ width: measure(text) });
      }
      if (['fillRect', 'fillText', 'drawImage', 'arc', 'createLinearGradient', 'createRadialGradient'].includes(prop)) {
        if (prop.startsWith('create')) {
          return (...args) => {
            calls.push({ op: prop, args });
            return { addColorStop: () => {} };
          };
        }
        return (...args) => calls.push({
          op: prop,
          args,
          fillStyle: target.fillStyle,
          font: target.font
        });
      }
      if (prop in target) {
        return target[prop];
      }
      // Path, transform and state calls are not asserted.
      return () => {};
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

const FRAME = {
  light: SNAPSHOT_FRAME_STYLES.light,
  dark: SNAPSHOT_FRAME_STYLES.dark
};

describe('getSnapshotFrameLayout', () => {
  it('lays out theme A (light): brand row, prompt label, headline, card', () => {
    const style = FRAME.light;
    const layout = getSnapshotFrameLayout({
      contentWidth: 1392,
      contentHeight: 800,
      scale: 1,
      theme: 'light',
      titleLineCount: 1
    });

    expect(layout.style.variant).toBe('a');
    expect(layout.width).toBe(1392 + style.paddingX * 2);
    expect(layout.width).toBe(1520);
    expect(layout.brand).toMatchObject({ x: 64, y: 48, height: 34, iconSize: 34 });
    expect(layout.label).toMatchObject({ y: 48 + 34 + 40, height: 16 });
    expect(layout.title).toMatchObject({ y: 48 + 34 + 40 + 16 + 10, lineHeight: 45, height: 45, maxWidth: 1240 });
    expect(layout.subline).toBeNull();
    const cardY = layout.title.y + 45 + 32;
    expect(layout.card).toMatchObject({ x: 64, y: cardY, width: 1392, height: 800, titleBarHeight: 0, radius: 16 });
    expect(layout.content).toEqual({ x: 64, y: cardY, width: 1392, height: 800 });
    expect(layout.note).toBeNull();
    expect(layout.height).toBe(cardY + 800 + 56);
  });

  it('lays out theme B (dark): brand row, quoted headline, subline, window card', () => {
    const layout = getSnapshotFrameLayout({
      contentWidth: 1392,
      contentHeight: 800,
      scale: 1,
      theme: 'dark',
      titleLineCount: 2,
      hasSubline: true
    });

    expect(layout.style.variant).toBe('b');
    expect(layout.brand).toMatchObject({ y: 44, height: 34 });
    expect(layout.label).toBeNull();
    expect(layout.title).toMatchObject({ y: 44 + 34 + 36, lineHeight: 46, height: 92, maxWidth: 1200 });
    expect(layout.subline).toMatchObject({ y: layout.title.y + 92 + 12, height: 22 });
    const cardY = layout.subline.y + 22 + 34;
    expect(layout.card).toMatchObject({ y: cardY, height: 38 + 800, titleBarHeight: 38, radius: 18, dotSize: 12 });
    expect(layout.content.y).toBe(cardY + 38);
    expect(layout.height).toBe(cardY + 38 + 800 + 64);
  });

  it('scales every metric with the capture scale', () => {
    const one = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'dark', titleLineCount: 1, hasSubline: true });
    const two = getSnapshotFrameLayout({ contentWidth: 2000, contentHeight: 1000, scale: 2, theme: 'dark', titleLineCount: 1, hasSubline: true });
    expect(two.width).toBe(one.width * 2);
    expect(two.height).toBe(one.height * 2);
    expect(two.title.font).toContain(`${FRAME.dark.titleFontSize * 2}px`);
  });

  it('collapses the headline when the title is empty', () => {
    const light = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'light', titleLineCount: 0 });
    expect(light.label).toBeNull();
    expect(light.title).toBeNull();
    expect(light.card.y).toBe(48 + 34 + FRAME.light.cardGapWithoutHeadline);

    const dark = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'dark', titleLineCount: 0, hasSubline: true });
    expect(dark.title).toBeNull();
    // The subline stays and takes the headline's place under the brand row.
    expect(dark.subline.y).toBe(44 + 34 + FRAME.dark.sublineGapWithoutTitle);
  });

  it('drops the brand row with the watermark off but keeps headline and card', () => {
    const light = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'light', titleLineCount: 1, showWatermark: false });
    expect(light.brand).toBeNull();
    expect(light.label).toMatchObject({ y: 48 });
    expect(light.title).not.toBeNull();
    expect(light.card).not.toBeNull();

    const dark = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'dark', titleLineCount: 1, hasSubline: true, showWatermark: false });
    expect(dark.brand).toBeNull();
    expect(dark.title.y).toBe(44);
    expect(dark.card.titleBarHeight).toBe(38);

    const bare = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'light', showWatermark: false });
    expect(bare.card.y).toBe(48);
    expect(bare.height).toBe(48 + 500 + 56);
  });

  it('adds the truncation note under the card', () => {
    const layout = getSnapshotFrameLayout({ contentWidth: 1000, contentHeight: 500, scale: 1, theme: 'light', hasNote: true });
    expect(layout.note).toMatchObject({ y: layout.card.y + 500 + FRAME.light.noteGap, height: FRAME.light.noteLineHeight });
    expect(layout.height).toBe(layout.note.y + layout.note.height + 56);
  });

  it('reports the height the frame adds around content', () => {
    const options = { contentWidth: 1000, scale: 1, theme: 'dark', titleLineCount: 2, hasSubline: true };
    const chrome = getSnapshotFrameChromeHeight(options);
    expect(getSnapshotFrameLayout({ ...options, contentHeight: 700 }).height).toBe(chrome + 700);
  });
});

describe('getSnapshotFrameStyle', () => {
  it('follows the Panelize theme', () => {
    expect(getSnapshotFrameStyle('dark')).toBe(SNAPSHOT_FRAME_STYLES.dark);
    expect(getSnapshotFrameStyle('light')).toBe(SNAPSHOT_FRAME_STYLES.light);
    expect(getSnapshotFrameStyle(undefined)).toBe(SNAPSHOT_FRAME_STYLES.light);
    expect(FRAME.light.background).toBe('#F5F4F0');
    expect(FRAME.dark.background).toBe('#0E0F13');
  });

  it('uses a system font stack with CJK families', () => {
    expect(SNAPSHOT_FONT_FAMILY).toMatch(/^-apple-system/);
    expect(SNAPSHOT_FONT_FAMILY).toContain('"PingFang SC"');
    expect(SNAPSHOT_FONT_FAMILY).toContain('"Microsoft YaHei"');
    expect(SNAPSHOT_FONT_FAMILY).toContain('"Noto Sans CJK SC"');
    expect(SNAPSHOT_FONT_FAMILY.endsWith('sans-serif')).toBe(true);
  });
});

describe('composeSnapshot', () => {
  const content = { width: 1000, height: 500, id: 'content' };
  const icon = { width: 128, height: 128, id: 'icon' };
  const texts = (canvas) => canvas.calls.filter((call) => call.op === 'fillText').map((call) => call.args[0]);

  it('draws theme A with brand, tagline, meta, label, headline and content', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content,
      scale: 1,
      icon,
      title: 'Which answer is best?',
      theme: 'light',
      labelText: 'Prompt',
      taglineText: 'Compare AI side by side',
      metaText: '4 AIs · Oct 21, 2026'
    });

    expect(canvas.width).toBe(layout.width);
    expect(canvas.height).toBe(layout.height);
    expect(texts(canvas)).toEqual([
      SNAPSHOT_BRAND_NAME,
      '· Compare AI side by side',
      `4 AIs · Oct 21, 2026 · ${SNAPSHOT_SITE_LABEL}`,
      'PROMPT',
      'Which answer is best?'
    ]);
    const background = canvas.calls.find((call) => call.op === 'fillRect');
    expect(background).toMatchObject({ fillStyle: FRAME.light.background, args: [0, 0, layout.width, layout.height] });
    const images = canvas.calls.filter((call) => call.op === 'drawImage');
    expect(images[0].args[0]).toBe(icon);
    expect(images[1].args).toEqual([content, layout.content.x, layout.content.y, 1000, 500]);
  });

  it('draws theme B with quotes, the provider subline and window dots', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content,
      scale: 1,
      icon,
      title: 'Which answer is best?',
      theme: 'dark',
      taglineText: 'ignored in B',
      metaText: 'ignored in B',
      sublineText: 'Same prompt · ChatGPT, Claude · side by side'
    });

    const drawn = canvas.calls.filter((call) => call.op === 'fillText');
    expect(drawn.map((call) => call.args[0])).toEqual([
      SNAPSHOT_BRAND_NAME,
      SNAPSHOT_SITE_LABEL,
      '“',
      'Which answer is best?',
      '”',
      'Same prompt · ChatGPT, Claude · side by side'
    ]);
    expect(drawn[2].fillStyle).toBe(FRAME.dark.openQuoteColor);
    expect(drawn[4].fillStyle).toBe(FRAME.dark.closeQuoteColor);
    expect(canvas.calls.filter((call) => call.op === 'arc')).toHaveLength(3);
    expect(layout.content.y).toBe(layout.card.y + 38);
  });

  it('wraps long titles to at most three lines inside the headline width', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content: { width: 2000, height: 300 },
      scale: 1,
      title: 'word '.repeat(300),
      theme: 'light',
      showWatermark: false
    });
    const lines = texts(canvas);
    expect(lines).toHaveLength(3);
    expect(lines[2].endsWith('…')).toBe(true);
    lines.forEach((line) => expect(measure(line)).toBeLessThanOrEqual(FRAME.light.titleMaxWidth));
    expect(layout.title.lineCount).toBe(3);
  });

  it('wraps CJK titles per character', () => {
    const canvas = createRecordingCanvas();
    composeSnapshot(canvas, {
      content: { width: 2000, height: 300 },
      scale: 1,
      title: '请比较'.repeat(150),
      theme: 'light',
      showWatermark: false
    });
    const lines = texts(canvas);
    expect(lines).toHaveLength(3);
    expect(Array.from(lines[0])).toHaveLength(FRAME.light.titleMaxWidth / 10);
    expect(lines[2].endsWith('…')).toBe(true);
  });

  it('collapses the headline for an empty title', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content,
      scale: 1,
      title: '   ',
      theme: 'light',
      labelText: 'Prompt',
      showWatermark: true
    });
    expect(layout.title).toBeNull();
    expect(texts(canvas)).not.toContain('PROMPT');
  });

  it('draws no brand, site label or meta with the watermark off', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content,
      scale: 1,
      icon,
      title: 'Still here',
      theme: 'light',
      labelText: 'Prompt',
      taglineText: 'Compare AI side by side',
      metaText: '4 AIs · Oct 21, 2026',
      showWatermark: false
    });
    expect(layout.brand).toBeNull();
    expect(texts(canvas)).toEqual(['PROMPT', 'Still here']);
    const images = canvas.calls.filter((call) => call.op === 'drawImage');
    expect(images.map((call) => call.args[0])).toEqual([content]);
  });

  it('fades the content bottom and draws the note when truncated', () => {
    const canvas = createRecordingCanvas();
    const layout = composeSnapshot(canvas, {
      content,
      scale: 1,
      theme: 'dark',
      showWatermark: false,
      noteText: 'Long answers truncated'
    });
    expect(texts(canvas)).toEqual(['Long answers truncated']);
    expect(canvas.calls.some((call) => call.op === 'createLinearGradient')).toBe(true);
    expect(layout.note).not.toBeNull();
  });
});

describe('format helpers', () => {
  it('formats the meta line with a localized date', () => {
    expect(formatSnapshotMeta({ countText: '4 AIs', date: new Date(2026, 9, 21), locale: 'en-US' }))
      .toBe('4 AIs · Oct 21, 2026');
    expect(formatSnapshotMeta({ countText: '4 个 AI', date: new Date(2026, 9, 21), locale: 'zh-CN' }))
      .toBe('4 个 AI · 2026年10月21日');
  });

  it('lists provider names once, in order', () => {
    expect(formatProviderList(['ChatGPT', 'Claude', 'ChatGPT', 'Gemini'], 'en')).toBe('ChatGPT, Claude, and Gemini');
    expect(formatProviderList(['ChatGPT', 'Claude', 'Gemini'], 'zh-CN')).toBe('ChatGPT、Claude和Gemini');
  });

  it('converts extension locale ids to language tags', () => {
    expect(toLanguageTag('zh_CN')).toBe('zh-CN');
    expect(toLanguageTag('en')).toBe('en');
    expect(toLanguageTag('')).toBeUndefined();
  });
});

describe('getSnapshotFileName', () => {
  it('uses a sortable local timestamp', () => {
    expect(getSnapshotFileName(new Date(2026, 9, 20, 9, 5, 3))).toBe('panelize-comparison-20261020-090503.png');
  });
});
