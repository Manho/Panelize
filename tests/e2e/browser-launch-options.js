import { chromium } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Relative paths from a `chromium-<revision>` cache directory to the
 * Chrome for Testing executable, per platform layout.
 */
const CHROMIUM_EXECUTABLE_RELATIVE_PATHS = [
  ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-linux64', 'chrome'],
  ['chrome-linux', 'chrome'],
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
].map((segments) => path.join(...segments));

/**
 * E2E browsers run headless by default so test runs never open windows or
 * steal focus. Set PANELIZE_E2E_HEADED=1 to watch a run while debugging.
 * @returns {boolean}
 */
export function isHeadedRun() {
  return process.env.PANELIZE_E2E_HEADED === '1';
}

function findRevisionDirectory(executablePath) {
  let current = path.dirname(executablePath);
  while (current !== path.dirname(current)) {
    if (/^chromium-\d+$/.test(path.basename(current))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function isCompleteInstall(revisionDirectory) {
  return existsSync(path.join(revisionDirectory, 'INSTALLATION_COMPLETE'));
}

function findNewestCachedChromium(cacheDirectory) {
  if (!existsSync(cacheDirectory)) {
    return null;
  }

  const revisions = readdirSync(cacheDirectory)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((left, right) => Number(right.split('-')[1]) - Number(left.split('-')[1]));

  for (const revision of revisions) {
    const revisionDirectory = path.join(cacheDirectory, revision);
    if (!isCompleteInstall(revisionDirectory)) {
      continue;
    }
    const executablePath = CHROMIUM_EXECUTABLE_RELATIVE_PATHS
      .map((relativePath) => path.join(revisionDirectory, relativePath))
      .find((candidate) => existsSync(candidate));
    if (executablePath) {
      return executablePath;
    }
  }

  return null;
}

/**
 * Picks the full Chromium build used by every E2E launch. Order:
 * PANELIZE_E2E_EXTENSION_BROWSER, the revision this Playwright version expects,
 * then the newest complete Chromium in the Playwright cache. The system Google
 * Chrome is never used, so tests cannot take over the user's browser.
 * @returns {{ executablePath?: string, channel?: string }}
 */
function resolveChromiumLaunch() {
  const override = process.env.PANELIZE_E2E_EXTENSION_BROWSER;
  if (override) {
    return { executablePath: override };
  }

  const bundledExecutable = chromium.executablePath();
  const bundledRevision = findRevisionDirectory(bundledExecutable);
  if (existsSync(bundledExecutable) && (!bundledRevision || isCompleteInstall(bundledRevision))) {
    // The `chromium` channel runs the full browser in new headless mode,
    // which supports extensions (https://playwright.dev/docs/chrome-extensions).
    return { channel: 'chromium' };
  }

  const cacheDirectory = bundledRevision
    ? path.dirname(bundledRevision)
    : path.dirname(path.dirname(bundledExecutable));
  const fallback = findNewestCachedChromium(cacheDirectory);
  if (fallback) {
    return { executablePath: fallback };
  }

  throw new Error(
    'No complete Playwright Chromium install was found. ' +
    'Run "npx playwright install chromium" or set PANELIZE_E2E_EXTENSION_BROWSER.'
  );
}

/**
 * Returns the Chromium executable every E2E and live launch uses.
 * @returns {string}
 */
export function getChromiumExecutablePath() {
  const { executablePath } = resolveChromiumLaunch();
  return executablePath || chromium.executablePath();
}

/**
 * Builds launch options for `chromium.launch` or `launchPersistentContext`.
 * E2E callers leave `headless` unset so isHeadedRun() decides; only the live
 * smoke suite, which targets real sites, passes an explicit value.
 * @param {object} [options] - Extra Playwright launch options such as `args`.
 * @returns {object}
 */
export function getBrowserLaunchOptions({ headless, ...options } = {}) {
  return {
    ...options,
    ...resolveChromiumLaunch(),
    headless: headless ?? !isHeadedRun(),
  };
}
