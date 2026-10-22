// Share snapshot composition: frames a captured comparison in the Panelize
// share layout (light theme "A", dark theme "B") and draws it on a 2D canvas
// context. Everything is pure or takes its canvas from the caller, so the
// layout can be unit tested without a browser.

export const SNAPSHOT_SITE_LABEL = 'panelize.dev';

export const SNAPSHOT_BRAND_NAME = 'Panelize';

/** Longest title kept before measuring; the headline shows a few lines at most. */
export const SNAPSHOT_MAX_PROMPT_CHARS = 400;

export const SNAPSHOT_MAX_PROMPT_LINES = 3;

/** The subline wraps once on narrow captures so the date is not cut off. */
export const SNAPSHOT_MAX_SUBLINE_LINES = 2;

/** Widest capture kept in the image, in device pixels. */
export const SNAPSHOT_MAX_CAPTURE_WIDTH = 2560;

/** Tallest image produced, in output pixels. Long answers are truncated to fit. */
export const SNAPSHOT_MAX_OUTPUT_HEIGHT = 8000;

/** Chrome refuses canvases beyond these limits. */
export const CANVAS_MAX_DIMENSION = 32767;
export const CANVAS_MAX_AREA = 268435456;

const ELLIPSIS = '…';

// System fonts only, with CJK families early enough that Chinese and Japanese
// titles do not fall back to a mismatched default.
export const SNAPSHOT_FONT_FAMILY = [
  '-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"Segoe UI"',
  '"PingFang SC"', '"Hiragino Sans"', '"Hiragino Kaku Gothic ProN"',
  '"Microsoft YaHei"', '"Yu Gothic UI"', '"Noto Sans CJK SC"', '"Noto Sans"',
  'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'
].join(', ');

/**
 * Frame styles in CSS pixels; multiplied by the capture scale when drawn.
 * `light` is layout A (warm paper, tagline, prompt label) and `dark` is
 * layout B (glows, quoted headline, window card). Both put the site link on
 * the brand row and the providers and date in a subline under the headline.
 */
export const SNAPSHOT_FRAME_STYLES = Object.freeze({
  light: Object.freeze({
    variant: 'a',
    background: '#F5F4F0',
    paddingTop: 48,
    paddingX: 64,
    paddingBottom: 56,
    brandHeight: 34,
    iconSize: 34,
    iconRadius: 8,
    iconGap: 12,
    brandFontSize: 20,
    brandWeight: 650,
    brandLetterSpacing: -0.01,
    brandColor: '#16161A',
    taglineFontSize: 15,
    taglineColor: 'rgba(22, 22, 26, 0.55)',
    ctaGap: 14,
    captionFontSize: 14,
    captionColor: '#8A8A90',
    pillHeight: 34,
    pillPaddingX: 16,
    pillFontSize: 16,
    pillWeight: 650,
    pillBackground: '#16161A',
    pillColor: '#ffffff',
    labelGap: 40,
    labelFontSize: 13,
    labelWeight: 650,
    labelLineHeight: 16,
    labelLetterSpacing: 0.12,
    labelColor: '#9A9AA0',
    titleGap: 10,
    titleGapWithoutLabel: 40,
    titleFontSize: 36,
    titleLineHeight: 45,
    titleWeight: 680,
    titleLetterSpacing: -0.02,
    titleColor: '#16161A',
    titleMaxWidth: 1240,
    sublineGap: 10,
    sublineGapWithoutTitle: 40,
    sublineFontSize: 16,
    sublineLineHeight: 22,
    sublineColor: '#7A7A80',
    cardGap: 32,
    cardGapWithoutHeadline: 32,
    cardRadius: 16,
    cardBorder: 'rgba(0, 0, 0, 0.08)',
    cardBackground: '#ffffff',
    cardShadow: Object.freeze({ color: 'rgba(30, 30, 40, 0.22)', blur: 48, offsetY: 20 }),
    titleBarHeight: 0,
    noteGap: 16,
    noteFontSize: 14,
    noteLineHeight: 20,
    noteColor: '#7A7A80'
  }),
  dark: Object.freeze({
    variant: 'b',
    background: '#0E0F13',
    glows: Object.freeze([
      Object.freeze({ x: 0.08, y: 0, radiusX: 900, radiusY: 500, color: [239, 68, 68], alpha: 0.28 }),
      Object.freeze({ x: 1, y: 1, radiusX: 1000, radiusY: 600, color: [59, 130, 246], alpha: 0.32 })
    ]),
    paddingTop: 44,
    paddingX: 64,
    paddingBottom: 64,
    brandHeight: 34,
    iconSize: 34,
    iconRadius: 8,
    iconGap: 12,
    brandFontSize: 20,
    brandWeight: 650,
    brandLetterSpacing: -0.01,
    brandColor: '#ffffff',
    ctaGap: 14,
    captionFontSize: 14,
    captionColor: 'rgba(255, 255, 255, 0.55)',
    pillHeight: 34,
    pillPaddingX: 16,
    pillFontSize: 16,
    pillWeight: 650,
    pillBackground: '#ffffff',
    pillColor: '#16161A',
    titleGap: 36,
    titleGapWithoutBrand: 0,
    titleFontSize: 38,
    titleLineHeight: 46,
    titleWeight: 700,
    titleLetterSpacing: -0.02,
    titleColor: '#ffffff',
    titleMaxWidth: 1200,
    openQuote: '“',
    closeQuote: '”',
    openQuoteColor: '#EF4444',
    closeQuoteColor: '#3B82F6',
    sublineGap: 12,
    sublineGapWithoutTitle: 36,
    sublineFontSize: 16,
    sublineLineHeight: 22,
    sublineColor: 'rgba(255, 255, 255, 0.55)',
    cardGap: 34,
    cardGapWithoutHeadline: 36,
    cardRadius: 18,
    cardBorder: 'rgba(255, 255, 255, 0.12)',
    cardBackground: '#ffffff',
    cardShadow: Object.freeze({ color: 'rgba(0, 0, 0, 0.6)', blur: 64, offsetY: 24 }),
    titleBarHeight: 38,
    titleBarColor: '#1B1C22',
    titleBarDotSize: 12,
    titleBarDotGap: 8,
    titleBarPaddingX: 16,
    titleBarDotColor: '#3A3B42',
    noteGap: 18,
    noteFontSize: 14,
    noteLineHeight: 20,
    noteColor: 'rgba(255, 255, 255, 0.6)'
  })
});

/** Text of the site link pill on the brand row. */
export const SNAPSHOT_SITE_LINK_TEXT = `${SNAPSHOT_SITE_LABEL} ↗`;

/**
 * @param {string} theme - 'light' or 'dark'.
 */
export function getSnapshotFrameStyle(theme) {
  return theme === 'dark' ? SNAPSHOT_FRAME_STYLES.dark : SNAPSHOT_FRAME_STYLES.light;
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
  return text.match(/[　-鿿가-힯豈-﫿＀-￯]|[^\s　-鿿가-힯豈-﫿＀-￯]+\s*|\s+/g) || [];
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

function font(weight, size) {
  return `${weight} ${size}px ${SNAPSHOT_FONT_FAMILY}`;
}

/**
 * Lays out the share frame around content of a given size.
 *
 * Elements are dropped, and the space they used collapses, when they have
 * nothing to show: no title lines removes the headline (and the light
 * theme's "PROMPT" label), `showWatermark: false` removes the brand row with
 * its tagline, caption and site link, and an empty subline or note is
 * skipped. The subline (providers and date) describes the content, so it
 * stays without the watermark.
 * The card around the content is always drawn.
 *
 * @param {object} options
 * @param {number} options.contentWidth - Content size in output pixels.
 * @param {number} options.contentHeight
 * @param {number} options.scale - Output pixels per CSS pixel.
 * @param {string} [options.theme] - 'light' (layout A) or 'dark' (layout B).
 * @param {number} [options.titleLineCount] - Wrapped headline lines; 0 hides it.
 * @param {boolean} [options.showWatermark]
 * @param {boolean} [options.hasSubline] - Provider and date line under the headline.
 * @param {number} [options.sublineLineCount] - Wrapped subline lines.
 * @param {boolean} [options.hasNote] - Truncation note under the card.
 */
export function getSnapshotFrameLayout({
  contentWidth,
  contentHeight,
  scale,
  theme = 'light',
  titleLineCount = 0,
  showWatermark = true,
  hasSubline = false,
  sublineLineCount = 1,
  hasNote = false
}) {
  const style = getSnapshotFrameStyle(theme);
  const px = (value) => Math.round(value * scale);
  const paddingX = px(style.paddingX);
  const width = contentWidth + paddingX * 2;
  const innerWidth = contentWidth;
  const isDark = style.variant === 'b';

  let y = px(style.paddingTop);
  let brand = null;
  if (showWatermark) {
    const height = px(style.brandHeight);
    brand = {
      x: paddingX,
      y,
      height,
      centerY: y + Math.round(height / 2),
      iconSize: px(style.iconSize),
      iconRadius: px(style.iconRadius),
      iconGap: px(style.iconGap),
      font: font(style.brandWeight, px(style.brandFontSize)),
      letterSpacing: style.brandFontSize * style.brandLetterSpacing * scale,
      taglineFont: style.taglineFontSize ? font(500, px(style.taglineFontSize)) : null,
      right: paddingX + innerWidth,
      ctaGap: px(style.ctaGap),
      captionFont: font(500, px(style.captionFontSize)),
      pillHeight: px(style.pillHeight),
      pillPaddingX: px(style.pillPaddingX),
      pillFont: font(style.pillWeight, px(style.pillFontSize))
    };
    y += height;
  }

  let label = null;
  let title = null;
  if (titleLineCount > 0) {
    if (!isDark) {
      y += brand ? px(style.labelGap) : 0;
      label = {
        x: paddingX,
        y,
        height: px(style.labelLineHeight),
        font: font(style.labelWeight, px(style.labelFontSize)),
        letterSpacing: style.labelFontSize * style.labelLetterSpacing * scale
      };
      y += label.height + px(style.titleGap);
    } else {
      y += brand ? px(style.titleGap) : 0;
    }
    const lineHeight = px(style.titleLineHeight);
    title = {
      x: paddingX,
      y,
      lineHeight,
      lineCount: titleLineCount,
      height: lineHeight * titleLineCount,
      font: font(style.titleWeight, px(style.titleFontSize)),
      letterSpacing: style.titleFontSize * style.titleLetterSpacing * scale,
      quoteGap: px(style.openQuoteGap || 0),
      maxWidth: Math.min(innerWidth, px(style.titleMaxWidth))
    };
    y += title.height;
  }

  let subline = null;
  if (hasSubline) {
    if (title) {
      y += px(style.sublineGap);
    } else if (brand) {
      y += px(style.sublineGapWithoutTitle);
    }
    subline = {
      x: paddingX,
      y,
      lineHeight: px(style.sublineLineHeight),
      height: px(style.sublineLineHeight) * Math.max(1, sublineLineCount),
      font: font(400, px(style.sublineFontSize)),
      maxWidth: innerWidth
    };
    y += subline.height;
  }

  const hasHeadline = Boolean(brand || title || subline);
  if (hasHeadline) {
    y += px(title || subline ? style.cardGap : style.cardGapWithoutHeadline);
  }

  const titleBarHeight = px(style.titleBarHeight);
  const card = {
    x: paddingX,
    y,
    width: innerWidth,
    height: titleBarHeight + contentHeight,
    radius: px(style.cardRadius),
    border: Math.max(1, px(1)),
    titleBarHeight,
    dotSize: style.titleBarDotSize ? px(style.titleBarDotSize) : 0,
    dotGap: style.titleBarDotGap ? px(style.titleBarDotGap) : 0,
    dotPaddingX: style.titleBarPaddingX ? px(style.titleBarPaddingX) : 0,
    shadowBlur: px(style.cardShadow.blur),
    shadowOffsetY: px(style.cardShadow.offsetY)
  };
  const content = { x: paddingX, y: y + titleBarHeight, width: contentWidth, height: contentHeight };
  y += card.height;

  let note = null;
  if (hasNote) {
    y += px(style.noteGap);
    note = {
      x: paddingX,
      y,
      height: px(style.noteLineHeight),
      font: font(500, px(style.noteFontSize)),
      maxWidth: innerWidth
    };
    y += note.height;
  }

  y += px(style.paddingBottom);

  return { width, height: y, scale, style, brand, label, title, subline, card, content, note };
}

/**
 * Height the frame adds around content, for fitting tall captures under
 * SNAPSHOT_MAX_OUTPUT_HEIGHT.
 * @param {Parameters<typeof getSnapshotFrameLayout>[0]} options - Without contentHeight.
 */
export function getSnapshotFrameChromeHeight(options) {
  return getSnapshotFrameLayout({ ...options, contentHeight: 0 }).height;
}

function withLetterSpacing(ctx, spacing, draw) {
  const supported = 'letterSpacing' in ctx;
  const previous = supported ? ctx.letterSpacing : null;
  if (supported) {
    ctx.letterSpacing = `${spacing}px`;
  }
  try {
    return draw();
  } finally {
    if (supported) {
      ctx.letterSpacing = previous;
    }
  }
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawBackground(ctx, layout) {
  const { style, width, height, scale } = layout;
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, width, height);
  if (!style.glows || typeof ctx.createRadialGradient !== 'function') {
    return;
  }
  // CSS-like elliptical glows: draw a circular gradient in a scaled space.
  style.glows.forEach((glow) => {
    const radiusX = glow.radiusX * scale;
    const radiusY = glow.radiusY * scale;
    ctx.save();
    ctx.translate(glow.x * width, glow.y * height);
    ctx.scale(1, radiusY / radiusX);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, radiusX);
    const [r, g, b] = glow.color;
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${glow.alpha})`);
    gradient.addColorStop(0.6, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(-radiusX, -radiusX, radiusX * 2, radiusX * 2);
    ctx.restore();
  });
}

// The site link sits at the right end of the brand row: a solid pill, with
// the caption to its left. When the row is too narrow the tagline goes
// first, then the caption; the pill always stays.
function drawBrand(ctx, layout, { icon, taglineText, captionText }) {
  const { brand, style } = layout;
  let x = brand.x;
  if (icon) {
    ctx.save();
    roundedRectPath(ctx, x, brand.centerY - brand.iconSize / 2, brand.iconSize, brand.iconSize, brand.iconRadius);
    ctx.clip();
    ctx.drawImage(icon, x, brand.centerY - brand.iconSize / 2, brand.iconSize, brand.iconSize);
    ctx.restore();
    x += brand.iconSize + brand.iconGap;
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = brand.font;
  ctx.fillStyle = style.brandColor;
  x += withLetterSpacing(ctx, brand.letterSpacing, () => {
    ctx.fillText(SNAPSHOT_BRAND_NAME, x, brand.centerY);
    return ctx.measureText(SNAPSHOT_BRAND_NAME).width;
  });

  ctx.font = brand.pillFont;
  const pillWidth = Math.round(ctx.measureText(SNAPSHOT_SITE_LINK_TEXT).width) + brand.pillPaddingX * 2;
  const pillX = brand.right - pillWidth;
  ctx.font = brand.captionFont;
  const captionWidth = captionText ? ctx.measureText(captionText).width : 0;
  const captionRight = pillX - brand.ctaGap;
  const showCaption = captionWidth > 0 && captionRight - captionWidth >= x + brand.ctaGap;
  const ctaLeft = showCaption ? captionRight - captionWidth : pillX;

  if (brand.taglineFont && taglineText) {
    ctx.font = brand.taglineFont;
    const tagline = `· ${taglineText}`;
    const taglineX = x + brand.iconGap;
    if (taglineX + ctx.measureText(tagline).width + brand.ctaGap <= ctaLeft) {
      ctx.fillStyle = style.taglineColor;
      ctx.fillText(tagline, taglineX, brand.centerY);
    }
  }

  if (showCaption) {
    ctx.font = brand.captionFont;
    ctx.fillStyle = style.captionColor;
    ctx.textAlign = 'right';
    ctx.fillText(captionText, captionRight, brand.centerY);
  }

  roundedRectPath(ctx, pillX, brand.centerY - brand.pillHeight / 2, pillWidth, brand.pillHeight, brand.pillHeight / 2);
  ctx.fillStyle = style.pillBackground;
  ctx.fill();
  ctx.font = brand.pillFont;
  ctx.fillStyle = style.pillColor;
  ctx.textAlign = 'center';
  ctx.fillText(SNAPSHOT_SITE_LINK_TEXT, pillX + pillWidth / 2, brand.centerY);
  ctx.textAlign = 'left';
}

function drawTitle(ctx, layout, titleLines, labelText) {
  const { label, title, style } = layout;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (label && labelText) {
    ctx.font = label.font;
    ctx.fillStyle = style.labelColor;
    withLetterSpacing(ctx, label.letterSpacing, () => {
      ctx.fillText(labelText.toLocaleUpperCase(), label.x, label.y + label.height / 2);
    });
  }

  ctx.font = title.font;
  withLetterSpacing(ctx, title.letterSpacing, () => {
    const openQuote = style.openQuote || '';
    const openWidth = openQuote ? ctx.measureText(openQuote).width + title.quoteGap : 0;
    titleLines.forEach((line, index) => {
      const lineY = title.y + title.lineHeight * (index + 0.5);
      let x = title.x;
      if (openQuote && index === 0) {
        ctx.fillStyle = style.openQuoteColor;
        ctx.fillText(openQuote, x, lineY);
      }
      x += openWidth;
      ctx.fillStyle = style.titleColor;
      ctx.fillText(line, x, lineY);
      if (style.closeQuote && index === titleLines.length - 1) {
        ctx.fillStyle = style.closeQuoteColor;
        ctx.fillText(style.closeQuote, x + ctx.measureText(line).width, lineY);
      }
    });
  });
}

function drawSingleLine(ctx, box, text, color, align = 'left', measure) {
  ctx.font = box.font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  const [line = ''] = wrapTextLines(text, box.maxWidth, measure, 1);
  const x = align === 'center' ? box.x + box.maxWidth / 2 : box.x;
  ctx.fillText(line, x, box.y + box.height / 2);
  ctx.textAlign = 'left';
}

function drawSubline(ctx, layout, text, measure) {
  const { subline, style } = layout;
  ctx.font = subline.font;
  ctx.fillStyle = style.sublineColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const lines = wrapTextLines(text, subline.maxWidth, measure, Math.round(subline.height / subline.lineHeight));
  lines.forEach((line, index) => {
    ctx.fillText(line, subline.x, subline.y + subline.lineHeight * (index + 0.5));
  });
}

function drawCard(ctx, layout, content, { fadeBottom }) {
  const { card, style } = layout;
  ctx.save();
  ctx.shadowColor = style.cardShadow.color;
  ctx.shadowBlur = card.shadowBlur;
  ctx.shadowOffsetY = card.shadowOffsetY;
  roundedRectPath(ctx, card.x, card.y, card.width, card.height, card.radius);
  ctx.fillStyle = style.cardBackground;
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, card.x, card.y, card.width, card.height, card.radius);
  ctx.clip();
  if (card.titleBarHeight > 0) {
    ctx.fillStyle = style.titleBarColor;
    ctx.fillRect(card.x, card.y, card.width, card.titleBarHeight);
    ctx.fillStyle = style.titleBarDotColor;
    for (let index = 0; index < 3; index += 1) {
      const cx = card.x + card.dotPaddingX + card.dotSize / 2 + index * (card.dotSize + card.dotGap);
      ctx.beginPath();
      ctx.arc(cx, card.y + card.titleBarHeight / 2, card.dotSize / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  const box = layout.content;
  if (box.height > 0) {
    ctx.drawImage(content, box.x, box.y, box.width, box.height);
  }
  if (fadeBottom && typeof ctx.createLinearGradient === 'function') {
    const fadeHeight = Math.min(box.height, Math.round(140 * layout.scale));
    const gradient = ctx.createLinearGradient(0, box.y + box.height - fadeHeight, 0, box.y + box.height);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
    gradient.addColorStop(1, style.cardBackground);
    ctx.fillStyle = gradient;
    ctx.fillRect(box.x, box.y + box.height - fadeHeight, box.width, fadeHeight);
  }
  ctx.restore();

  ctx.save();
  roundedRectPath(ctx, card.x + card.border / 2, card.y + card.border / 2,
    card.width - card.border, card.height - card.border, card.radius);
  ctx.lineWidth = card.border;
  ctx.strokeStyle = style.cardBorder;
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws a laid-out snapshot.
 * @param {CanvasRenderingContext2D} ctx - Context of a canvas sized to layout.
 * @param {object} options
 * @param {ReturnType<typeof getSnapshotFrameLayout>} options.layout
 * @param {CanvasImageSource} options.content - Drawn at layout.content size.
 * @param {CanvasImageSource | null} [options.icon]
 * @param {string[]} [options.titleLines]
 * @param {string} [options.labelText] - Light theme "PROMPT" label.
 * @param {string} [options.taglineText] - Light theme "Compare AI side by side".
 * @param {string} [options.captionText] - "Free Chrome extension" beside the site link.
 * @param {string} [options.sublineText] - Providers and date, see formatSnapshotSubline.
 * @param {string} [options.noteText] - Truncation note; also fades the content bottom.
 */
export function drawSnapshot(ctx, {
  layout,
  content,
  icon = null,
  titleLines = [],
  labelText = '',
  taglineText = '',
  captionText = '',
  sublineText = '',
  noteText = ''
}) {
  const measure = (text) => ctx.measureText(text).width;
  drawBackground(ctx, layout);
  if (layout.brand) {
    drawBrand(ctx, layout, { icon, taglineText: layout.style.variant === 'a' ? taglineText : '', captionText });
  }
  if (layout.title) {
    drawTitle(ctx, layout, titleLines, labelText);
  }
  if (layout.subline) {
    drawSubline(ctx, layout, sublineText, measure);
  }
  drawCard(ctx, layout, content, { fadeBottom: Boolean(layout.note) });
  if (layout.note) {
    drawSingleLine(ctx, layout.note, noteText, layout.style.noteColor, 'center', measure);
  }
}

function measureTitleLines(ctx, layoutOptions, title, theme) {
  const probe = getSnapshotFrameLayout({ ...layoutOptions, titleLineCount: 1 });
  const style = probe.style;
  ctx.font = probe.title.font;
  return withLetterSpacing(ctx, probe.title.letterSpacing, () => {
    const quotes = theme === 'dark'
      ? ctx.measureText(style.openQuote).width + probe.title.quoteGap
        + ctx.measureText(style.closeQuote).width
      : 0;
    return wrapTextLines(title, probe.title.maxWidth - quotes, (text) => ctx.measureText(text).width);
  });
}

function measureSublineLines(ctx, layoutOptions, text) {
  const probe = getSnapshotFrameLayout(layoutOptions);
  ctx.font = probe.subline.font;
  return wrapTextLines(text, probe.subline.maxWidth, (line) => ctx.measureText(line).width, SNAPSHOT_MAX_SUBLINE_LINES);
}

/**
 * Measures, lays out and draws a snapshot onto `canvas`.
 * @param {HTMLCanvasElement | OffscreenCanvas} canvas
 * @param {object} options
 * @param {CanvasImageSource & {width: number, height: number}} options.content
 *   The capture (or stitched grid) in output pixels.
 * @param {number} options.scale - Output pixels per CSS pixel of the content.
 * @param {string} [options.title] - Headline; empty removes it.
 * @param {string} [options.theme] - 'light' or 'dark'.
 * @param {boolean} [options.showWatermark]
 * @param {CanvasImageSource | null} [options.icon]
 * @param {string} [options.labelText]
 * @param {string} [options.taglineText]
 * @param {string} [options.captionText]
 * @param {string} [options.sublineText]
 * @param {string} [options.noteText]
 * @returns {ReturnType<typeof getSnapshotFrameLayout>}
 */
export function composeSnapshot(canvas, {
  content,
  scale,
  title = '',
  theme = 'light',
  showWatermark = true,
  icon = null,
  labelText = '',
  taglineText = '',
  captionText = '',
  sublineText = '',
  noteText = ''
}) {
  const ctx = canvas.getContext('2d');
  const layoutOptions = {
    contentWidth: content.width,
    contentHeight: content.height,
    scale,
    theme,
    showWatermark,
    hasSubline: Boolean(sublineText),
    hasNote: Boolean(noteText)
  };

  // Measure with the final font before the canvas is resized, which resets
  // the context state.
  const titleText = normalizePromptText(title);
  const titleLines = titleText ? measureTitleLines(ctx, layoutOptions, titleText, theme) : [];
  const sublineLineCount = sublineText ? measureSublineLines(ctx, layoutOptions, sublineText).length : 1;
  const layout = getSnapshotFrameLayout({ ...layoutOptions, titleLineCount: titleLines.length, sublineLineCount });
  canvas.width = layout.width;
  canvas.height = layout.height;
  drawSnapshot(ctx, {
    layout, content, icon, titleLines, labelText, taglineText, captionText, sublineText, noteText
  });
  return layout;
}

/**
 * Subline of both themes, e.g.
 * "Same prompt · ChatGPT, Grok, and DeepSeek · side by side · Oct 22, 2026".
 * @param {object} options
 * @param {string} [options.providersText] - Localized provider sentence; empty leaves only the date.
 * @param {Date} options.date
 * @param {string} [options.locale] - BCP 47 tag for the date.
 */
export function formatSnapshotSubline({ providersText, date, locale }) {
  let dateText;
  try {
    dateText = new Intl.DateTimeFormat(locale || undefined, { dateStyle: 'medium' }).format(date);
  } catch {
    dateText = date.toDateString();
  }
  return [providersText, dateText].filter(Boolean).join(' · ');
}

/**
 * Joins provider names the way the UI language lists things.
 * @param {string[]} names
 * @param {string} [locale]
 */
export function formatProviderList(names, locale) {
  const unique = [...new Set(names.filter(Boolean))];
  try {
    return new Intl.ListFormat(locale || undefined, { style: 'long', type: 'conjunction' }).format(unique);
  } catch {
    return unique.join(', ');
  }
}

/**
 * Converts an extension locale id (zh_CN) to a BCP 47 tag (zh-CN).
 * @param {string} locale
 */
export function toLanguageTag(locale) {
  return String(locale || '').replace('_', '-') || undefined;
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
