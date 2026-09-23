import { chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserLaunchOptions } from './browser-launch-options.js';

export const REPO_EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const COPY_EXCLUDED_SEGMENTS = ['.git', 'node_modules', 'test-results', 'playwright-report', 'dist'];

/**
 * Copies the extension into a temp directory and lets the caller patch its
 * manifest, e.g. to map provider content scripts onto local http fixtures.
 * @param {(manifest: object) => void} patchManifest - Mutates the parsed manifest.
 * @returns {Promise<{extensionPath: string, cleanup: () => Promise<void>}>}
 */
export async function createPatchedExtensionCopy(patchManifest) {
  const extensionPath = await mkdtemp(path.join(os.tmpdir(), 'panelize-e2e-extension-'));
  await cp(REPO_EXTENSION_PATH, extensionPath, {
    recursive: true,
    filter: (source) => !COPY_EXCLUDED_SEGMENTS.some(
      (segment) => path.relative(REPO_EXTENSION_PATH, source).split(path.sep).includes(segment)
    ),
  });

  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  patchManifest(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    extensionPath,
    cleanup: () => rm(extensionPath, { recursive: true, force: true }),
  };
}

/**
 * Starts a local HTTP server on a random port. Pair it with Chromium's
 * `--host-resolver-rules` so real provider hostnames resolve to fixtures.
 * @param {(request: import('node:http').IncomingMessage,
 *   response: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function startFixtureServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

/**
 * Launches Chromium with the unpacked extension in a throwaway profile.
 * @param {object} [options]
 * @param {string} [options.extensionPath] - Unpacked extension directory.
 * @param {string[]} [options.args] - Extra Chromium arguments.
 * @param {{width: number, height: number}} [options.viewport]
 * @returns {Promise<{context: import('@playwright/test').BrowserContext,
 *   serviceWorker: import('@playwright/test').Worker, extensionId: string,
 *   extensionUrl: (relativePath: string) => string, close: () => Promise<void>}>}
 */
export async function launchExtension({
  extensionPath = REPO_EXTENSION_PATH,
  args = [],
  viewport,
} = {}) {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'panelize-e2e-'));
  const context = await chromium.launchPersistentContext(
    userDataDir,
    getBrowserLaunchOptions({
      viewport,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        ...args,
      ],
    })
  );

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent('serviceworker');
  }
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    serviceWorker,
    extensionId,
    extensionUrl: (relativePath) => `chrome-extension://${extensionId}/${relativePath}`,
    async close() {
      await context.close().catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/**
 * Stores a panel configuration and opens the real multi-panel page.
 * @param {Awaited<ReturnType<typeof launchExtension>>} extension
 * @param {object} options
 * @param {string[]} options.providers - Provider ids, one panel each.
 * @param {string} [options.layout] - Grid layout id such as '1x1'.
 * @param {string[]} [options.enabledProviders] - Providers offered by the add
 *   panel menu; defaults to the open panels.
 * @returns {Promise<import('@playwright/test').Page>}
 */
export async function openMultiPanel(extension, { providers, layout = '1x1', enabledProviders = providers }) {
  await extension.serviceWorker.evaluate(async (settings) => {
    await chrome.storage.sync.set(settings);
  }, {
    enabledProviders,
    providerOrder: enabledProviders,
    multiPanelProviders: providers,
    multiPanelLayout: layout,
  });

  const page = await extension.context.newPage();
  await page.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
  await page.waitForFunction(
    (count) => document.querySelectorAll('#panel-grid iframe').length === count,
    providers.length
  );
  return page;
}
