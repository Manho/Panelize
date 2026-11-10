import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtension, openMultiPanel, REPO_EXTENSION_PATH } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';
import { MATERIAL_SYMBOLS_SOURCE_PATH } from '../../scripts/material-symbols.js';

const { iconNames } = JSON.parse(await readFile(path.join(REPO_EXTENSION_PATH, MATERIAL_SYMBOLS_SOURCE_PATH), 'utf8'));

/**
 * Widths of icons rendered from their names. A name the font has a ligature
 * for renders as one 1em glyph; any other name falls back to its plain text.
 */
function measureIconNames(page, names) {
  return page.evaluate(async (iconNamesToMeasure) => {
    await document.fonts.load('20px "Material Symbols Outlined"');
    const widths = {};
    for (const name of iconNamesToMeasure) {
      const span = document.createElement('span');
      span.className = 'material-symbols-outlined';
      span.style.fontSize = '20px';
      span.textContent = name;
      document.body.append(span);
      widths[name] = Math.round(span.getBoundingClientRect().width);
      span.remove();
    }
    return widths;
  }, names);
}

/** Visible icons whose width is not their font size, i.e. rendered as text. */
function iconsRenderedAsText(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.material-symbols-outlined'))
    .filter((icon) => icon.getClientRects().length > 0)
    .map((icon) => ({
      name: icon.textContent.trim(),
      width: Math.round(icon.getBoundingClientRect().width),
      fontSize: Math.round(parseFloat(getComputedStyle(icon).fontSize)),
    }))
    .filter(({ width, fontSize }) => width !== fontSize));
}

// Icons must render from the font bundled in the extension, without any request
// to Google Fonts. Regression: icons loaded from Google Fonts rendered as their
// names when it was unreachable, and the wide text of "swap_horiz" covered the
// panel's Refresh button.
test('extension pages render every icon from the bundled font', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  const fontRequests = [];
  extension.context.on('request', (request) => {
    if (/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(request.url())) {
      fontRequests.push(request.url());
    }
  });
  try {
    await extension.context.route('https://chatgpt.com/**', (route) => route.fulfill({
      contentType: 'text/html', body: renderChatgptFixture(),
    }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });

    const widths = await measureIconNames(page, [...iconNames, 'not_a_bundled_icon']);
    // Control: a name without a ligature is laid out as text.
    expect(widths.not_a_bundled_icon).toBeGreaterThan(100);
    delete widths.not_a_bundled_icon;
    expect(widths).toEqual(Object.fromEntries(iconNames.map((name) => [name, 20])));

    expect(await iconsRenderedAsText(page)).toEqual([]);
    const headerIconWidths = await page.locator('.panel-header-right .material-symbols-outlined')
      .evaluateAll((icons) => icons.map((icon) => Math.round(icon.getBoundingClientRect().width)));
    expect(headerIconWidths).toEqual([16, 16, 16]);
    // Fails if another element covers the button, as the fallback text did.
    await page.locator('.refresh-panel-btn').click({ trial: true, timeout: 5000 });

    const options = await extension.context.newPage();
    await options.goto(extension.extensionUrl('options/options.html'));
    await expect(options.locator('.drag-handle').first()).toBeVisible();
    expect(await measureIconNames(options, ['drag_indicator'])).toEqual({ drag_indicator: 20 });
    expect(await iconsRenderedAsText(options)).toEqual([]);

    expect(fontRequests).toEqual([]);
  } finally {
    await extension.close();
  }
});
