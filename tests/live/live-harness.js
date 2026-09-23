import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPatchedExtensionCopy, REPO_EXTENSION_PATH } from '../e2e/extension-harness.js';
import { PROVIDERS } from '../../modules/providers.js';
import { OPTIONAL_PROVIDER_CONFIGS } from '../../modules/optional-provider-access.js';

/**
 * Live smoke runs keep a dedicated profile outside the repository so provider
 * logins survive between runs. The extension copy lives next to it at a fixed
 * path: unpacked extension ids derive from the path, and the id decides which
 * storage partition the provider iframes use.
 */
export const LIVE_PROFILE_ROOT = path.resolve(
  process.env.PANELIZE_LIVE_PROFILE || path.join(os.homedir(), '.panelize-live-profile')
);
export const LIVE_USER_DATA_DIR = path.join(LIVE_PROFILE_ROOT, 'user-data');
export const LIVE_EXTENSION_PATH = path.join(LIVE_PROFILE_ROOT, 'extension');

/** PANELIZE_LIVE_SEND=1 really sends the prompt, which uses provider quota. */
export const LIVE_SEND_ENABLED = process.env.PANELIZE_LIVE_SEND === '1';

/** Live runs are headed by default because several sites block headless browsers. */
export const LIVE_HEADLESS = process.env.PANELIZE_LIVE_HEADLESS === '1';

/**
 * Providers selected with PANELIZE_LIVE_PROVIDERS (comma separated ids), or all.
 * @returns {typeof PROVIDERS}
 */
export function getSelectedProviders() {
  const requested = (process.env.PANELIZE_LIVE_PROVIDERS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    return PROVIDERS;
  }

  const unknown = requested.filter((id) => !PROVIDERS.some((provider) => provider.id === id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown PANELIZE_LIVE_PROVIDERS id(s): ${unknown.join(', ')}. ` +
      `Known ids: ${PROVIDERS.map((provider) => provider.id).join(', ')}`
    );
  }
  return PROVIDERS.filter((provider) => requested.includes(provider.id));
}

/**
 * Refreshes the fixed-path extension copy from the working tree. Optional
 * provider host permissions are granted in the manifest because granting them
 * at runtime needs a user gesture on the options page.
 * @returns {Promise<string>} Extension path.
 */
export async function prepareLiveExtension() {
  const { extensionPath } = await createPatchedExtensionCopy((manifest) => {
    manifest.host_permissions.push(...(manifest.optional_host_permissions || []));
  }, { destination: LIVE_EXTENSION_PATH });
  return extensionPath;
}

/**
 * Enables `providerIds` and opens `firstProviderId` as the single panel, then
 * waits until the service worker has registered optional provider scripts.
 * @param {import('@playwright/test').Worker} serviceWorker
 * @param {string[]} providerIds
 * @param {object} [options]
 * @param {string[]} [options.panelOrder] - Order of panels, defaults to providerIds.
 * @param {string} [options.layout]
 */
export async function configureLiveProviders(serviceWorker, providerIds, {
  panelOrder = providerIds,
  layout = '1x1',
} = {}) {
  await serviceWorker.evaluate(async (settings) => {
    await chrome.storage.sync.set(settings);
  }, {
    enabledProviders: providerIds,
    providerOrder: panelOrder,
    multiPanelProviders: panelOrder,
    multiPanelLayout: layout,
  });

  const optionalScriptIds = providerIds
    .filter((id) => OPTIONAL_PROVIDER_CONFIGS[id])
    .map((id) => OPTIONAL_PROVIDER_CONFIGS[id].contentScript.id);
  if (optionalScriptIds.length === 0) {
    return;
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const registered = await serviceWorker.evaluate(async () => (
      (await chrome.scripting.getRegisteredContentScripts()).map(({ id }) => id)
    ));
    if (optionalScriptIds.every((id) => registered.includes(id))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Optional provider content scripts were not registered: ${optionalScriptIds.join(', ')}`);
}

const TEXT_INJECTION_SOURCE = readFileSync(
  path.join(REPO_EXTENSION_PATH, 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

/**
 * Reads a `const NAME = { ... };` selector table straight from the content
 * script, so the smoke test checks exactly the selectors production uses.
 * @param {string} name - e.g. 'SEND_BUTTON_SELECTORS'.
 * @returns {Record<string, string[]>}
 */
export function readContentScriptSelectorTable(name) {
  const start = TEXT_INJECTION_SOURCE.indexOf(`const ${name} = {`);
  if (start === -1) {
    throw new Error(`Selector table ${name} not found in text-injection-all-providers.js`);
  }

  const open = TEXT_INJECTION_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < TEXT_INJECTION_SOURCE.length; index += 1) {
    const char = TEXT_INJECTION_SOURCE[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      // The tables are plain literals of strings and arrays (with comments).
      return new Function(`return (${TEXT_INJECTION_SOURCE.slice(open, index + 1)});`)();
    }
  }
  throw new Error(`Selector table ${name} is not terminated`);
}
