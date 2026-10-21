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

/**
 * PANELIZE_SHARE_PROVIDERS=chatgpt,gemini,deepseek leaves a provider out,
 * e.g. when its account is close to a usage limit.
 */
const SHARE_PROVIDERS = process.env.PANELIZE_SHARE_PROVIDERS
  ? process.env.PANELIZE_SHARE_PROVIDERS.split(',').map((id) => id.trim()).filter(Boolean)
  : ['chatgpt', 'claude', 'gemini', 'deepseek'];
const SHARE_LAYOUT = SHARE_PROVIDERS.length === 4 ? '2x2' : `1x${SHARE_PROVIDERS.length}`;

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
    await configureLiveProviders(extension.serviceWorker, SHARE_PROVIDERS, { layout: SHARE_LAYOUT });
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

/** Long answer, so "Full answers" has to scroll and stitch every panel. */
const LONG_PROMPT = 'Explain how HTTPS works in detail, at least 800 words';

/** v2 evidence: both layouts, both modes, the dialog on desktop and phone. */
const V2_EVIDENCE_DIR = path.resolve(process.env.PANELIZE_SHARE_V2_EVIDENCE_DIR || 'artifacts/share-snapshot/v2');

/** Answers count as finished once no panel's text grew for this long. */
const ANSWER_STABLE_MS = 20000;
const ANSWER_POLL_MS = 5000;
const ANSWER_MAX_WAIT_MS = 240000;

const PROVIDER_HOSTS = {
  chatgpt: 'chatgpt.com',
  claude: 'claude.ai',
  gemini: 'gemini.google.com',
  grok: 'grok.com',
  deepseek: 'chat.deepseek.com',
};

function findProviderFrame(page, providerId) {
  return page.frames().find((frame) => {
    try {
      return new URL(frame.url()).hostname === PROVIDER_HOSTS[providerId];
    } catch {
      return false;
    }
  });
}

/** Text length of each provider page; cross-origin frames are read through Playwright. */
async function readAnswerLengths(page, providers = SHARE_PROVIDERS) {
  const lengths = {};
  for (const id of providers) {
    const frame = findProviderFrame(page, id);
    lengths[id] = frame
      ? await frame.evaluate(() => document.body?.innerText.length || 0).catch(() => -1)
      : -1;
  }
  return lengths;
}

/**
 * Providers whose page shows the prompt, polled for a while after Send All.
 * @returns {Promise<string[]>} Providers still without it.
 */
async function waitForPromptDelivery(page, prompt, timeoutMs = 30000, providers = SHARE_PROVIDERS) {
  const deadline = Date.now() + timeoutMs;
  let missing = providers;
  while (Date.now() < deadline) {
    const results = await Promise.all(providers.map(async (id) => {
      const frame = findProviderFrame(page, id);
      const shown = frame
        ? await frame.evaluate((text) => document.body?.innerText.includes(text), prompt).catch(() => false)
        : false;
      return shown ? null : id;
    }));
    missing = results.filter(Boolean);
    if (missing.length === 0) break;
    await page.waitForTimeout(2000);
  }
  return missing;
}

/**
 * Types the prompt straight into a provider page. Only used when Send All did
 * not reach it, so the snapshot still has an answer there; the summary says so.
 */
async function sendDirectly(page, providerId, prompt) {
  const frame = findProviderFrame(page, providerId);
  const editor = frame.locator(EDITOR_SELECTORS[providerId]).first();
  await editor.click();
  await editor.pressSequentially(prompt);
  await editor.press('Enter');
}

const EDITOR_SELECTORS = {
  gemini: '.ql-editor',
  chatgpt: '#prompt-textarea',
  claude: '[contenteditable="true"]',
  grok: '[contenteditable="true"], textarea',
  deepseek: 'textarea',
};

async function waitForAnswersToSettle(page, providers = SHARE_PROVIDERS) {
  const started = Date.now();
  let last = null;
  let stableSince = Date.now();
  const history = [];
  while (Date.now() - started < ANSWER_MAX_WAIT_MS) {
    await page.waitForTimeout(ANSWER_POLL_MS);
    const lengths = await readAnswerLengths(page, providers);
    history.push({ seconds: Math.round((Date.now() - started) / 1000), ...lengths });
    if (last && JSON.stringify(lengths) === JSON.stringify(last)) {
      if (Date.now() - stableSince >= ANSWER_STABLE_MS) {
        return { settled: true, history };
      }
    } else {
      stableSince = Date.now();
    }
    last = lengths;
  }
  return { settled: false, history };
}

/** Applies a theme the way the options page does: save it, then apply it. */
function setTheme(page, theme) {
  return page.evaluate(async (value) => {
    const { saveSetting } = await import(chrome.runtime.getURL('modules/settings.js'));
    const { applyTheme } = await import(chrome.runtime.getURL('modules/theme-manager.js'));
    await saveSetting('theme', value);
    return applyTheme();
  }, theme);
}

/**
 * Asks every panel what the snapshot would see (prompt found, conversation
 * clip, scroll range), then puts it back. Same messages the capture uses.
 */
function probePanels(page, prompt) {
  return page.evaluate(async (text) => {
    const { createSnapshotBridge, SNAPSHOT_MESSAGES } = await import(chrome.runtime.getURL('modules/snapshot-capture.js'));
    const bridge = createSnapshotBridge();
    try {
      const frames = Array.from(document.querySelectorAll('#panel-grid iframe'));
      const states = await Promise.all(frames.map((iframe) => bridge.request(
        iframe, SNAPSHOT_MESSAGES.PREPARE, { align: true, prompt: text }, 2500
      )));
      await Promise.all(frames.map((iframe) => bridge.request(iframe, SNAPSHOT_MESSAGES.RESTORE, {}, 1500)));
      return states.map((state, index) => ({
        src: new URL(frames[index].src).hostname,
        answered: Boolean(state),
        provider: state?.provider ?? null,
        matched: state?.matched ?? null,
        clip: state?.clip ?? null,
        scrollTop: state?.scrollTop ?? null,
        maxScrollTop: state?.maxScrollTop ?? null,
        error: state?.error ?? null,
      }));
    } finally {
      bridge.dispose();
    }
  }, prompt);
}

async function clickToolbarIcon(extension, page) {
  const session = await extension.context.browser().newBrowserCDPSession();
  try {
    const { targetInfos } = await session.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = targetInfos.find((info) => info.url === page.url());
    expect(tab, 'tab target of the multi-panel page').toBeTruthy();
    await session.send('Extensions.triggerAction', { id: extension.extensionId, targetId: tab.targetId });
  } finally {
    await session.detach();
  }
}

async function waitForCaptureToFinish(page, mode) {
  await expect(page.locator('body')).not.toHaveClass(/snapshot-capturing/, { timeout: 180000 });
  await expect(page.locator(`.share-mode-btn[data-mode="${mode}"]`)).toHaveAttribute('aria-checked', 'true');
}

async function readModalState(page) {
  return page.evaluate(async () => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const notes = document.getElementById('share-capture-notes');
    const hint = document.getElementById('share-capture-hint');
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      src: image.src,
      notes: notes.hidden ? '' : notes.textContent,
      hint: hint.hidden ? '' : hint.textContent.trim(),
      title: document.getElementById('share-title-input').value,
      theme: document.documentElement.getAttribute('data-theme'),
      displayMediaCalls: window.__displayMediaCalls,
      visibleTabFlag: sessionStorage.getItem('panelize.snapshotVisibleTabCaptured'),
      window: { innerWidth, innerHeight, devicePixelRatio },
    };
  });
}

async function savePreview(page, fileName, directory = V2_EVIDENCE_DIR) {
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#share-download-btn').click();
  const download = await downloadPromise;
  const target = path.join(directory, fileName);
  await download.saveAs(target);
  const png = await readFile(target);
  expect(Array.from(png.subarray(0, 8))).toEqual(PNG_SIGNATURE);
  return { file: fileName, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function captureFull(page) {
  const previousSrc = await page.locator('#share-preview').getAttribute('src');
  await page.locator('.share-mode-btn[data-mode="full"]').click();
  // The progress strip shows while the panels scroll.
  await expect(page.locator('#snapshot-progress')).toBeVisible({ timeout: 10000 }).catch(() => {});
  const progress = await page.locator('#snapshot-progress-text').textContent().catch(() => '');
  await waitForCaptureToFinish(page, 'full');
  await expect.poll(() => page.locator('#share-preview').getAttribute('src')).not.toBe(previousSrc);
  return progress;
}

/**
 * v2 on the logged-in live profile: a long answer from all four providers,
 * snapshotted silently from the toolbar icon in both modes and both layouts
 * (A light, B dark). Records what each panel reported, so a provider whose
 * page cannot be stitched shows up in the summary. Needs PANELIZE_LIVE_SEND=1.
 */
test('Share snapshot v2: layouts and full answers on a live 2x2', async () => {
  test.skip(!LIVE_SEND_ENABLED, 'Set PANELIZE_LIVE_SEND=1: the snapshot needs real answers.');
  test.setTimeout(900000);
  await mkdir(V2_EVIDENCE_DIR, { recursive: true });

  const extensionPath = await prepareLiveExtension();
  const extension = await launchExtension({
    extensionPath,
    userDataDir: LIVE_USER_DATA_DIR,
    headless: LIVE_HEADLESS,
    ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
    // No viewport emulation: the toolbar capture takes the real window, so
    // the page must be laid out at the real window size.
    viewport: null,
    args: [
      '--window-size=1440,1000',
      '--disable-blink-features=AutomationControlled',
      '--auto-accept-this-tab-capture',
      '--enable-unsafe-extension-debugging',
    ],
  });
  const consoleMessages = [];
  const summary = { providers: SHARE_PROVIDERS, prompt: LONG_PROMPT, steps: {} };
  let page = null;
  let originalTheme = null;
  try {
    originalTheme = await extension.serviceWorker.evaluate(async () => (
      (await chrome.storage.sync.get({ theme: 'auto' })).theme
    ));
    await configureLiveProviders(extension.serviceWorker, SHARE_PROVIDERS, { layout: SHARE_LAYOUT });
    page = await extension.context.newPage();
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleMessages.push({ type: 'error', text: message.text(), url: message.location().url });
      }
    });
    page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));
    await page.addInitScript(() => {
      // Provider frames get this script too; only the Panelize page captures.
      if (location.protocol !== 'chrome-extension:') return;
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.__displayMediaCalls = 0;
      navigator.mediaDevices.getDisplayMedia = (...args) => {
        window.__displayMediaCalls += 1;
        return original(...args);
      };
    });

    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    await expect(page.locator('#panel-grid iframe')).toHaveCount(SHARE_PROVIDERS.length);
    for (const frame of await page.locator('#panel-grid iframe').elementHandles()) {
      await (await frame.contentFrame()).waitForLoadState('load', { timeout: 45000 });
    }
    await setTheme(page, 'light');

    const temporaryChat = page.locator('#temporary-chat-btn');
    await temporaryChat.click();
    await expect(temporaryChat).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
    // Providers reload into temporary mode; give the slowest time to settle.
    await page.waitForTimeout(15000);

    await page.locator('#unified-input').fill(LONG_PROMPT);
    await page.locator('#send-all-btn').click();
    await expect(page.locator('#send-status')).toHaveText(/Sent to/, { timeout: 60000 });
    summary.window = await page.evaluate(() => ({
      innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio,
    }));
    summary.sendStatus = await page.locator('#send-status').textContent();
    summary.notReachedBySendAll = await waitForPromptDelivery(page, LONG_PROMPT);
    for (const id of summary.notReachedBySendAll) {
      await sendDirectly(page, id, LONG_PROMPT);
    }
    summary.notReachedAfterRetry = summary.notReachedBySendAll.length
      ? await waitForPromptDelivery(page, LONG_PROMPT)
      : [];
    summary.answers = await waitForAnswersToSettle(page);
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'comparison.png') });
    summary.probe = await probePanels(page, LONG_PROMPT);

    // Layout A: toolbar icon, so the capture is silent.
    const modal = page.locator('#share-modal');
    await clickToolbarIcon(extension, page);
    await expect(modal).toBeVisible({ timeout: 30000 });
    await waitForCaptureToFinish(page, 'current');
    summary.steps.aCurrent = { ...(await readModalState(page)), ...(await savePreview(page, 'A-current.png')) };
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'modal-desktop-A-current.png') });

    summary.steps.aFull = { progress: await captureFull(page) };
    Object.assign(summary.steps.aFull, await readModalState(page), await savePreview(page, 'A-full.png'));
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'modal-desktop-A-full.png') });
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    // Layout B: the page follows the theme; the Share button reuses the grant.
    summary.theme = await setTheme(page, 'dark');
    await page.locator('#share-snapshot-btn').click();
    await expect(modal).toBeVisible({ timeout: 30000 });
    await waitForCaptureToFinish(page, 'current');
    summary.steps.bCurrent = { ...(await readModalState(page)), ...(await savePreview(page, 'B-current.png')) };
    summary.steps.bFull = { progress: await captureFull(page) };
    Object.assign(summary.steps.bFull, await readModalState(page), await savePreview(page, 'B-full.png'));
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'modal-desktop-B-full.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'modal-390-B-full.png') });
    await setTheme(page, 'light');
    await page.locator('.share-mode-btn[data-mode="current"]').click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(V2_EVIDENCE_DIR, 'modal-390-light.png') });
    summary.mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      modal: document.querySelector('.share-modal-content').getBoundingClientRect().toJSON(),
      footer: document.querySelector('#share-modal .modal-footer').getBoundingClientRect().toJSON(),
    }));
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    summary.steps.allSilent = summary.steps.bFull.displayMediaCalls === 0;
    summary.consoleMessages = consoleMessages;
    summary.extensionErrors = consoleMessages.filter((message) => (
      message.type === 'pageerror' || (message.url || '').startsWith('chrome-extension://')
    ));
    expect(summary.steps.aCurrent.hint).toBe('');
    expect(summary.steps.bFull.displayMediaCalls).toBe(0);
    expect(summary.extensionErrors).toEqual([]);
  } finally {
    await writeFile(path.join(V2_EVIDENCE_DIR, 'summary.json'), `${JSON.stringify({ ...summary, consoleMessages }, null, 2)}\n`);
    if (page && originalTheme) {
      await setTheme(page, originalTheme).catch(() => {});
    }
    await extension.close();
  }
});

/** v3 runs both prompts Denji tried: PANELIZE_SHARE_PROMPT picks one. */
const V3_PROVIDERS = process.env.PANELIZE_SHARE_PROVIDERS
  ? SHARE_PROVIDERS
  : ['chatgpt', 'gemini', 'grok', 'deepseek'];
const V3_PROMPT = process.env.PANELIZE_SHARE_PROMPT || LONG_PROMPT;
const V3_EVIDENCE_DIR = path.resolve(
  process.env.PANELIZE_SHARE_V3_EVIDENCE_DIR || 'artifacts/share-snapshot/v3',
  process.env.PANELIZE_SHARE_RUN || 'en'
);
const ALIGNMENT_LOG_PREFIX = '[Multi-Panel] Snapshot alignment: ';
/** Wall time of each idle CPU sample. */
const IDLE_CPU_SAMPLE_MS = 20000;

/**
 * Scrolls the conversation (the tallest scrollable box) to `fraction` of its
 * range and returns its position; without a fraction it only reads it.
 */
function scrollPanel(page, providerId, fraction = null) {
  return findProviderFrame(page, providerId).evaluate((value) => {
    const scroller = Array.from(document.querySelectorAll('*'))
      .filter((element) => /(auto|scroll)/.test(getComputedStyle(element).overflowY)
        && element.scrollHeight > element.clientHeight + 200)
      .sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (!scroller) return null;
    if (value !== null) {
      scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * value);
    }
    return { scrollTop: scroller.scrollTop, maxScrollTop: scroller.scrollHeight - scroller.clientHeight };
  }, fraction);
}

/**
 * Moves the real pointer over `locator`, so a stream that drew the cursor
 * would show it. macOS only; Playwright's mouse never moves the real one.
 */
async function movePointerOver(page, locator) {
  const box = await locator.boundingBox();
  const origin = await page.evaluate(() => ({
    x: window.screenX + (window.outerWidth - window.innerWidth) / 2,
    y: window.screenY + window.outerHeight - window.innerHeight,
  }));
  const x = Math.round(origin.x + box.x + box.width / 2);
  const y = Math.round(origin.y + box.y + box.height / 2);
  const { execFileSync } = await import('node:child_process');
  execFileSync('swift', ['-e', `import CoreGraphics; CGWarpMouseCursorPosition(CGPoint(x: ${x}, y: ${y}))`]);
  return { x, y };
}

/** CPU seconds of a process and all its descendants. */
async function readProcessTreeCpuSeconds(rootPid) {
  const { execFileSync } = await import('node:child_process');
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' })
    .trim().split('\n').map((line) => line.trim().split(/\s+/));
  const children = new Map();
  const cpu = new Map();
  for (const [pid, ppid, time] of rows) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    const parts = time.replace('-', ':').split(':').map(Number);
    cpu.set(pid, parts.reduce((total, part) => total * 60 + part, 0));
  }
  let total = 0;
  const pending = [String(rootPid)];
  while (pending.length) {
    const pid = pending.pop();
    total += cpu.get(pid) || 0;
    pending.push(...(children.get(pid) || []));
  }
  return total;
}

/** Average CPU use of the browser, in percent of one core, while nothing happens. */
async function sampleIdleCpu(page, rootPid) {
  const start = await readProcessTreeCpuSeconds(rootPid);
  const started = Date.now();
  await page.waitForTimeout(IDLE_CPU_SAMPLE_MS);
  const used = await readProcessTreeCpuSeconds(rootPid) - start;
  return Math.round(used / ((Date.now() - started) / 1000) * 1000) / 10;
}

/** The live browser's main process: the one without a --type switch. */
async function findBrowserPid() {
  const { execFileSync } = await import('node:child_process');
  const browser = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' })
    .trim().split('\n').map((row) => row.trim())
    .find((row) => row.includes(`--user-data-dir=${LIVE_USER_DATA_DIR}`) && !row.includes('--type='));
  return browser ? Number(browser.split(/\s+/)[0]) : null;
}

/**
 * v3 on the logged-in live profile with ChatGPT, Gemini, Grok and DeepSeek:
 * Grok scrolled to the bottom and ChatGPT to the middle, so every Full answers
 * capture must start at the latest turn. Layout A goes through Chrome's tab
 * sharing (pointer over a panel), and the second Share must reuse it; layout B
 * goes through the toolbar icon. Records where each panel started, and the
 * browser's idle CPU with the shared tab kept and after Stop.
 * Needs PANELIZE_LIVE_SEND=1; PANELIZE_LIVE_MOVE_POINTER=1 moves the real pointer.
 */
test('Share snapshot v3: latest turn, one tab-sharing grant and clean answers on a live 2x2', async () => {
  test.skip(!LIVE_SEND_ENABLED, 'Set PANELIZE_LIVE_SEND=1: the snapshot needs real answers.');
  test.setTimeout(1200000);
  await mkdir(V3_EVIDENCE_DIR, { recursive: true });

  const extensionPath = await prepareLiveExtension();
  const extension = await launchExtension({
    extensionPath,
    userDataDir: LIVE_USER_DATA_DIR,
    headless: LIVE_HEADLESS,
    ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
    viewport: null,
    args: [
      '--window-size=1440,1000',
      '--disable-blink-features=AutomationControlled',
      '--auto-accept-this-tab-capture',
      '--enable-unsafe-extension-debugging',
    ],
  });
  const consoleMessages = [];
  const alignments = [];
  const summary = { providers: V3_PROVIDERS, prompt: V3_PROMPT, steps: {} };
  const layout = V3_PROVIDERS.length === 4 ? '2x2' : `1x${V3_PROVIDERS.length}`;
  let page = null;
  let originalTheme = null;
  const takeAlignment = () => alignments.splice(0).at(-1) ?? null;
  try {
    originalTheme = await extension.serviceWorker.evaluate(async () => (
      (await chrome.storage.sync.get({ theme: 'auto' })).theme
    ));
    await configureLiveProviders(extension.serviceWorker, V3_PROVIDERS, { layout });
    page = await extension.context.newPage();
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith(ALIGNMENT_LOG_PREFIX)) {
        alignments.push(JSON.parse(text.slice(ALIGNMENT_LOG_PREFIX.length)));
      } else if (text.includes('Window changed size during the snapshot')) {
        // The window was re-tiled or resized under a capture, which started over.
        summary.layoutRestarts = (summary.layoutRestarts ?? 0) + 1;
      } else if (message.type() === 'error') {
        consoleMessages.push({ type: 'error', text, url: message.location().url });
      }
    });
    page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));
    await page.addInitScript(() => {
      if (location.protocol !== 'chrome-extension:') return;
      const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
      window.__displayMediaCalls = 0;
      window.__displayMediaConstraints = [];
      navigator.mediaDevices.getDisplayMedia = (constraints) => {
        window.__displayMediaCalls += 1;
        window.__displayMediaConstraints.push(constraints);
        return original(constraints);
      };
    });

    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    await expect(page.locator('#panel-grid iframe')).toHaveCount(V3_PROVIDERS.length);
    for (const frame of await page.locator('#panel-grid iframe').elementHandles()) {
      await (await frame.contentFrame()).waitForLoadState('load', { timeout: 45000 });
    }
    await setTheme(page, 'light');
    // Starts in Full answers, as a new install would.
    await page.evaluate(() => chrome.storage.local.remove('shareSnapshotMode'));

    const temporaryChat = page.locator('#temporary-chat-btn');
    await temporaryChat.click();
    await expect(temporaryChat).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 });
    await page.waitForTimeout(15000);

    // Where each panel is and whether its composer is there, for a panel Send All misses.
    summary.beforeSend = {};
    for (const id of V3_PROVIDERS) {
      const frame = findProviderFrame(page, id);
      summary.beforeSend[id] = frame
        ? { url: frame.url(), editors: await frame.locator(EDITOR_SELECTORS[id]).count() }
        : null;
    }

    await page.locator('#unified-input').fill(V3_PROMPT);
    await page.locator('#send-all-btn').click();
    await expect(page.locator('#send-status')).toHaveText(/Sent to/, { timeout: 60000 });
    summary.window = await page.evaluate(() => ({ innerWidth, innerHeight, devicePixelRatio }));
    summary.sendStatus = await page.locator('#send-status').textContent();
    summary.notReachedBySendAll = await waitForPromptDelivery(page, V3_PROMPT, 30000, V3_PROVIDERS);
    for (const id of summary.notReachedBySendAll) {
      await sendDirectly(page, id, V3_PROMPT);
    }
    summary.notReachedAfterRetry = summary.notReachedBySendAll.length
      ? await waitForPromptDelivery(page, V3_PROMPT, 30000, V3_PROVIDERS)
      : [];
    summary.answers = await waitForAnswersToSettle(page, V3_PROVIDERS);

    // Where Denji had them: Grok at the bottom, ChatGPT in the middle.
    summary.positions = {
      grok: V3_PROVIDERS.includes('grok') ? await scrollPanel(page, 'grok', 1) : null,
      chatgpt: V3_PROVIDERS.includes('chatgpt') ? await scrollPanel(page, 'chatgpt', 0.5) : null,
    };
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(V3_EVIDENCE_DIR, 'comparison.png') });
    const positionsBefore = await Promise.all(V3_PROVIDERS.map((id) => scrollPanel(page, id).catch(() => null)));

    // Layout A: the Share button, through tab sharing, pointer over a panel.
    const modal = page.locator('#share-modal');
    if (process.env.PANELIZE_LIVE_MOVE_POINTER === '1') {
      summary.pointer = await movePointerOver(page, page.locator('#panel-grid iframe').first());
    }
    await page.locator('#share-snapshot-btn').click();
    await expect(modal).toBeVisible({ timeout: 300000 });
    await waitForCaptureToFinish(page, 'full');
    summary.steps.aFull = {
      ...(await readModalState(page)),
      ...(await savePreview(page, 'A-full.png', V3_EVIDENCE_DIR)),
      alignment: takeAlignment(),
      constraints: await page.evaluate(() => window.__displayMediaConstraints),
      streamStatus: await page.locator('#share-stream-status').isVisible()
        ? (await page.locator('#share-stream-status').innerText()).replace(/\s+/g, ' ').trim()
        : '',
    };
    await page.screenshot({ path: path.join(V3_EVIDENCE_DIR, 'modal-desktop-A-full.png') });
    await page.locator('.share-mode-btn[data-mode="current"]').click();
    await waitForCaptureToFinish(page, 'current');
    summary.steps.aCurrent = {
      ...(await readModalState(page)),
      ...(await savePreview(page, 'A-current.png', V3_EVIDENCE_DIR)),
      alignment: takeAlignment(),
    };
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    summary.restored = {
      before: positionsBefore,
      after: await Promise.all(V3_PROVIDERS.map((id) => scrollPanel(page, id).catch(() => null))),
    };

    // The shared tab is kept: idle CPU with it, then a second Share.
    const browserPid = await findBrowserPid();
    summary.idleCpu = { browserPid, sampleMs: IDLE_CPU_SAMPLE_MS };
    if (browserPid) summary.idleCpu.kept = await sampleIdleCpu(page, browserPid);
    await page.locator('#share-snapshot-btn').click();
    await expect(modal).toBeVisible({ timeout: 300000 });
    await waitForCaptureToFinish(page, 'current');
    summary.steps.secondShare = { ...(await readModalState(page)), alignment: takeAlignment() };
    await page.locator('#share-stream-stop').click();
    await expect(page.locator('#share-stream-status')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();
    if (browserPid) summary.idleCpu.stopped = await sampleIdleCpu(page, browserPid);

    // Layout B: dark theme, the toolbar icon, opening in the mode used last.
    summary.theme = await setTheme(page, 'dark');
    await clickToolbarIcon(extension, page);
    await expect(modal).toBeVisible({ timeout: 300000 });
    await waitForCaptureToFinish(page, 'current');
    summary.steps.bCurrent = {
      ...(await readModalState(page)),
      ...(await savePreview(page, 'B-current.png', V3_EVIDENCE_DIR)),
      alignment: takeAlignment(),
    };
    summary.steps.bFull = { progress: await captureFull(page) };
    Object.assign(summary.steps.bFull, await readModalState(page),
      await savePreview(page, 'B-full.png', V3_EVIDENCE_DIR), { alignment: takeAlignment() });
    await page.screenshot({ path: path.join(V3_EVIDENCE_DIR, 'modal-desktop-B-full.png') });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(V3_EVIDENCE_DIR, 'modal-390-B-full.png') });
    summary.mobileLayout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      modal: document.querySelector('.share-modal-content').getBoundingClientRect().toJSON(),
      footer: document.querySelector('#share-modal .modal-footer').getBoundingClientRect().toJSON(),
    }));
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    summary.extensionErrors = consoleMessages.filter((message) => (
      message.type === 'pageerror' || (message.url || '').startsWith('chrome-extension://')
    ));
    expect(summary.steps.aFull.constraints).toEqual([expect.objectContaining({
      video: expect.objectContaining({ cursor: 'never' }),
    })]);
    expect(summary.steps.aFull.streamStatus).toContain('Sharing this tab for snapshots');
    // Two Shares, one prompt from Chrome.
    expect(summary.steps.secondShare.displayMediaCalls).toBe(1);
    expect(summary.steps.aFull.alignment?.map((entry) => entry.name)).toHaveLength(V3_PROVIDERS.length);
    // Every panel was stitched, none left as on screen.
    expect(summary.steps.aFull.alignment.filter((entry) => !entry.alignedBy)).toEqual([]);
    expect(summary.steps.bFull.alignment?.filter((entry) => !entry.alignedBy)).toEqual([]);
    expect(summary.extensionErrors).toEqual([]);
  } finally {
    await writeFile(path.join(V3_EVIDENCE_DIR, 'summary.json'), `${JSON.stringify({ ...summary, consoleMessages }, null, 2)}\n`);
    if (page && originalTheme) {
      await setTheme(page, originalTheme).catch(() => {});
    }
    await extension.close();
  }
});
