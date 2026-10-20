// Share snapshot composition: lays out a captured comparison between a prompt
// strip and an optional Panelize branding strip, then draws it on a 2D canvas
// context. Everything is pure or takes its canvas from the caller, so the
// layout can be unit tested without a browser.

export const SNAPSHOT_SITE_LABEL = 'panelize.dev';

/** Longest prompt kept before measuring; the strip shows at most a few lines anyway. */
export const SNAPSHOT_MAX_PROMPT_CHARS = 400;

export const SNAPSHOT_MAX_PROMPT_LINES = 3;

/** Widest capture kept in the image, in device pixels. */
export const SNAPSHOT_MAX_CAPTURE_WIDTH = 2560;

const ELLIPSIS = '…';

const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Strip metrics in CSS pixels; multiplied by the capture scale when drawn. */
export const SNAPSHOT_METRICS = Object.freeze({
  paddingX: 16,
  headerPaddingY: 12,
  promptFontSize: 15,
  promptLineHeight: 22,
  footerHeight: 44,
  footerFontSize: 14,
  iconSize: 20,
  iconGap: 8,
  borderWidth: 1
});

/** Colors match multi-panel.css for the light and dark themes. */
export const SNAPSHOT_THEMES = Object.freeze({
  light: Object.freeze({
    surface: '#ffffff',
    border: '#e0e0e0',
    text: '#333333',
    muted: '#666666'
  }),
  dark: Object.freeze({
    surface: '#2d2d2d',
    border: '#444444',
    text: '#e0e0e0',
    muted: '#aaaaaa'
  })
});

/**
 * @param {string} theme - 'light' or 'dark'.
 */
export function getSnapshotTheme(theme) {
  return theme === 'dark' ? SNAPSHOT_THEMES.dark : SNAPSHOT_THEMES.light;
}

/**
 * Collapses whitespace so a multi-paragraph prompt reads as one line of text,
 * and caps its length before it is measured.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function normalizePromptText(text, maxChars = SNAPSHOT_MAX_PROMPT_CHARS) {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  if (chars.length <= maxChars) {
    return collapsed;
  }
  return `${chars.slice(0, maxChars).join('').trimEnd()}${ELLIPSIS}`;
}

function splitIntoTokens(text) {
  // Words keep their trailing space; CJK and other unspaced scripts break per
  // character, which is where browsers may wrap them too.
  return text.match(/[　-鿿가-힯豈-﫿＀-￯]|[^\s　-鿿가-힯豈-﫿＀-￯]+\s*|\s+/g) || [];
}

function fitWithEllipsis(text, maxWidth, measure) {
  const chars = Array.from(text.trimEnd());
  while (chars.length > 0 && measure(`${chars.join('')}${ELLIPSIS}`) > maxWidth) {
    chars.pop();
  }
  return `${chars.join('').trimEnd()}${ELLIPSIS}`;
}

function breakLongToken(token, maxWidth, measure) {
  const pieces = [];
  let piece = '';
  for (const char of Array.from(token)) {
    if (piece && measure(piece + char) > maxWidth) {
      pieces.push(piece);
      piece = char;
    } else {
      piece += char;
    }
  }
  if (piece) {
    pieces.push(piece);
  }
  return pieces;
}

/**
 * Wraps text into at most `maxLines` lines no wider than `maxWidth`. When text
 * is left over, the last line ends with an ellipsis.
 * @param {string} text
 * @param {number} maxWidth
 * @param {(text: string) => number} measure - Width of a string, e.g. ctx.measureText.
 * @param {number} [maxLines]
 * @returns {string[]}
 */
export function wrapTextLines(text, maxWidth, measure, maxLines = SNAPSHOT_MAX_PROMPT_LINES) {
  if (!text || maxLines < 1) {
    return [];
  }

  const tokens = splitIntoTokens(text).flatMap((token) => (
    measure(token.trimEnd()) > maxWidth ? breakLongToken(token, maxWidth, measure) : [token]
  ));

  const lines = [];
  let line = '';
  let index = 0;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    const candidate = line + token;
    if (line && measure(candidate.trimEnd()) > maxWidth) {
      lines.push(line.trimEnd());
      if (lines.length === maxLines) {
        break;
      }
      line = token.trimStart();
    } else {
      line = candidate;
    }
  }

  if (lines.length < maxLines) {
    if (line.trim()) {
      lines.push(line.trimEnd());
    }
    return lines;
  }

  const truncated = index < tokens.length || text.endsWith(ELLIPSIS);
  if (truncated) {
    lines[lines.length - 1] = fitWithEllipsis(lines[lines.length - 1], maxWidth, measure);
  }
  return lines;
}

/**
 * Maps an element's viewport rectangle onto a captured tab frame and picks the
 * output size, capped at `maxWidth` device pixels.
 * @param {object} options
 * @param {number} options.frameWidth - Captured frame width in pixels.
 * @param {number} options.frameHeight
 * @param {number} options.viewportWidth - window.innerWidth when captured.
 * @param {number} options.viewportHeight
 * @param {{left: number, top: number, width: number, height: number}} options.rect
 *   Area to keep, in CSS pixels (getBoundingClientRect()).
 * @param {number} [options.maxWidth]
 * @returns {{sx: number, sy: number, sw: number, sh: number,
 *   width: number, height: number, scale: number}} Source crop in frame
 *   pixels, output size, and output pixels per CSS pixel.
 */
export function getCaptureCrop({
  frameWidth,
  frameHeight,
  viewportWidth,
  viewportHeight,
  rect,
  maxWidth = SNAPSHOT_MAX_CAPTURE_WIDTH
}) {
  if (!(frameWidth > 0 && frameHeight > 0 && viewportWidth > 0 && viewportHeight > 0)) {
    throw new Error('Captured frame or viewport has no size');
  }

  const ratioX = frameWidth / viewportWidth;
  const ratioY = frameHeight / viewportHeight;
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  if (right <= left || bottom <= top) {
    throw new Error('Capture area is outside the viewport');
  }

  const sx = Math.round(left * ratioX);
  const sy = Math.round(top * ratioY);
  const sw = Math.min(frameWidth - sx, Math.round((right - left) * ratioX));
  const sh = Math.min(frameHeight - sy, Math.round((bottom - top) * ratioY));
  const downscale = Math.min(1, maxWidth / sw);
  const width = Math.max(1, Math.round(sw * downscale));
  const height = Math.max(1, Math.round(sh * downscale));

  return { sx, sy, sw, sh, width, height, scale: width / (right - left) };
}

/**
 * @param {object} options
 * @param {number} options.captureWidth - Capture size in output pixels.
 * @param {number} options.captureHeight
 * @param {number} options.scale - Output pixels per CSS pixel.
 * @param {number} options.promptLineCount - 0 hides the prompt strip.
 * @param {boolean} options.showWatermark - Adds the Panelize strip.
 */
export function getSnapshotLayout({
  captureWidth,
  captureHeight,
  scale,
  promptLineCount,
  showWatermark
}) {
  const m = SNAPSHOT_METRICS;
  const px = (value) => Math.round(value * scale);
  const width = captureWidth;
  const border = Math.max(1, px(m.borderWidth));

  let y = 0;
  let header = null;
  if (promptLineCount > 0) {
    const height = px(m.headerPaddingY * 2 + m.promptLineHeight * promptLineCount);
    header = {
      x: 0,
      y,
      width,
      height,
      textX: px(m.paddingX),
      textY: px(m.headerPaddingY),
      lineHeight: px(m.promptLineHeight),
      font: `600 ${px(m.promptFontSize)}px ${FONT_FAMILY}`,
      border
    };
    y += height;
  }

  const capture = { x: 0, y, width: captureWidth, height: captureHeight };
  y += captureHeight;

  let footer = null;
  if (showWatermark) {
    const height = px(m.footerHeight);
    const iconSize = px(m.iconSize);
    footer = {
      x: 0,
      y,
      width,
      height,
      iconSize,
      iconGap: px(m.iconGap),
      iconY: y + Math.round((height - iconSize) / 2),
      textY: y + Math.round(height / 2),
      font: `600 ${px(m.footerFontSize)}px ${FONT_FAMILY}`,
      siteFont: `400 ${px(m.footerFontSize)}px ${FONT_FAMILY}`,
      border
    };
    y += height;
  }

  return {
    width,
    height: y,
    maxTextWidth: width - px(m.paddingX) * 2,
    header,
    capture,
    footer
  };
}

/**
 * Draws a laid-out snapshot.
 * @param {CanvasRenderingContext2D} ctx - Context of a canvas sized to layout.
 * @param {object} options
 * @param {ReturnType<typeof getSnapshotLayout>} options.layout
 * @param {CanvasImageSource} options.capture - Already cropped to layout.capture size.
 * @param {CanvasImageSource | null} options.icon
 * @param {string[]} options.promptLines
 * @param {ReturnType<typeof getSnapshotTheme>} options.theme
 * @param {string} options.footerText - Localized "Compared with Panelize".
 */
export function drawSnapshot(ctx, { layout, capture, icon, promptLines, theme, footerText }) {
  const { header, footer } = layout;

  if (header) {
    ctx.fillStyle = theme.surface;
    ctx.fillRect(header.x, header.y, header.width, header.height);
    ctx.fillStyle = theme.border;
    ctx.fillRect(header.x, header.y + header.height - header.border, header.width, header.border);
    ctx.font = header.font;
    ctx.fillStyle = theme.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    promptLines.forEach((line, index) => {
      ctx.fillText(line, header.textX, header.y + header.textY + header.lineHeight * (index + 0.5));
    });
  }

  ctx.drawImage(capture, layout.capture.x, layout.capture.y, layout.capture.width, layout.capture.height);

  if (footer) {
    ctx.fillStyle = theme.surface;
    ctx.fillRect(footer.x, footer.y, footer.width, footer.height);
    ctx.fillStyle = theme.border;
    ctx.fillRect(footer.x, footer.y, footer.width, footer.border);

    const separator = ' · ';
    ctx.font = footer.font;
    const brandWidth = ctx.measureText(footerText).width;
    ctx.font = footer.siteFont;
    const siteText = `${separator}${SNAPSHOT_SITE_LABEL}`;
    const siteWidth = ctx.measureText(siteText).width;
    const iconWidth = icon ? footer.iconSize + footer.iconGap : 0;
    let x = Math.round((footer.width - (iconWidth + brandWidth + siteWidth)) / 2);

    if (icon) {
      ctx.drawImage(icon, x, footer.iconY, footer.iconSize, footer.iconSize);
      x += iconWidth;
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = footer.font;
    ctx.fillStyle = theme.text;
    ctx.fillText(footerText, x, footer.textY);
    ctx.font = footer.siteFont;
    ctx.fillStyle = theme.muted;
    ctx.fillText(siteText, x + brandWidth, footer.textY);
  }
}

/**
 * Measures, lays out and draws a snapshot onto `canvas`.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @param {object} options
 * @param {CanvasImageSource & {width: number, height: number}} options.capture
 * @param {number} options.scale - Output pixels per CSS pixel of the capture.
 * @param {CanvasImageSource | null} [options.icon]
 * @param {string} [options.prompt]
 * @param {string} [options.theme] - 'light' or 'dark'.
 * @param {boolean} [options.showWatermark]
 * @param {string} options.footerText
 * @returns {ReturnType<typeof getSnapshotLayout>}
 */
export function composeSnapshot(canvas, {
  capture,
  scale,
  icon = null,
  prompt = '',
  theme = 'light',
  showWatermark = true,
  footerText
}) {
  const ctx = canvas.getContext('2d');
  const palette = getSnapshotTheme(theme);
  const promptText = normalizePromptText(prompt);

  // Measure with the final font before the canvas is resized, which resets
  // the context state.
  const probe = getSnapshotLayout({
    captureWidth: capture.width,
    captureHeight: capture.height,
    scale,
    promptLineCount: 1,
    showWatermark
  });
  ctx.font = probe.header.font;
  const promptLines = wrapTextLines(promptText, probe.maxTextWidth, (text) => ctx.measureText(text).width);

  const layout = getSnapshotLayout({
    captureWidth: capture.width,
    captureHeight: capture.height,
    scale,
    promptLineCount: promptLines.length,
    showWatermark
  });
  canvas.width = layout.width;
  canvas.height = layout.height;
  drawSnapshot(ctx, { layout, capture, icon, promptLines, theme: palette, footerText });
  return layout;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * @param {Date} [date]
 * @returns {string} e.g. panelize-comparison-20261020-213005.png
 */
export function getSnapshotFileName(date = new Date()) {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `panelize-comparison-${day}-${time}.png`;
}
