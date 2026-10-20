import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';
import { SNAPSHOT_METRICS, SNAPSHOT_THEMES } from '../../modules/share-snapshot.js';

// Chrome normally asks the user to confirm sharing the tab; these switches
// answer that dialog so the real getDisplayMedia path runs unattended.
const ACCEPT_TAB_CAPTURE = '--auto-accept-this-tab-capture';

// Solid provider background, so pixels from the cross-origin iframe are
// recognizable in the composed image.
const PROVIDER_BACKGROUND = [0, 160, 80];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Chrome refuses permission grants for chrome-extension:// origins, so the
// system clipboard is read back from an ordinary page instead.
const CLIPBOARD_CHECK_ORIGIN = 'https://clipboard-check.test';

async function readClipboardImage(context) {
  await context.route(`${CLIPBOARD_CHECK_ORIGIN}/**`, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>clipboard check</title>',
  }));
  await context.grantPermissions(['clipboard-read'], { origin: CLIPBOARD_CHECK_ORIGIN });
  const page = await context.newPage();
  try {
    await page.goto(`${CLIPBOARD_CHECK_ORIGIN}/`);
    await page.bringToFront();
    return await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      return { types: item.types, width: bitmap.width, height: bitmap.height };
    });
  } finally {
    await page.close();
  }
}

async function openChatgptPanel(extension) {
  const fixture = renderChatgptFixture({ composer: 'current' }).replace(
    '</head>',
    `<style>html, body { background: rgb(${PROVIDER_BACKGROUND.join(',')}) !important; }</style></head>`
  );
  await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
    contentType: 'text/html', body: fixture,
  }));
  const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
  await expect(page.frameLocator('iframe')
    .locator('[data-composer-placement="thread"] [data-composer-markdown]')).toBeVisible();
  return page;
}

async function sendAll(page, text) {
  await page.locator('#unified-input').fill(text);
  await page.locator('#send-all-btn').click();
  await expect(page.locator('#send-status')).toHaveText(/Sent to 1 AI/);
}

/**
 * Reads the preview image back and samples the pixels that tell the strips
 * and the capture apart.
 */
function inspectPreview(page) {
  return page.evaluate(async () => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixel = (x, y) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));

    const main = document.getElementById('main-content').getBoundingClientRect();
    const frame = document.querySelector('#panel-grid iframe').getBoundingClientRect();
    const scale = image.naturalWidth / main.width;
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      scale,
      captureHeight: Math.round(main.height * scale),
      frameCenter: { x: (frame.left - main.left + frame.width / 2) * scale, y: (frame.top - main.top + frame.height / 2) * scale },
      topLeft: pixel(2, 2),
      bottomLeft: pixel(2, image.naturalHeight - 2)
    };
  });
}

function samplePreviewPixel(page, x, y) {
  return page.evaluate(async ({ x, y }) => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
  }, { x, y });
}

const hexToRgb = (hex) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));

function expectColorNear(actual, expected, tolerance = 12) {
  actual.forEach((channel, index) => {
    expect(Math.abs(channel - expected[index]), `channel ${index} of ${actual} vs ${expected}`)
      .toBeLessThanOrEqual(tolerance);
  });
}

test('Share captures the panels with the prompt and watermark, then copies and downloads the PNG', async ({}, testInfo) => {
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [ACCEPT_TAB_CAPTURE],
  });
  try {
    const page = await openChatgptPanel(extension);
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await sendAll(page, 'Which answer explains snapshots best?');
    await page.locator('#share-snapshot-btn').click();

    const modal = page.locator('#share-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('it may show chat history in sidebars, account names or avatars');
    await expect(page.locator('#share-snapshot-btn')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('share-modal.png') });

    const preview = await inspectPreview(page);
    const { scale } = preview;
    const headerHeight = (SNAPSHOT_METRICS.headerPaddingY * 2 + SNAPSHOT_METRICS.promptLineHeight) * scale;
    const footerHeight = SNAPSHOT_METRICS.footerHeight * scale;
    expect(preview.height).toBeCloseTo(headerHeight + preview.captureHeight + footerHeight, -1);
    expectColorNear(preview.topLeft, hexToRgb(SNAPSHOT_THEMES.light.surface));
    expectColorNear(preview.bottomLeft, hexToRgb(SNAPSHOT_THEMES.light.surface));
    // Pixels from the cross-origin provider iframe made it into the image.
    expectColorNear(
      await samplePreviewPixel(page, preview.frameCenter.x, headerHeight + preview.frameCenter.y),
      PROVIDER_BACKGROUND,
      24
    );

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#share-download-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^panelize-comparison-\d{8}-\d{6}\.png$/);
    const downloadPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(downloadPath);
    const png = await readFile(downloadPath);
    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    // PNG IHDR stores width and height as big-endian integers at bytes 16-23.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([preview.width, preview.height]);

    await page.locator('#share-copy-btn').click();
    await expect(page.getByText('Image copied to clipboard')).toBeVisible();
    expect(await readClipboardImage(extension.context))
      .toEqual({ types: ['image/png'], width: preview.width, height: preview.height });

    await page.bringToFront();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    await expect(page.locator('#share-preview')).not.toHaveAttribute('src');
    expect(consoleErrors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('the options toggle removes the watermark and dark theme colors the strips', async ({}, testInfo) => {
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [ACCEPT_TAB_CAPTURE],
  });
  try {
    const options = await extension.context.newPage();
    await options.goto(extension.extensionUrl('options/options.html'));
    // Settings listeners are attached right after the provider list renders.
    await expect(options.locator('.provider-item').first()).toBeVisible();
    const toggle = options.locator('#share-watermark-toggle');
    await expect(toggle).toBeChecked();
    await options.locator('#share-watermark-toggle + .slider').click();
    await expect(toggle).not.toBeChecked();
    await expect(options.locator('#status-success'))
      .toContainText('Watermark on shared images disabled');
    await toggle.scrollIntoViewIfNeeded();
    await options.screenshot({ path: testInfo.outputPath('options-share-watermark.png') });
    await expect.poll(() => extension.serviceWorker.evaluate(
      async () => (await chrome.storage.sync.get('shareWatermarkEnabled')).shareWatermarkEnabled
    )).toBe(false);
    await options.close();

    await extension.serviceWorker.evaluate(() => chrome.storage.sync.set({ theme: 'dark' }));
    const page = await openChatgptPanel(extension);
    await sendAll(page, 'Dark snapshot');
    await page.locator('#share-snapshot-btn').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('share-modal-dark.png') });

    const preview = await inspectPreview(page);
    const headerHeight = (SNAPSHOT_METRICS.headerPaddingY * 2 + SNAPSHOT_METRICS.promptLineHeight) * preview.scale;
    expect(preview.height).toBeCloseTo(headerHeight + preview.captureHeight, -1);
    expectColorNear(preview.topLeft, hexToRgb(SNAPSHOT_THEMES.dark.surface));
    // Without the watermark the image ends with the captured panel.
    expect(preview.bottomLeft).not.toEqual(hexToRgb(SNAPSHOT_THEMES.dark.surface));
  } finally {
    await extension.close();
  }
});

/** Replaces the browser's screen capture with a stub for failure paths. */
function stubDisplayMedia(page, behavior) {
  return page.evaluate((mode) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      if (mode === 'cancel') {
        throw new DOMException('Permission denied by user', 'NotAllowedError');
      }
      // A stream that is not this tab: it carries no capture handle.
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      canvas.getContext('2d').fillRect(0, 0, 320, 200);
      return canvas.captureStream(10);
    };
  }, behavior);
}

test('cancelling the tab sharing dialog shows a notice and no preview', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openChatgptPanel(extension);
    await stubDisplayMedia(page, 'cancel');
    await page.locator('#share-snapshot-btn').click();
    await expect(page.getByText('Snapshot cancelled')).toBeVisible();
    await expect(page.locator('#share-modal')).toBeHidden();
    await expect(page.locator('#share-snapshot-btn')).toBeEnabled();
  } finally {
    await extension.close();
  }
});

test('a stream that is not this tab is refused instead of cropped', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openChatgptPanel(extension);
    await stubDisplayMedia(page, 'other-surface');
    await page.locator('#share-snapshot-btn').click();
    await expect(page.getByText('To take a snapshot, share this Panelize tab')).toBeVisible();
    await expect(page.locator('#share-modal')).toBeHidden();
  } finally {
    await extension.close();
  }
});
