import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchExtension } from '../e2e/extension-harness.js';
import {
  LIVE_HEADLESS,
  LIVE_IGNORED_DEFAULT_ARGS,
  LIVE_SEND_ENABLED,
  LIVE_USER_DATA_DIR,
  configureLiveProviders,
  prepareLiveExtension,
} from './live-harness.js';

const SHARE_PROVIDERS = ['chatgpt', 'claude', 'gemini', 'deepseek'];

/** Short question so each provider answers within the wait below. */
const LIVE_PROMPT = 'In one sentence: why compare answers from several AI assistants?';

/** Time for the four providers to stream their answers before the snapshot. */
const ANSWER_WAIT_MS = 30000;

/** Evidence goes next to the Phase 0 spike output; artifacts/ is gitignored. */
const EVIDENCE_DIR = path.resolve(process.env.PANELIZE_SHARE_EVIDENCE_DIR || 'artifacts/share-snapshot/live');

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Real 2x2 comparison on the logged-in live profile: send one prompt, take a
 * snapshot through Chrome's tab sharing (auto-accepted by a switch), then copy
 * and download it. Sending uses provider quota, so it needs PANELIZE_LIVE_SEND=1.
 * Temporary chat keeps the prompt out of history where the provider supports it.
 */
test('Share snapshot of a live 2x2 comparison', async () => {
  test.skip(!LIVE_SEND_ENABLED, 'Set PANELIZE_LIVE_SEND=1: the snapshot needs real answers.');
  test.setTimeout(240000);
  await mkdir(EVIDENCE_DIR, { recursive: true });

  const extensionPath = await prepareLiveExtension();
  const extension = await launchExtension({
    extensionPath,
    userDataDir: LIVE_USER_DATA_DIR,
    headless: LIVE_HEADLESS,
    ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled', '--auto-accept-this-tab-capture'],
  });
  const consoleMessages = [];
  try {
    await configureLiveProviders(extension.serviceWorker, SHARE_PROVIDERS, { layout: '2x2' });
    const page = await extension.context.newPage();
    page.on('console', (message) => {
      if (['error', 'warning'].includes(message.type())) {
        consoleMessages.push({ type: message.type(), text: message.text(), url: message.location().url });
      }
    });
    page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));

    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    await expect(page.locator('#panel-grid iframe')).toHaveCount(SHARE_PROVIDERS.length);
    for (const frame of await page.locator('#panel-grid iframe').elementHandles()) {
      await (await frame.contentFrame()).waitForLoadState('load', { timeout: 45000 });
    }

    const temporaryChat = page.locator('#temporary-chat-btn');
    await temporaryChat.click();
    await expect(temporaryChat).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
    // Providers reload into temporary mode.
    await page.waitForTimeout(8000);

    await page.locator('#unified-input').fill(LIVE_PROMPT);
    await page.locator('#send-all-btn').click();
    const sendStatus = await expect(page.locator('#send-status'))
      .toHaveText(/Sent to/, { timeout: 60000 })
      .then(() => page.locator('#send-status').textContent());
    await page.waitForTimeout(ANSWER_WAIT_MS);
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'comparison-before-share.png') });

    await page.locator('#share-snapshot-btn').click();
    const modal = page.locator('#share-modal');
    await expect(modal).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'share-modal.png') });

    const preview = await page.evaluate(async () => {
      const image = document.getElementById('share-preview');
      await image.decode();
      const main = document.getElementById('main-content').getBoundingClientRect();
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        mainContent: { width: main.width, height: main.height },
        viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      };
    });

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#share-download-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^panelize-comparison-\d{8}-\d{6}\.png$/);
    const downloadPath = path.join(EVIDENCE_DIR, download.suggestedFilename());
    await download.saveAs(downloadPath);
    const png = await readFile(downloadPath);
    expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([preview.width, preview.height]);

    await page.locator('#share-copy-btn').click();
    await expect(page.getByText('Image copied to clipboard')).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE_DIR, 'share-copied.png') });

    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    await writeFile(path.join(EVIDENCE_DIR, 'summary.json'), `${JSON.stringify({
      providers: SHARE_PROVIDERS,
      prompt: LIVE_PROMPT,
      sendStatus,
      preview,
      download: path.basename(downloadPath),
      pageErrors: consoleMessages.filter((message) => message.type === 'pageerror'),
      consoleMessages,
    }, null, 2)}\n`);
    expect(consoleMessages.filter((message) => message.type === 'pageerror')).toEqual([]);
  } finally {
    await extension.close();
  }
});
