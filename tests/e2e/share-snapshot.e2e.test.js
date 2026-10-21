import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';
import { CONVERSATION_COLORS, renderConversationFixture } from './fixtures/conversation-fixture.js';
import {
  SNAPSHOT_FRAME_STYLES,
  SNAPSHOT_MAX_OUTPUT_HEIGHT,
  getSnapshotFrameLayout,
} from '../../modules/share-snapshot.js';

// Chrome normally asks the user to confirm sharing the tab; this switch
// answers that dialog so the real getDisplayMedia path runs unattended.
const ACCEPT_TAB_CAPTURE = '--auto-accept-this-tab-capture';
// Lets the test click the toolbar icon through CDP (Extensions.triggerAction),
// which grants activeTab like a real click.
const UNSAFE_EXTENSION_DEBUGGING = '--enable-unsafe-extension-debugging';

// Solid provider background, so pixels from the cross-origin iframe are
// recognizable in the composed image.
const PROVIDER_BACKGROUND = [0, 160, 80];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const VISIBLE_TAB_FLAG = 'panelize.snapshotVisibleTabCaptured';

// Distinct answer block colors, far from the header, composer and page.
const BLOCK_COLORS = [
  [255, 200, 0], [0, 200, 200], [200, 0, 200], [120, 60, 0],
  [0, 120, 0], [255, 140, 140], [100, 100, 255], [180, 255, 100],
];
const CONVERSATION_PROMPT = 'Explain how HTTPS works in detail';
// Column inside the user bubble padding and the answer blocks of the fixture.
const FIXTURE_COLUMN_X = 30;

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

const PROVIDER_ORIGINS = {
  chatgpt: 'https://chatgpt.com',
  deepseek: 'https://chat.deepseek.com',
};

/**
 * Opens panels showing long conversations.
 * @param {object} extension
 * @param {{provider: string, blocks: number[][]}[]} conversations
 * @param {string} layout
 */
async function openConversationPanels(extension, conversations, layout = '1x1') {
  for (const { provider, blocks } of conversations) {
    const body = renderConversationFixture({ prompt: CONVERSATION_PROMPT, blocks });
    await extension.context.route(`${PROVIDER_ORIGINS[provider]}/**`, route => route.fulfill({
      contentType: 'text/html', body,
    }));
  }
  const page = await openMultiPanel(extension, {
    providers: conversations.map(({ provider }) => provider),
    layout,
  });
  for (let index = 0; index < conversations.length; index += 1) {
    await expect(page.frameLocator('#panel-grid iframe').nth(index).locator('.user')).toBeVisible();
  }
  // The prompt the snapshot aligns to, as if it was about to be sent again.
  await page.locator('#unified-input').fill(CONVERSATION_PROMPT);
  return page;
}

function getThreadScrollTops(page) {
  return Promise.all(page.frames()
    .filter(frame => frame.url().startsWith('https://'))
    .map(frame => frame.evaluate(() => {
      const thread = document.getElementById('thread');
      return thread ? { top: thread.scrollTop, max: thread.scrollHeight - thread.clientHeight } : null;
    })));
}

async function sendAll(page, text) {
  await page.locator('#unified-input').fill(text);
  await page.locator('#send-all-btn').click();
  await expect(page.locator('#send-status')).toHaveText(/Sent to 1 AI/);
}

/** Wraps getDisplayMedia so tests can tell which capture path ran. */
function countDisplayMedia(page) {
  return page.evaluate(() => {
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    window.__displayMediaCalls = 0;
    navigator.mediaDevices.getDisplayMedia = (...args) => {
      window.__displayMediaCalls += 1;
      return original(...args);
    };
  });
}

const getDisplayMediaCalls = page => page.evaluate(() => window.__displayMediaCalls);

/** Clicks the Panelize toolbar icon on `page`, as the user would. */
async function clickToolbarIcon(extension, page) {
  const session = await extension.context.browser().newBrowserCDPSession();
  try {
    const url = page.url();
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find(info => info.url === url);
    expect(tab, `tab target for ${url}`).toBeTruthy();
    await session.send('Extensions.triggerAction', { id: extension.extensionId, targetId: tab.targetId });
  } finally {
    await session.detach();
  }
}

/** Size of the preview and where the grid sits in it. */
function inspectPreview(page) {
  return page.evaluate(async () => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const grid = document.getElementById('panel-grid').getBoundingClientRect();
    const frames = Array.from(document.querySelectorAll('#panel-grid iframe'), frame => {
      const rect = frame.getBoundingClientRect();
      return { left: rect.left - grid.left, top: rect.top - grid.top, width: rect.width, height: rect.height };
    });
    return {
      src: image.src,
      width: image.naturalWidth,
      height: image.naturalHeight,
      grid: { width: grid.width, height: grid.height },
      frames,
    };
  });
}

/** Output scale of the preview: its width is the grid plus the frame padding. */
function getPreviewScale(preview, theme = 'light') {
  const padding = SNAPSHOT_FRAME_STYLES[theme].paddingX;
  return preview.width / (preview.grid.width + padding * 2);
}

function readPreviewPixels(page, points) {
  return page.evaluate(async (points) => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return points.map(({ x, y }) => Array.from(ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3)));
  }, points);
}

/** RGB values of one column of the preview, top to bottom. */
function readPreviewColumn(page, x) {
  return page.evaluate(async (x) => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(Math.round(x), 0, 1, image.naturalHeight).data;
    const column = [];
    for (let index = 0; index < data.length; index += 4) {
      column.push([data[index], data[index + 1], data[index + 2]]);
    }
    return column;
  }, x);
}

const isNear = (actual, expected, tolerance) => actual.every((channel, index) => Math.abs(channel - expected[index]) <= tolerance);

/**
 * Splits a column into runs of named colors; anything else is 'other'.
 * @param {number[][]} column
 * @param {Record<string, number[]>} palette
 */
function getColorRuns(column, palette, tolerance = 24) {
  const entries = Object.entries(palette);
  const runs = [];
  column.forEach((pixel, y) => {
    const name = entries.find(([, color]) => isNear(pixel, color, tolerance))?.[0] || 'other';
    const last = runs[runs.length - 1];
    if (last?.name === name) {
      last.length += 1;
    } else {
      runs.push({ name, start: y, length: 1 });
    }
  });
  return runs;
}

const CONVERSATION_PALETTE = {
  page: CONVERSATION_COLORS.page,
  header: CONVERSATION_COLORS.header,
  composer: CONVERSATION_COLORS.composer,
  earlier: CONVERSATION_COLORS.earlier,
  user: CONVERSATION_COLORS.user,
  ...Object.fromEntries(BLOCK_COLORS.map((color, index) => [`block${index}`, color])),
};

/**
 * Color runs down the fixture column of panel `index`, inside the card.
 * @param {object} frame - getSnapshotFrameLayout options of the preview,
 *   without sizes.
 */
async function readConversationRuns(page, preview, index, frame = {}) {
  const scale = getPreviewScale(preview);
  const empty = getSnapshotFrameLayout({
    contentWidth: preview.width - Math.round(SNAPSHOT_FRAME_STYLES.light.paddingX * scale) * 2,
    contentHeight: 0,
    scale,
    titleLineCount: 1,
    ...frame,
  });
  const top = empty.content.y;
  const bottom = preview.height - (empty.height - empty.content.y);
  const x = empty.content.x + (preview.frames[index].left + FIXTURE_COLUMN_X) * scale;
  const column = (await readPreviewColumn(page, x)).slice(top, bottom);
  // Runs shorter than a few pixels are antialiased edges.
  return getColorRuns(column, CONVERSATION_PALETTE).filter(run => run.length > 3 * scale);
}

const hexToRgb = (hex) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));

function expectColorNear(actual, expected, tolerance = 12) {
  actual.forEach((channel, index) => {
    expect(Math.abs(channel - expected[index]), `channel ${index} of ${actual} vs ${expected}`)
      .toBeLessThanOrEqual(tolerance);
  });
}

async function waitForNewPreview(page, previousSrc) {
  await expect.poll(() => page.locator('#share-preview').getAttribute('src')).not.toBe(previousSrc);
  return inspectPreview(page);
}

async function getExpectedHint(extension) {
  const shortcut = await extension.serviceWorker.evaluate(async () => (
    (await chrome.commands.getAll()).find(command => command.name === '_execute_action')?.shortcut || ''
  ));
  return shortcut
    ? `Tip: press ${shortcut} on this page to skip Chrome's confirmation`
    : 'Tip: click the Panelize toolbar icon on this page to skip Chrome\'s confirmation';
}

test('Share falls back to tab sharing with a shortcut hint, then copies and downloads the framed PNG', async ({}, testInfo) => {
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
    await countDisplayMedia(page);

    await sendAll(page, 'Which answer explains snapshots best?');
    await page.locator('#share-snapshot-btn').click();

    const modal = page.locator('#share-modal');
    await expect(modal).toBeVisible();
    await expect(modal).toContainText('it may show chat history in sidebars, account names or avatars');
    // Without an activeTab grant the page asked Chrome to share the tab.
    expect(await getDisplayMediaCalls(page)).toBe(1);
    await expect(page.locator('#share-capture-hint-text')).toHaveText(await getExpectedHint(extension));
    await expect(page.locator('#share-capture-hint')).toBeVisible();
    expect(await page.evaluate(flag => sessionStorage.getItem(flag), VISIBLE_TAB_FLAG)).toBeNull();
    await expect(page.locator('.share-mode-btn[data-mode="current"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#share-title-input')).toHaveValue('Which answer explains snapshots best?');
    await expect(page.locator('#share-snapshot-btn')).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('share-modal.png') });

    // Layout A: brand row, "PROMPT" label, one headline line, the capture.
    const preview = await inspectPreview(page);
    const scale = getPreviewScale(preview);
    const layout = getSnapshotFrameLayout({
      contentWidth: preview.width - Math.round(SNAPSHOT_FRAME_STYLES.light.paddingX * scale) * 2,
      contentHeight: Math.round(preview.grid.height * scale),
      scale,
      theme: 'light',
      titleLineCount: 1,
      showWatermark: true,
    });
    expect(Math.abs(preview.height - layout.height)).toBeLessThanOrEqual(2);
    const [corner, providerPixel] = await readPreviewPixels(page, [
      { x: 2, y: 2 },
      {
        x: layout.content.x + (preview.frames[0].left + preview.frames[0].width / 2) * scale,
        y: layout.content.y + (preview.frames[0].top + preview.frames[0].height / 2) * scale,
      },
    ]);
    expectColorNear(corner, hexToRgb(SNAPSHOT_FRAME_STYLES.light.background));
    // Pixels from the cross-origin provider iframe made it into the image.
    expectColorNear(providerPixel, PROVIDER_BACKGROUND, 24);

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

test('editing the title re-renders the headline, and an empty title removes it', async () => {
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [ACCEPT_TAB_CAPTURE],
  });
  try {
    const page = await openChatgptPanel(extension);
    // Right after sending, the page keeps pulling focus back to the prompt
    // box; typing a title must not be interrupted by that.
    await sendAll(page, 'Short prompt');
    await page.locator('#share-snapshot-btn').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    await expect(page.locator('#share-copy-btn')).toBeFocused();
    const title = page.locator('#share-title-input');
    await expect(title).toHaveValue('Short prompt');

    const oneLine = await inspectPreview(page);
    const scale = getPreviewScale(oneLine);
    const layoutFor = (titleLineCount) => getSnapshotFrameLayout({
      contentWidth: oneLine.width - Math.round(SNAPSHOT_FRAME_STYLES.light.paddingX * scale) * 2,
      contentHeight: Math.round(oneLine.grid.height * scale),
      scale,
      titleLineCount,
    }).height;

    await title.fill('');
    const noTitle = await waitForNewPreview(page, oneLine.src);
    expect(noTitle.width).toBe(oneLine.width);
    expect(oneLine.height - noTitle.height).toBe(layoutFor(1) - layoutFor(0));

    await title.click();
    await page.keyboard.type('A much longer headline that keeps going '.repeat(8).trim(), { delay: 5 });
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('A much longer headline that keeps going '.repeat(8).trim());
    const longTitle = await waitForNewPreview(page, noTitle.src);
    // Keystrokes are debounced into one render after typing stops.
    await expect.poll(async () => (await inspectPreview(page)).height).toBe(oneLine.height + layoutFor(3) - layoutFor(1));
    expect(longTitle.width).toBe(oneLine.width);
    await expect(page.locator('#unified-input')).toHaveValue('');
  } finally {
    await extension.close();
  }
});

test('the options toggle removes the brand row and the dark theme uses layout B', async ({}, testInfo) => {
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

    // Layout B without the brand row: quoted headline, provider subline,
    // window card.
    const preview = await inspectPreview(page);
    const scale = getPreviewScale(preview, 'dark');
    const layoutOptions = {
      contentWidth: preview.width - Math.round(SNAPSHOT_FRAME_STYLES.dark.paddingX * scale) * 2,
      contentHeight: Math.round(preview.grid.height * scale),
      scale,
      theme: 'dark',
      titleLineCount: 1,
      hasSubline: true,
    };
    const layout = getSnapshotFrameLayout({ ...layoutOptions, showWatermark: false });
    expect(Math.abs(preview.height - layout.height)).toBeLessThanOrEqual(2);
    expect(layout.height).toBeLessThan(getSnapshotFrameLayout({ ...layoutOptions, showWatermark: true }).height);
    const [titleBar, providerPixel] = await readPreviewPixels(page, [
      { x: layout.card.x + layout.card.width / 2, y: layout.card.y + layout.card.titleBarHeight / 2 },
      { x: layout.content.x + preview.frames[0].width * scale / 2, y: layout.content.y + preview.frames[0].height * scale / 2 },
    ]);
    expectColorNear(titleBar, hexToRgb(SNAPSHOT_FRAME_STYLES.dark.titleBarColor));
    expectColorNear(providerPixel, PROVIDER_BACKGROUND, 24);
  } finally {
    await extension.close();
  }
});

test('the toolbar icon on the Panelize tab captures silently and the hint never shows', async ({}, testInfo) => {
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [UNSAFE_EXTENSION_DEBUGGING],
  });
  try {
    const page = await openConversationPanels(extension, [{ provider: 'chatgpt', blocks: BLOCK_COLORS.slice(0, 3) }]);
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await countDisplayMedia(page);
    const [before] = await getThreadScrollTops(page);
    expect(before.top).toBe(before.max);
    const pagesBefore = extension.context.pages().length;

    await clickToolbarIcon(extension, page);
    await expect(page.locator('#share-modal')).toBeVisible();
    // A snapshot of this page, not a new Panelize tab.
    expect(extension.context.pages().length).toBe(pagesBefore);
    expect(await getDisplayMediaCalls(page)).toBe(0);
    await expect(page.locator('#share-capture-hint')).toBeHidden();
    expect(await page.evaluate(flag => sessionStorage.getItem(flag), VISIBLE_TAB_FLAG)).toBe('1');
    await page.screenshot({ path: testInfo.outputPath('share-modal-visible-tab.png') });

    // Current view: the user message sits right under the provider header.
    const preview = await inspectPreview(page);
    const scale = getPreviewScale(preview);
    const runs = await readConversationRuns(page, preview, 0);
    const names = runs.map(run => run.name);
    expect(names).not.toContain('earlier');
    const header = names.indexOf('header');
    expect(names.slice(header, header + 3)).toEqual(['header', 'page', 'user']);
    expect(Math.abs(runs[header + 1].length - 16 * scale)).toBeLessThanOrEqual(3 * scale);
    // What is on screen, the composer included.
    expect(names).toContain('composer');
    // The conversation is scrolled back once the capture is done.
    expect(await getThreadScrollTops(page)).toEqual([before]);

    // The grant lasts for this page: the Share button stays silent too.
    await page.keyboard.press('Escape');
    await expect(page.locator('#share-modal')).toBeHidden();
    await page.locator('#share-snapshot-btn').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    expect(await getDisplayMediaCalls(page)).toBe(0);
    await expect(page.locator('#share-capture-hint')).toBeHidden();
    expect(consoleErrors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('Full answers stitches every panel in lock-step, without headers, composer or repeats', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [UNSAFE_EXTENSION_DEBUGGING],
  });
  try {
    const page = await openConversationPanels(extension, [
      { provider: 'chatgpt', blocks: BLOCK_COLORS.slice(0, 6) },
      { provider: 'deepseek', blocks: BLOCK_COLORS.slice(6, 8) },
    ], '1x2');
    const consoleErrors = [];
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    const before = await getThreadScrollTops(page);

    await clickToolbarIcon(extension, page);
    await expect(page.locator('#share-modal')).toBeVisible();
    const current = await inspectPreview(page);

    await page.locator('.share-mode-btn[data-mode="full"]').click();
    await expect(page.locator('#snapshot-progress')).toBeVisible();
    await expect(page.locator('#snapshot-progress-text')).toHaveText(/Capturing screen \d+ of \d+/);
    await expect(page.locator('.share-mode-btn[data-mode="current"]')).toBeDisabled();
    await expect(page.locator('#snapshot-progress')).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('#share-modal')).toBeVisible();
    await expect(page.locator('.share-mode-btn[data-mode="full"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#share-capture-notes')).toBeHidden();
    const full = await waitForNewPreview(page, current.src);
    expect(full.width).toBe(current.width);
    expect(full.height).toBeGreaterThan(current.height + 1000);
    expect(full.height).toBeLessThanOrEqual(SNAPSHOT_MAX_OUTPUT_HEIGHT);
    await page.screenshot({ path: testInfo.outputPath('share-modal-full.png') });
    await page.locator('#share-preview').screenshot({ path: testInfo.outputPath('share-preview-full.png') });

    const scale = getPreviewScale(full);
    const blockHeight = CONVERSATION_COLORS.blockHeight * scale;
    for (const [index, blocks] of [[0, BLOCK_COLORS.slice(0, 6)], [1, BLOCK_COLORS.slice(6, 8)]]) {
      const runs = await readConversationRuns(page, full, index, { hasNote: false });
      const names = runs.map(run => run.name);
      // The provider header shows once, at the top; the composer never.
      expect(names.filter(name => name === 'header'), `panel ${index}`).toHaveLength(1);
      expect(names, `panel ${index}`).not.toContain('composer');
      expect(names, `panel ${index}`).not.toContain('earlier');
      const blockRuns = runs.filter(run => run.name.startsWith('block'));
      expect(blockRuns.map(run => run.name), `panel ${index}`)
        .toEqual(blocks.map(color => `block${BLOCK_COLORS.indexOf(color)}`));
      // No overlap between screens: every block keeps its height.
      blockRuns.forEach(run => {
        expect(Math.abs(run.length - blockHeight), `${run.name} of panel ${index}`).toBeLessThanOrEqual(3 * scale);
      });
      if (index === 1) {
        // The shorter answer is filled to the row height with its background.
        const last = blockRuns[blockRuns.length - 1];
        const fill = runs[runs.indexOf(last) + 1];
        expect(fill.name).toBe('page');
        expect(fill.length).toBeGreaterThan(3 * blockHeight);
      }
    }
    // Panels are back where they were.
    expect(await getThreadScrollTops(page)).toEqual(before);

    // The current view is kept; switching back does not capture again.
    await page.locator('.share-mode-btn[data-mode="current"]').click();
    await expect(page.locator('.share-mode-btn[data-mode="current"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#snapshot-progress')).toBeHidden();
    await expect.poll(async () => (await inspectPreview(page)).height).toBe(current.height);
    expect(consoleErrors).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('Full answers over one tab-sharing stream truncates long answers with a note, and Cancel restores the panels', async ({}, testInfo) => {
  test.setTimeout(150_000);
  const extension = await launchExtension({
    viewport: { width: 1280, height: 800 },
    args: [ACCEPT_TAB_CAPTURE],
  });
  try {
    // About 9000 px of answer, more than fits under the height cap.
    const blocks = Array.from({ length: 30 }, (_, index) => BLOCK_COLORS[index % BLOCK_COLORS.length]);
    const page = await openConversationPanels(extension, [{ provider: 'chatgpt', blocks }]);
    await countDisplayMedia(page);
    const before = await getThreadScrollTops(page);

    await page.locator('#share-snapshot-btn').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    const current = await inspectPreview(page);
    await page.locator('.share-mode-btn[data-mode="full"]').click();
    await expect(page.locator('#snapshot-progress')).toBeHidden({ timeout: 90_000 });
    // One shared stream for the whole run.
    expect(await getDisplayMediaCalls(page)).toBe(2);
    const notes = page.locator('#share-capture-notes');
    await expect(notes).toBeVisible();
    await expect(notes).toHaveText(/^Long answers truncated — showing the first \d+ screens$/);
    const full = await waitForNewPreview(page, current.src);
    expect(full.height).toBeLessThanOrEqual(SNAPSHOT_MAX_OUTPUT_HEIGHT);
    expect(full.height).toBeGreaterThan(SNAPSHOT_MAX_OUTPUT_HEIGHT - 400);
    await page.locator('#share-preview').screenshot({ path: testInfo.outputPath('share-preview-truncated.png') });
    expect(await getThreadScrollTops(page)).toEqual(before);

    // Cancel a new run halfway: the dialog keeps the current view.
    await page.locator('.share-mode-btn[data-mode="current"]').click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#share-modal')).toBeHidden();
    await page.locator('#share-snapshot-btn').click();
    await expect(page.locator('#share-modal')).toBeVisible();
    await page.locator('.share-mode-btn[data-mode="full"]').click();
    await expect(page.locator('#snapshot-progress-text')).toHaveText(/Capturing screen [3-9] of/);
    await page.locator('#snapshot-cancel-btn').click();
    await expect(page.getByText('Snapshot cancelled')).toBeVisible();
    await expect(page.locator('#snapshot-progress')).toBeHidden();
    await expect(page.locator('#share-modal')).toBeVisible();
    await expect(page.locator('.share-mode-btn[data-mode="current"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.share-mode-btn[data-mode="full"]')).toBeEnabled();
    await expect.poll(() => getThreadScrollTops(page)).toEqual(before);
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
    await expect(page.locator('#snapshot-progress')).toBeHidden();
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
