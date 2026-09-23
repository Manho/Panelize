import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_FOR_TESTING_RELATIVE_PATHS = [
  process.arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64',
  'chrome-mac-arm64',
  'chrome-mac-x64',
  'chrome-mac',
].map((directory) => path.join(
  directory,
  'Google Chrome for Testing.app',
  'Contents',
  'MacOS',
  'Google Chrome for Testing'
));

function findChromeForTesting() {
  const override = process.env.PANELIZE_E2E_EXTENSION_BROWSER;
  if (override) {
    return override;
  }

  const cacheDirectory = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cacheDirectory)) {
    return null;
  }

  const revisions = readdirSync(cacheDirectory)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((left, right) => {
      const leftRevision = Number(left.split('-')[1]);
      const rightRevision = Number(right.split('-')[1]);
      return rightRevision - leftRevision;
    });

  return revisions
    .flatMap((entry) => CHROME_FOR_TESTING_RELATIVE_PATHS.map(
      (relativePath) => path.join(cacheDirectory, entry, relativePath)
    ))
    .find((candidate) => existsSync(candidate)) || null;
}

export function getBrowserLaunchOptions(options = {}, { extension = false } = {}) {
  if (process.platform !== 'darwin') {
    return options;
  }

  if (extension) {
    const executablePath = findChromeForTesting();
    if (!executablePath) {
      throw new Error(
        'Chrome for Testing is required for macOS extension E2E tests. ' +
        'Run "npx playwright install chromium" or set PANELIZE_E2E_EXTENSION_BROWSER.'
      );
    }

    return {
      ...options,
      executablePath,
    };
  }

  return {
    ...options,
    channel: 'chrome',
  };
}
