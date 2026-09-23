#!/usr/bin/env node
/**
 * Opens the live smoke profile in a normal (non-automated) browser window so
 * provider logins can be completed by hand. Usage: npm run test:live:login
 *
 * Each selected provider opens in its own tab, plus the multi-panel page to
 * confirm the panels show the logged-in state. Close the browser when done.
 */
import { spawn } from 'node:child_process';
import { launchExtension } from '../e2e/extension-harness.js';
import { getChromiumExecutablePath } from '../e2e/browser-launch-options.js';
import {
  LIVE_PROFILE_ROOT,
  LIVE_USER_DATA_DIR,
  configureLiveProviders,
  getSelectedProviders,
  prepareLiveExtension,
} from './live-harness.js';

const MAX_PANELS = 12;

const providers = getSelectedProviders();
const providerIds = providers.map((provider) => provider.id);
const extensionPath = await prepareLiveExtension();

// Store the provider settings with a short headless session, which also
// reveals the extension id for the multi-panel URL.
const setup = await launchExtension({ extensionPath, userDataDir: LIVE_USER_DATA_DIR, headless: true });
const panelCount = Math.min(providerIds.length, MAX_PANELS);
await configureLiveProviders(setup.serviceWorker, providerIds, {
  layout: panelCount > 6 ? '2x6' : `1x${panelCount}`,
});
const multiPanelUrl = setup.extensionUrl('multi-panel/multi-panel.html');
await setup.close();

// Plain launch without Playwright's automation switches: several sign-in
// flows (Google in particular) reject automated browsers.
const browser = spawn(getChromiumExecutablePath(), [
  `--user-data-dir=${LIVE_USER_DATA_DIR}`,
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
  '--no-first-run',
  '--no-default-browser-check',
  ...providers.map((provider) => provider.topLevelUrl || provider.url),
  multiPanelUrl,
], { stdio: 'ignore' });

console.log(`Live profile: ${LIVE_PROFILE_ROOT}`);
console.log(`Log in to: ${providerIds.join(', ')}`);
console.log('If a panel still looks logged out, log in inside that panel on the multi-panel tab.');
console.log('Close the browser window when you are done.');

browser.on('exit', (code) => {
  process.exitCode = code ?? 0;
});
