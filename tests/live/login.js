#!/usr/bin/env node
/**
 * Opens the live smoke profile in a normal (non-automated) browser window so
 * provider logins can be completed by hand. Usage: npm run test:live:login
 *
 * Each selected provider opens in its own tab, plus the multi-panel page to
 * confirm the panels show the logged-in state. More than 12 providers open in
 * batches; quit the browser to move to the next one.
 */
import { spawn } from 'node:child_process';
import { launchExtension } from '../e2e/extension-harness.js';
import { getChromiumExecutablePath } from '../e2e/browser-launch-options.js';
import {
  LIVE_IGNORED_DEFAULT_ARGS,
  LIVE_PROFILE_ROOT,
  LIVE_USER_DATA_DIR,
  configureLiveProviders,
  getSelectedProviders,
  prepareLiveExtension,
} from './live-harness.js';

const MAX_PANELS = 12;

const providers = getSelectedProviders();
const extensionPath = await prepareLiveExtension();

// A multi-panel page shows at most MAX_PANELS panels, so larger selections
// are split into even batches that open one after another.
const batchCount = Math.ceil(providers.length / MAX_PANELS);
const batchSize = Math.ceil(providers.length / batchCount);
const batches = Array.from({ length: batchCount }, (_, index) => (
  providers.slice(index * batchSize, (index + 1) * batchSize)
));

console.log(`Live profile: ${LIVE_PROFILE_ROOT}`);
for (const [index, batch] of batches.entries()) {
  const batchIds = batch.map((provider) => provider.id);

  // Store the provider settings with a short headless session, which also
  // reveals the extension id for the multi-panel URL.
  const setup = await launchExtension({
    extensionPath,
    userDataDir: LIVE_USER_DATA_DIR,
    headless: true,
    ignoreDefaultArgs: LIVE_IGNORED_DEFAULT_ARGS,
  });
  await configureLiveProviders(setup.serviceWorker, batchIds, {
    layout: batchIds.length > 4 ? `2x${Math.ceil(batchIds.length / 2)}` : `1x${batchIds.length}`,
  });
  const multiPanelUrl = setup.extensionUrl('multi-panel/multi-panel.html');
  await setup.close();

  console.log(`\nBatch ${index + 1}/${batches.length}. Log in to: ${batchIds.join(', ')}`);
  console.log('If a panel still looks logged out, log in inside that panel on the multi-panel tab.');
  console.log('Quit the browser when you are done (Cmd+Q on macOS; closing the window is not enough).');

  // Plain launch without Playwright's automation switches: several sign-in
  // flows (Google in particular) reject automated browsers.
  const browser = spawn(getChromiumExecutablePath(), [
    `--user-data-dir=${LIVE_USER_DATA_DIR}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...batch.map((provider) => provider.topLevelUrl || provider.url),
    multiPanelUrl,
  ], { stdio: 'ignore' });
  const exitCode = await new Promise((resolve) => {
    browser.on('exit', resolve);
  });
  if (exitCode) {
    process.exitCode = exitCode;
    break;
  }
}
