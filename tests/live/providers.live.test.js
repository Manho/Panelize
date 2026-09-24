import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { launchExtension } from '../e2e/extension-harness.js';
import {
  LIVE_HEADLESS,
  LIVE_IGNORED_DEFAULT_ARGS,
  LIVE_SEND_ENABLED,
  LIVE_USER_DATA_DIR,
  configureLiveProviders,
  getSelectedProviders,
  prepareLiveExtension,
  readContentScriptSelectorTable,
} from './live-harness.js';

const SEND_BUTTON_SELECTORS = readContentScriptSelectorTable('SEND_BUTTON_SELECTORS');
const NEW_CHAT_BUTTON_SELECTORS = readContentScriptSelectorTable('NEW_CHAT_BUTTON_SELECTORS');
const NEW_CHAT_URLS = readContentScriptSelectorTable('NEW_CHAT_URLS');
const PROVIDER_SELECTORS = readContentScriptSelectorTable('PROVIDER_SELECTORS');

/**
 * Providers whose page renders no new chat control inside the panel iframe, so
 * NEW_CHAT always uses the NEW_CHAT_URLS fallback there. Checked live on
 * 2026-09-24: claude.ai shows its sidebar (with `a[href="/new"]`) as a top-level
 * page but not in an iframe of the same width.
 */
const NEW_CHAT_VIA_URL_IN_PANEL = {
  claude: 'claude.ai hides its sidebar when embedded in an iframe',
};

const LIVE_TOKEN_PREFIX = 'panelize-live-';

const LIVE_TOKEN_PATTERN = /panelize-live-[a-z-]+-\d+/g;

/** Time for a site to save or restore a composer draft (Claude needs over 2s). */
const DRAFT_SAVE_DELAY_MS = 4000;

/** How long a reloaded panel is watched for a restored draft. */
const DRAFT_RESTORE_WATCH_MS = 10000;

/**
 * Composer text with every live test token removed, i.e. what the user wrote.
 * @param {string} text
 */
function withoutLiveTokens(text) {
  return text.replace(LIVE_TOKEN_PATTERN, '').trim();
}

const providers = getSelectedProviders();
const providerIds = providers.map((provider) => provider.id);

/**
 * Smoke checks against the real provider sites, using the real extension and
 * the same flow a user follows: type into the unified input, press Fill, and
 * look at what landed in the provider panel. Run `npm run test:live:login`
 * first. Not part of CI: results depend on logins and on the sites themselves.
 */
test.describe('Live provider smoke', () => {
  test.setTimeout(LIVE_SEND_ENABLED ? 150000 : 90000);

  let extension;
  let page;
  let panelFrame;
  let currentProviderId;
  let currentToken;

  test.beforeAll(async () => {
    const extensionPath = await prepareLiveExtension();
    extension = await launchExtension({
      extensionPath,
      userDataDir: LIVE_USER_DATA_DIR,
      headless: LIVE_HEADLESS,
      ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
      viewport: { width: 1400, height: 900 },
      // Some sites refuse to work when the automation infobar flag is set.
      args: ['--disable-blink-features=AutomationControlled'],
    });
  });

  test.afterEach(async ({}, testInfo) => {
    if (page && testInfo.status !== testInfo.expectedStatus) {
      // Keep what is needed to update selectors or fixtures after a site change.
      await page.screenshot({ path: testInfo.outputPath(`${currentProviderId}-multi-panel.png`) }).catch(() => {});
      const html = await panelFrame?.content().catch((error) => `<!-- ${error.message} -->`);
      if (html) {
        const htmlPath = testInfo.outputPath(`${currentProviderId}-frame.html`);
        await writeFile(htmlPath, `<!-- ${panelFrame.url()} -->\n${html}`);
        await testInfo.attach(`${currentProviderId}-frame.html`, { path: htmlPath, contentType: 'text/html' });
      }
    }
    // Also after failures: a filled token left in a draft-saving composer
    // would show up in the user's account.
    if (page && currentToken && !LIVE_SEND_ENABLED && await composerContains(currentToken)) {
      await clearComposer(currentToken).catch(() => {});
      await page.waitForTimeout(DRAFT_SAVE_DELAY_MS);
    }
    currentToken = null;
    await page?.close();
    page = null;
    panelFrame = null;
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  async function openProviderPanel(providerId) {
    currentProviderId = providerId;
    // Bounded so a service worker that stops answering fails fast and says so
    // (seen once in about ten runs, not reproduced in isolation).
    let timer;
    await Promise.race([
      configureLiveProviders(extension.serviceWorker, providerIds, {
        panelOrder: [providerId, ...providerIds.filter((id) => id !== providerId)],
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Extension service worker did not answer within 15s')), 15000);
      }),
    ]).finally(() => clearTimeout(timer));
    page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
    const iframe = page.locator('#panel-grid iframe');
    await expect(iframe).toHaveCount(1);
    panelFrame = await (await iframe.elementHandle()).contentFrame();
    await panelFrame.waitForLoadState('load', { timeout: 45000 });
  }

  function composerContains(token) {
    return panelFrame.evaluate((text) => (
      [...document.querySelectorAll('textarea, input, [contenteditable]:not([contenteditable="false"])')]
        .some((element) => (element.value ?? element.textContent ?? '').includes(text))
    ), token).catch(() => false);
  }

  /**
   * Text of the provider's composer, found with the production
   * PROVIDER_SELECTORS. Unlike composerContains it throws when the composer is
   * missing or the frame cannot be read, so a check cannot pass by accident.
   * @param {string} providerId
   * @returns {Promise<string>}
   */
  async function readComposerText(providerId) {
    const text = await panelFrame.evaluate((selectors) => {
      for (const selector of selectors) {
        const elements = [...document.querySelectorAll(selector)];
        if (elements.length > 0) {
          return elements.map((element) => {
            if (element.value !== undefined) {
              return element.value;
            }
            // Slate (qwen-cn) renders its placeholder as a non-editable node
            // plus a zero-width character; neither is text the user typed.
            const copy = element.cloneNode(true);
            copy.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
            return copy.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '');
          }).join('\n');
        }
      }
      return null;
    }, PROVIDER_SELECTORS[providerId]);
    if (text === null) {
      throw new Error(`${providerId}: no PROVIDER_SELECTORS composer on the page`);
    }
    return text;
  }

  /**
   * Empties the composer that holds `token`. Several sites (claude.ai among
   * them) save composer drafts, so a leftover token would reappear for the user.
   * Retries because a site can re-render the composer between steps.
   */
  async function clearComposer(token) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const found = await panelFrame.evaluate((text) => {
        const element = [...document.querySelectorAll('textarea, input, [contenteditable]:not([contenteditable="false"])')]
          .find((candidate) => (candidate.value ?? candidate.textContent ?? '').includes(text));
        if (!element) {
          return null;
        }
        element.setAttribute('data-panelize-live-clear', '');
        if (element.value !== undefined) {
          return element.value;
        }
        // Same placeholder handling as readComposerText.
        const copy = element.cloneNode(true);
        copy.querySelectorAll('[contenteditable="false"]').forEach((node) => node.remove());
        return copy.textContent.replace(/[\u200B-\u200D\uFEFF]/g, '');
      }, token).catch(() => null);
      if (found === null) {
        return;
      }
      // Select-all + delete must only ever remove test tokens.
      if (withoutLiveTokens(found)) {
        await panelFrame.evaluate(() => document.querySelector('[data-panelize-live-clear]')
          ?.removeAttribute('data-panelize-live-clear')).catch(() => {});
        throw new Error('The composer also holds user text; left it untouched');
      }
      // Key presses go through the element: page.keyboard can land in the
      // unified input when the multi-panel focus restore takes focus back, and
      // fill('') leaves ProseMirror composers (ChatGPT) unchanged.
      const composer = panelFrame.locator('[data-panelize-live-clear]');
      try {
        await composer.click({ timeout: 5000 });
        await composer.press('ControlOrMeta+A', { timeout: 5000 });
        await composer.press('Backspace', { timeout: 5000 });
        await composer.evaluate((element) => element.removeAttribute('data-panelize-live-clear'), null, { timeout: 5000 });
      } catch {
        // The composer was replaced; mark the current one on the next attempt.
      }
      if (!(await composerContains(token))) {
        return;
      }
    }
  }

  /**
   * Cloudflare's interstitial replaces the site until someone clicks it. Its
   * checkbox sits in a closed shadow root, so look at the page shell instead.
   */
  function hasCloudflareChallenge() {
    return panelFrame.evaluate(() => (
      '_cf_chl_opt' in window
      || /^Just a moment/.test(document.title)
      || Boolean(document.querySelector('script[src*="challenges.cloudflare.com"], #challenge-form'))
    )).catch(() => false);
  }

  function firstMatchingSelector(selectors = []) {
    return panelFrame.evaluate((candidates) => candidates.find((selector) => {
      try {
        return Boolean(document.querySelector(selector));
      } catch {
        return false;
      }
    }) ?? null, selectors).catch(() => null);
  }

  for (const provider of providers) {
    test(`${provider.id}: fill reaches the composer and controls are found`, async () => {
      await openProviderPanel(provider.id);
      const token = `${LIVE_TOKEN_PREFIX}${provider.id}-${Date.now()}`;
      currentToken = token;

      // A user presses Fill once the composer is on screen; the iframe load
      // event fires before single-page sites like Doubao render it.
      await expect.poll(async () => (
        await hasCloudflareChallenge() ? 'cloudflare' : await firstMatchingSelector(PROVIDER_SELECTORS[provider.id])
      ), {
        timeout: 30000,
        message: `${provider.id}: no PROVIDER_SELECTORS composer appeared (logged out or input selectors changed?)`,
      }).not.toBeNull();
      expect(
        await hasCloudflareChallenge(),
        `${provider.id}: Cloudflare challenge in the panel; click it in the window and rerun`
      ).toBe(false);

      // Fill adds to what is already in the composer, and the cleanup below
      // empties it, so never run on top of a draft the user wrote. Wait for a
      // saved draft to be restored first.
      await page.waitForTimeout(DRAFT_SAVE_DELAY_MS);
      const userDraft = withoutLiveTokens(await readComposerText(provider.id));
      test.skip(Boolean(userDraft), `${provider.id}: the composer holds a user draft; skipped so it is not touched`);

      await page.fill('#unified-input', token);
      await page.click('#fill-input-btn');

      await expect.poll(() => composerContains(token), {
        timeout: 30000,
        message: `${provider.id}: filled text never reached the composer`,
      }).toBe(true);

      expect.soft(
        await firstMatchingSelector(SEND_BUTTON_SELECTORS[provider.id]),
        `${provider.id}: no SEND_BUTTON_SELECTORS entry matches`
      ).not.toBeNull();
      if (NEW_CHAT_VIA_URL_IN_PANEL[provider.id]) {
        test.info().annotations.push({
          type: 'new-chat',
          description: `URL fallback: ${NEW_CHAT_VIA_URL_IN_PANEL[provider.id]}`,
        });
        expect.soft(NEW_CHAT_URLS[provider.id], `${provider.id}: NEW_CHAT_URLS entry missing`).toBeTruthy();
      } else {
        expect.soft(
          await firstMatchingSelector(NEW_CHAT_BUTTON_SELECTORS[provider.id]),
          `${provider.id}: no NEW_CHAT_BUTTON_SELECTORS entry matches (falls back to reloading the URL)`
        ).not.toBeNull();
      }

      if (!LIVE_SEND_ENABLED) {
        await clearComposer(token);
        await expect.poll(() => composerContains(token), {
          timeout: 5000,
          message: `${provider.id}: the filled text could not be cleared from the composer`,
        }).toBe(false);
        // Sites that save drafts (Claude, Kimi) debounce the save, so give the
        // empty state time to persist, then reload to prove nothing is left.
        await page.waitForTimeout(DRAFT_SAVE_DELAY_MS);
        // waitForLoadState alone resolves at once with the old document's
        // state, so tag the old document and wait until it is gone.
        await panelFrame.evaluate(() => {
          window.panelizeLiveBeforeReload = true;
          location.reload();
        }).catch(() => {});
        await expect.poll(() => panelFrame.evaluate(() => !window.panelizeLiveBeforeReload).catch(() => false), {
          timeout: 45000,
          message: `${provider.id}: the panel did not reload`,
        }).toBe(true);
        await panelFrame.waitForLoadState('load', { timeout: 45000 });
        await expect.poll(() => firstMatchingSelector(PROVIDER_SELECTORS[provider.id]), {
          timeout: 30000,
          message: `${provider.id}: the composer did not come back after reload`,
        }).not.toBeNull();
        // Drafts are restored some time after the composer renders, so watch
        // for a while. Any run's token counts, so drafts left by an earlier
        // interrupted run are reported (and removed) too.
        let restoredDraft = '';
        for (const deadline = Date.now() + DRAFT_RESTORE_WATCH_MS; Date.now() < deadline && !restoredDraft;) {
          const text = await readComposerText(provider.id);
          restoredDraft = text.match(LIVE_TOKEN_PATTERN) ? text : '';
          await page.waitForTimeout(500);
        }
        if (restoredDraft) {
          await clearComposer(LIVE_TOKEN_PREFIX);
          await page.waitForTimeout(DRAFT_SAVE_DELAY_MS);
        }
        expect(restoredDraft, `${provider.id}: filled text came back as a saved draft after reload`).toBe('');
        return;
      }

      await page.click('#send-all-btn');
      await expect.poll(async () => (
        !(await composerContains(token))
        && await panelFrame.evaluate((text) => document.body.innerText.includes(text), token).catch(() => false)
      ), {
        timeout: 60000,
        message: `${provider.id}: the prompt was not sent into the conversation`,
      }).toBe(true);
    });
  }
});
