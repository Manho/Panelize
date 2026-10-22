import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { PANEL_COLUMN_WEIGHTS_KEY } from '../../modules/panel-resize.js';

const EDGE_COLOR = [255, 0, 255];

/**
 * App shell like ChatGLM's: full-screen scrolling wrappers around a sidebar
 * and a main area held open by a min-width, with a colored strip at its far
 * right edge.
 */
function renderShellPage(minWidth) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; }
  .root { position: fixed; inset: 0; overflow: auto; }
  .app { display: flex; height: 100%; overflow: auto; }
  .sidebar { width: 200px; flex-shrink: 0; background: #ddd; }
  main { display: flex; flex: 1; min-width: ${minWidth - 200}px; overflow-x: auto; }
  #edge { width: 20px; margin-left: auto; background: rgb(${EDGE_COLOR.join(',')}); }
</style></head>
<body><div class="root"><div class="app"><div class="sidebar"></div><main>chat<div id="edge"></div></main></div></div></body></html>`;
}

/**
 * Responsive page with things wider than the panel that are meant to be:
 * a table scrolling sideways, an open menu and hidden or off-screen layers.
 */
const RESPONSIVE_PAGE = `<!doctype html><html><head><style>
  html, body { margin: 0; height: 100%; }
  .scroller { overflow-x: auto; }
  table { min-width: 2000px; }
  .menu { position: absolute; top: 40px; left: 100px; min-width: 900px; height: 50px; background: #eee; }
  .hidden { display: none; min-width: 3000px; }
  .drawer { min-width: 500px; height: 50px; transform: translateX(100vw); }
</style></head><body>
  <div class="scroller"><table><tr><td>wide table</td></tr></table></div>
  <div class="menu">menu</div>
  <div class="hidden"></div>
  <div class="drawer"></div>
</body></html>`;

function providerFrame(page, origin) {
  return page.frames().find(frame => frame.url().startsWith(origin));
}

function getColumnWidths(page) {
  return page.evaluate(() => Array.from(
    document.querySelectorAll('#panel-grid .panel-item'),
    panel => Math.round(panel.getBoundingClientRect().width)
  ));
}

/** RGB of one CSS pixel of the page as it is on screen, frames included. */
async function readScreenPixel(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  return page.evaluate(async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = new OffscreenCanvas(1, 1);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, `data:image/png;base64,${png.toString('base64')}`);
}

async function dragHandle(page, index, deltaX) {
  const box = await page.locator('.panel-resize-handle').nth(index).boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX / 2, y, { steps: 4 });
  await page.mouse.move(x + deltaX, y, { steps: 4 });
  await page.mouse.up();
}

test('a page wider than its panel is laid out at its width and scaled to fit', async ({}, testInfo) => {
  test.setTimeout(90_000);
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://www.kimi.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderShellPage(600),
    }));
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: RESPONSIVE_PAGE,
    }));
    // Two panels in 320px columns, like a full 1x12 grid.
    const page = await openMultiPanel(extension, { providers: ['kimi', 'chatgpt'], layout: '1x12' });
    const [kimi, chatgpt] = [0, 1].map(index => page.locator('#panel-grid iframe').nth(index));
    await kimi.evaluate((frame) => {
      window.panelFitChanges = [];
      new MutationObserver(() => window.panelFitChanges.push(frame.classList.contains('panel-fitted')))
        .observe(frame, { attributes: true, attributeFilter: ['class'] });
    });

    await expect(kimi).toHaveClass(/panel-fitted/);
    const kimiFrame = providerFrame(page, 'https://www.kimi.com');
    // The cross-process frame takes its new viewport a moment after the iframe resizes.
    await expect.poll(() => kimiFrame.evaluate(() => window.innerWidth)).toBe(600);
    // Laid out at its width, the page still needs it: the fit holds, it does not flicker.
    await kimiFrame.evaluate(() => document.body.classList.add('relaid'));
    // Two report periods (PAGE_WIDTH_REPORT_THROTTLE_MS) for the page to measure again.
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.panelFitChanges)).not.toContain(false);
    const fit = await kimi.evaluate(frame => ({
      frame: frame.getBoundingClientRect().width,
      panel: frame.parentElement.clientWidth,
    }));
    expect(Math.abs(fit.frame - fit.panel)).toBeLessThanOrEqual(1);
    // The right edge of the app is on screen, not cut off.
    const kimiBox = await kimi.boundingBox();
    const edgePixel = await readScreenPixel(page, kimiBox.x + kimiBox.width - 4, kimiBox.y + 100);
    edgePixel.forEach((channel, index) => expect(Math.abs(channel - EDGE_COLOR[index])).toBeLessThanOrEqual(12));
    await page.screenshot({ path: testInfo.outputPath('fitted-1x12.png') });

    // Scrolling tables, menus, hidden and off-screen layers do not count.
    await expect(chatgpt).not.toHaveClass(/panel-fitted/);
    expect(await providerFrame(page, 'https://chatgpt.com').evaluate(() => window.innerWidth)).toBe(fit.panel);

    // Once the page fits again (e.g. its sidebar collapsed), it is shown at full size.
    await kimiFrame.evaluate(() => { document.querySelector('main').style.minWidth = '0px'; });
    await expect(kimi).not.toHaveClass(/panel-fitted/);
    await expect.poll(() => kimiFrame.evaluate(() => window.innerWidth)).toBe(fit.panel);
  } finally {
    await extension.close();
  }
});

test('panel edges drag to resize columns, are remembered per layout and reset on double-click', async () => {
  test.setTimeout(90_000);
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://www.kimi.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderShellPage(600),
    }));
    await extension.context.route(url => url.protocol === 'https:' && url.hostname !== 'www.kimi.com',
      route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>provider</title>' }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt', 'kimi', 'deepseek'], layout: '1x3' });
    await expect(page.locator('.panel-resize-handle')).toHaveCount(2);
    const handle = page.locator('.panel-resize-handle').first();
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('aria-label', 'Drag to resize panels. Double-click to reset.');

    // Columns that fit the window trade width with their neighbor.
    const start = await getColumnWidths(page);
    await dragHandle(page, 0, -150);
    const dragged = await getColumnWidths(page);
    expect(Math.abs(dragged[0] - (start[0] - 150))).toBeLessThanOrEqual(2);
    expect(Math.abs(dragged[1] - (start[1] + 150))).toBeLessThanOrEqual(2);
    expect(Math.abs(dragged[2] - start[2])).toBeLessThanOrEqual(2);
    await expect(page.locator('body')).not.toHaveClass(/panel-resizing/);

    // Widening Kimi's panel to the width its page needs shows it at full size.
    const kimi = page.locator('#panel-grid iframe').nth(1);
    await expect(kimi).toHaveClass(/panel-fitted/);
    await dragHandle(page, 1, 620 - dragged[1]);
    await expect(kimi).not.toHaveClass(/panel-fitted/);
    const widened = await getColumnWidths(page);

    // Remembered for this layout across reloads.
    const stored = await page.evaluate(key => chrome.storage.local.get(key), PANEL_COLUMN_WEIGHTS_KEY);
    expect(stored[PANEL_COLUMN_WEIGHTS_KEY]['1x3']).toHaveLength(3);
    await page.reload();
    await expect(page.locator('#panel-grid iframe')).toHaveCount(3);
    await expect.poll(() => getColumnWidths(page)).toEqual(widened);

    // Keyboard: arrow keys move a focused edge. While panels are still
    // loading, focus protection pulls focus back to the unified input, so
    // focus the handle until it keeps focus past the protection's frame.
    const firstHandle = page.locator('.panel-resize-handle').first();
    await expect.poll(async () => {
      await firstHandle.focus();
      return firstHandle.evaluate(el => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.activeElement === el)));
      }));
    }, { timeout: 15_000 }).toBe(true);
    await page.keyboard.press('ArrowRight');
    const keyed = await getColumnWidths(page);
    expect(keyed[0] - widened[0]).toBe(16);

    // Double-click puts the columns back to equal widths.
    await page.locator('.panel-resize-handle').first().dblclick();
    await expect.poll(() => getColumnWidths(page)).toEqual(start);
  } finally {
    await extension.close();
  }
});

test('in a grid that scrolls sideways a dragged column grows alone', async () => {
  test.setTimeout(90_000);
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route(url => url.protocol === 'https:', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>provider</title>',
    }));
    const page = await openMultiPanel(extension, {
      providers: ['chatgpt', 'kimi', 'deepseek', 'gemini', 'grok'],
      layout: '1x5',
    });
    await expect(page.locator('.panel-resize-handle')).toHaveCount(4);
    const start = await getColumnWidths(page);
    expect(start).toEqual([400, 400, 400, 400, 400]);
    await dragHandle(page, 0, 120);
    const dragged = await getColumnWidths(page);
    expect(Math.abs(dragged[0] - 520)).toBeLessThanOrEqual(2);
    expect(dragged.slice(1)).toEqual([400, 400, 400, 400]);
    // Handles follow the columns.
    const handleBox = await page.locator('.panel-resize-handle').nth(1).boundingBox();
    const secondBox = await page.locator('#panel-grid .panel-item').nth(1).boundingBox();
    expect(Math.abs(handleBox.x + handleBox.width / 2 - (secondBox.x + secondBox.width + 2))).toBeLessThanOrEqual(1);
  } finally {
    await extension.close();
  }
});
