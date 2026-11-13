import { test, expect } from '@playwright/test';
import {
  createPatchedExtensionCopy,
  launchExtension,
  startFixtureServer,
} from './extension-harness.js';
import { CONVERSATION_COLORS, renderConversationFixture } from './fixtures/conversation-fixture.js';
import { SNAPSHOT_FRAME_STYLES, getSnapshotFrameLayout } from '../../modules/share-snapshot.js';

const UNSAFE_EXTENSION_DEBUGGING = '--enable-unsafe-extension-debugging';
const PROMPT = 'DeepSeek 和 ChatGPT，选哪个好';
const FIXTURE_COLUMN_X = 30;
const BLOCK_COLORS = [
  [255, 200, 0],
  [0, 200, 200],
  [200, 0, 200],
  [120, 60, 0],
  [0, 120, 0],
];

const CONVERSATION_PALETTE = {
  page: CONVERSATION_COLORS.page,
  header: CONVERSATION_COLORS.header,
  composer: CONVERSATION_COLORS.composer,
  earlier: CONVERSATION_COLORS.earlier,
  user: CONVERSATION_COLORS.user,
  floating: CONVERSATION_COLORS.floating,
  notice: CONVERSATION_COLORS.notice,
  heading: CONVERSATION_COLORS.heading,
  tableHeader: CONVERSATION_COLORS.tableHeader,
  tableRow: CONVERSATION_COLORS.tableRow,
  fade: CONVERSATION_COLORS.fade,
  ...Object.fromEntries(BLOCK_COLORS.map((color, index) => [`block${index}`, color])),
};

function renderPerplexityLongThreadFixture({ prompt, blocks }) {
  const rgb = (color) => `rgb(${color.join(', ')})`;
  const escape = (text) => text.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const table = `<div class="table-wrap"><table>
      <thead><tr>${'<th>Field</th>'.repeat(8)}</tr></thead>
      <tbody>${`<tr>${'<td>Value</td>'.repeat(8)}</tr>`.repeat(CONVERSATION_COLORS.tableRows)}</tbody>
    </table></div>`;
  const answer = blocks
    .map((color, index) =>
      [
        `<div class="block" data-block="${index}" style="background: ${rgb(color)}"></div>`,
        index === 0 ? '<h2 class="sticky-heading">按用途怎么选</h2>' : '',
        index === 1 ? table : '',
      ].join('')
    )
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Perplexity Thread Fixture</title>
<style>
  html, body {
    margin: 0;
    height: 100%;
    overflow: hidden;
    background: ${rgb(CONVERSATION_COLORS.page)};
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  header {
    flex: 0 0 ${CONVERSATION_COLORS.headerHeight}px;
    height: ${CONVERSATION_COLORS.headerHeight}px;
    background: ${rgb(CONVERSATION_COLORS.header)};
  }
  #thread {
    flex: 1 1 0%;
    min-height: 0;
    overflow-y: auto;
    position: relative;
  }
  .earlier {
    height: 600px;
    margin: 0 24px;
    background: ${rgb(CONVERSATION_COLORS.earlier)};
  }
  .user {
    margin: 40px 24px 24px;
    padding: 12px;
    background: ${rgb(CONVERSATION_COLORS.user)};
    font: 16px/24px sans-serif;
    color: rgb(250, 230, 150);
  }
  .block {
    height: ${CONVERSATION_COLORS.blockHeight}px;
    margin: 0 24px;
  }
  .spacer {
    height: 48px;
  }
  .sticky-heading {
    position: sticky;
    top: 0;
    z-index: 1;
    height: ${CONVERSATION_COLORS.headingHeight}px;
    margin: 0 24px;
    background: ${rgb(CONVERSATION_COLORS.heading)};
    box-shadow: 0 8px 12px rgba(0, 0, 0, 0.5);
    font: 16px/${CONVERSATION_COLORS.headingHeight}px sans-serif;
    color: transparent;
  }
  .table-wrap {
    margin: 0 24px;
    overflow-x: auto;
  }
  table {
    width: 1600px;
    border-collapse: collapse;
    font: 14px sans-serif;
    color: transparent;
  }
  th {
    position: sticky;
    top: 0;
    height: ${CONVERSATION_COLORS.tableHeaderHeight}px;
    padding: 0;
    background: ${rgb(CONVERSATION_COLORS.tableHeader)};
  }
  td {
    height: ${CONVERSATION_COLORS.tableRowHeight}px;
    padding: 0;
    background: ${rgb(CONVERSATION_COLORS.tableRow)};
  }
  .contents {
    display: contents;
  }
  #composer-dock {
    position: sticky;
    bottom: 0;
    z-index: 2;
  }
  #scroll-end-holder {
    height: 0;
    pointer-events: none;
  }
  #scroll-end-shift {
    transform: translateY(-100%);
    padding-bottom: 12px;
  }
  #scroll-down {
    margin-left: 16px;
    width: ${CONVERSATION_COLORS.floatingSize}px;
    height: ${CONVERSATION_COLORS.floatingSize}px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    pointer-events: auto;
    background: ${rgb(CONVERSATION_COLORS.floating)};
  }
  .incognito-bar {
    height: ${CONVERSATION_COLORS.noticeHeight}px;
    background: ${rgb(CONVERSATION_COLORS.notice)};
    font: 14px/${CONVERSATION_COLORS.noticeHeight}px sans-serif;
    color: white;
    padding-left: 120px;
  }
  #composer-halo {
    position: static;
    height: ${CONVERSATION_COLORS.composerHeight}px;
    background: ${rgb(CONVERSATION_COLORS.composer)};
    box-shadow: 0 -48px 0 48px ${rgb(CONVERSATION_COLORS.fade)};
  }
  #ask-input {
    height: 40px;
    margin: 0 16px;
    background: white;
  }
</style>
</head>
<body>
  <div class="shell">
    <header></header>
    <div id="thread" class="@container/thread">
      <div class="earlier"></div>
      <div class="group/user-bubble user">${escape(prompt)}</div>
      <div class="answer">${answer}</div>
      <div class="spacer"></div>
      <div class="contents">
        <div id="composer-dock">
          <div id="scroll-end-holder">
            <div id="scroll-end-shift">
              <button id="scroll-down" type="button" aria-label="Scroll to end"></button>
            </div>
          </div>
          <div class="incognito-bar">You're incognito · Exit Incognito</div>
          <div id="composer-halo">
            <div id="ask-input" contenteditable="true" role="textbox" aria-label="Ask a follow-up"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <script>
    const thread = document.getElementById('thread');
    thread.scrollTop = thread.scrollHeight;
  </script>
</body>
</html>`;
}

async function waitForServiceWorkerReady(extension) {
  await expect
    .poll(
      async () => {
        extension.serviceWorker =
          extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
        return extension.serviceWorker
          .evaluate(() =>
            Boolean(
              chrome.storage?.local &&
                chrome.storage?.sync &&
                chrome.declarativeNetRequest?.getDynamicRules &&
                chrome.scripting?.getRegisteredContentScripts
            )
          )
          .catch(() => false);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

async function clickToolbarIcon(extension, page) {
  const session = await extension.context.browser().newBrowserCDPSession();
  try {
    const url = page.url();
    const { targetInfos } = await session.send('Target.getTargets', {
      filter: [{ type: 'tab' }],
    });
    const tab = targetInfos.find((info) => info.url === url);
    expect(tab, `tab target for ${url}`).toBeTruthy();
    await session.send('Extensions.triggerAction', {
      id: extension.extensionId,
      targetId: tab.targetId,
    });
  } finally {
    await session.detach();
  }
}

function inspectPreview(page) {
  return page.evaluate(async () => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const grid = document.getElementById('panel-grid').getBoundingClientRect();
    const frames = Array.from(document.querySelectorAll('#panel-grid iframe'), (frame) => {
      const rect = frame.getBoundingClientRect();
      return {
        left: rect.left - grid.left,
        top: rect.top - grid.top,
        width: rect.width,
        height: rect.height,
      };
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

function getPreviewScale(preview, theme = 'light') {
  const padding = SNAPSHOT_FRAME_STYLES[theme].paddingX;
  return preview.width / (preview.grid.width + padding * 2);
}

function readPreviewColumn(page, x) {
  return page.evaluate(async (colX) => {
    const image = document.getElementById('share-preview');
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(Math.round(colX), 0, 1, image.naturalHeight).data;
    const column = [];
    for (let i = 0; i < data.length; i += 4) {
      column.push([data[i], data[i + 1], data[i + 2]]);
    }
    return column;
  }, x);
}

const isNear = (actual, expected, tolerance) =>
  actual.every((ch, idx) => Math.abs(ch - expected[idx]) <= tolerance);

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

async function readConversationRuns(page, preview, index, frame = {}) {
  const scale = getPreviewScale(preview);
  const empty = getSnapshotFrameLayout({
    contentWidth: preview.width - Math.round(SNAPSHOT_FRAME_STYLES.light.paddingX * scale) * 2,
    contentHeight: 0,
    scale,
    titleLineCount: 1,
    hasSubline: true,
    ...frame,
  });
  const top = empty.content.y;
  const bottom = preview.height - (empty.height - empty.content.y);
  const x = empty.content.x + (preview.frames[index].left + FIXTURE_COLUMN_X) * scale;
  const column = (await readPreviewColumn(page, x)).slice(top, bottom);
  return getColorRuns(column, CONVERSATION_PALETTE).filter((run) => run.length > 3 * scale);
}

test.describe('Custom Web UI Share Snapshot full-answer stitching', () => {
  test.setTimeout(120_000);

  test('stitches full multi-screen answers on a Perplexity-like Custom Web UI panel alongside ChatGPT and restores scroll & DOM styles afterwards', async ({}, testInfo) => {
    const fixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.end(renderPerplexityLongThreadFixture({ prompt: PROMPT, blocks: BLOCK_COLORS }));
    });

    const fixtureOrigin = `http://127.0.0.1:${fixture.port}`;
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${fixtureOrigin}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
        args: [UNSAFE_EXTENSION_DEBUGGING],
      });
      await waitForServiceWorkerReady(extension);

      await extension.context.route('https://chatgpt.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: renderConversationFixture({
            prompt: PROMPT,
            blocks: BLOCK_COLORS,
            stickyHeading: true,
            wideTable: true,
            fade: true,
            notice: true,
          }),
        })
      );

      // Register Perplexity as a Custom Web UI provider via Options
      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await optionsPage.locator('#custom-provider-name').fill('Perplexity');
      await optionsPage.locator('#custom-provider-url').fill(`${fixtureOrigin}/`);
      await optionsPage.locator('#custom-provider-add-btn').click();

      const customRow = optionsPage.locator(
        '#provider-list .provider-item[data-custom-provider="true"]'
      );
      await expect(customRow).toHaveCount(1);
      const customId = await customRow.getAttribute('data-provider-id');
      await optionsPage.close();

      await extension.serviceWorker.evaluate(async (id) => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt', id],
          providerOrder: ['chatgpt', id],
          multiPanelProviders: ['chatgpt', id],
          multiPanelLayout: '1x2',
        });
      }, customId);

      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      await expect(mpPage.locator('#panel-grid .panel-item')).toHaveCount(2);
      await expect(mpPage.frameLocator('#panel-grid iframe').nth(0).locator('.user')).toBeVisible();
      await expect(mpPage.frameLocator('#panel-grid iframe').nth(1).locator('.user')).toBeVisible();

      const readPanelScrollStates = () =>
        Promise.all(
          mpPage
            .frames()
            .filter((f) => f.url().startsWith('https://chatgpt.com') || f.url().startsWith(fixtureOrigin))
            .map((f) =>
              f.evaluate(() => {
                const thread = document.getElementById('thread');
                return thread
                  ? {
                      url: location.origin,
                      top: Math.round(thread.scrollTop),
                      max: Math.round(thread.scrollHeight - thread.clientHeight),
                    }
                  : null;
              })
            )
        );

      // Ensure both panels start scrolled to the bottom, as in real chat threads
      await expect
        .poll(async () => {
          for (const f of mpPage.frames()) {
            if (f.url().startsWith('https://chatgpt.com') || f.url().startsWith(fixtureOrigin)) {
              await f.evaluate(() => {
                const thread = document.getElementById('thread');
                if (thread) thread.scrollTop = thread.scrollHeight;
              });
            }
          }
          const states = await readPanelScrollStates();
          return (
            states.length === 2 &&
            states.every((s) => s && s.max > 800 && Math.abs(s.top - s.max) <= 2)
          );
        })
        .toBe(true);

      await mpPage.locator('#unified-input').fill(PROMPT);
      await mpPage.bringToFront();

      // Trigger Share Snapshot (`Full answers` default)
      await clickToolbarIcon(extension, mpPage);
      await expect(mpPage.locator('#share-modal')).toBeVisible();
      await expect(mpPage.locator('#snapshot-progress')).toBeHidden({ timeout: 60_000 });
      await expect(mpPage.locator('.share-mode-btn[data-mode="full"]')).toHaveAttribute(
        'aria-checked',
        'true'
      );
      // Neither ChatGPT nor Perplexity fell back to `Current view only`!
      await expect(mpPage.locator('#share-capture-notes')).toBeHidden();

      const preview = await inspectPreview(mpPage);
      await mpPage
        .locator('#share-preview')
        .screenshot({ path: testInfo.outputPath('custom-web-perplexity-stitched.png') });

      const scale = getPreviewScale(preview);
      for (const panelIndex of [0, 1]) {
        const runs = await readConversationRuns(mpPage, preview, panelIndex, { hasNote: false });
        const names = runs.map((r) => r.name);

        // Header once, prompt-aligned user bubble, all 5 blocks + unstuck heading & table in exact order!
        expect(
          names.filter((n) => n !== 'page' && n !== 'other'),
          `panel ${panelIndex} sequence`
        ).toEqual([
          'header',
          'user',
          'block0',
          'heading',
          'block1',
          'tableHeader',
          'tableRow',
          'block2',
          'block3',
          'block4',
        ]);

        // Zero composer dock, zero incognito notice, zero scroll-to-end button, zero box-shadow halo, zero earlier turn!
        expect(names, `panel ${panelIndex}`).not.toContain('earlier');
        expect(names, `panel ${panelIndex}`).not.toContain('composer');
        expect(names, `panel ${panelIndex}`).not.toContain('notice');
        expect(names, `panel ${panelIndex}`).not.toContain('floating');
        expect(names, `panel ${panelIndex}`).not.toContain('fade');

        for (const run of runs.filter((r) => r.name.startsWith('block'))) {
          expect(
            Math.abs(run.length - CONVERSATION_COLORS.blockHeight * scale),
            `panel ${panelIndex} ${run.name} height`
          ).toBeLessThanOrEqual(4 * scale);
        }
      }

      // Close modal and verify Perplexity scroll position, Scroll-to-end button, and box-shadow are restored
      await mpPage.keyboard.press('Escape');
      await expect(mpPage.locator('#share-modal')).toBeHidden();

      const afterStates = await readPanelScrollStates();
      for (const state of afterStates) {
        expect(Math.abs(state.top - state.max)).toBeLessThanOrEqual(2);
      }

      const pplxFrame = mpPage.frames().find((f) => f.url().startsWith(fixtureOrigin));
      expect(pplxFrame).toBeTruthy();
      const restoredDom = await pplxFrame.evaluate(() => {
        const scrollDown = document.getElementById('scroll-down');
        const halo = document.getElementById('composer-halo');
        return {
          scrollDownVisible: getComputedStyle(scrollDown).visibility === 'visible',
          haloBoxShadowRestored: getComputedStyle(halo).boxShadow !== 'none',
        };
      });
      expect(restoredDom).toEqual({
        scrollDownVisible: true,
        haloBoxShadowRestored: true,
      });
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await fixture.close();
    }
  });
});
