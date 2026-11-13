import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createPatchedExtensionCopy,
  filterNonWildcardHostPermissions,
  REPO_EXTENSION_PATH,
} from '../e2e/extension-harness.js';
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

/**
 * Playwright switches the live profile must not get. With `--use-mock-keychain`
 * Chromium encrypts cookies with a fixed test key instead of the OS keychain
 * key used by the plain browser in `test:live:login`, so every login cookie
 * saved there fails to decrypt and the sites look logged out.
 */
export const LIVE_IGNORED_DEFAULT_ARGS = ['--use-mock-keychain'];

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

/** Version parts are at most 65535; stay strictly monotonic even across runs in the same minute. */
function getCopyBuildNumber(previousFourth = 0) {
  const minuteBuild = Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000) % 65535 + 1;
  if (Number.isInteger(previousFourth) && previousFourth >= minuteBuild && previousFourth < 65535) {
    return previousFourth + 1;
  }
  return minuteBuild;
}

function readExistingLiveBuildNumber() {
  try {
    const existing = JSON.parse(readFileSync(path.join(LIVE_EXTENSION_PATH, 'manifest.json'), 'utf8'));
    const fourth = Number(String(existing.version || '').split('.')[3]);
    return Number.isInteger(fourth) && fourth > 0 ? fourth : 0;
  } catch {
    return 0;
  }
}

/**
 * Refreshes the fixed-path extension copy from the working tree. Optional
 * provider host permissions are granted in the manifest because granting them
 * at runtime needs a user gesture on the options page.
 *
 * The copy also gets a fresh fourth version part: Chrome keeps the registered
 * service worker of an unpacked extension while its version stays the same,
 * so the live profile would otherwise run an old background script.
 * @returns {Promise<string>} Extension path.
 */
export async function prepareLiveExtension() {
  const nextBuildNumber = getCopyBuildNumber(readExistingLiveBuildNumber());
  const { extensionPath } = await createPatchedExtensionCopy((manifest) => {
    manifest.host_permissions.push(...filterNonWildcardHostPermissions(manifest.optional_host_permissions));
    const [major = 0, minor = 0, patch = 0] = manifest.version.split('.');
    manifest.version = [major, minor, patch, nextBuildNumber].join('.');
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
  const optionalConfigs = providerIds
    .map((id) => OPTIONAL_PROVIDER_CONFIGS[id])
    .filter(Boolean);
  const optionalScriptIds = optionalConfigs.map((cfg) => cfg.contentScript.id);
  const optionalRuleIds = optionalConfigs
    .map((cfg) => cfg.frameRule?.id)
    .filter(Number.isInteger);

  const checkAccessState = () => serviceWorker.evaluate(
    async ({ scriptIds, ruleIds }) => {
      const registeredScripts = (await chrome.scripting.getRegisteredContentScripts()).map(({ id }) => id);
      const installedRuleIds = (await chrome.declarativeNetRequest.getDynamicRules()).map(({ id }) => id);
      return {
        allReady: (
          scriptIds.every((id) => registeredScripts.includes(id)) &&
          ruleIds.every((id) => installedRuleIds.includes(id))
        ),
        anyRemaining: (
          scriptIds.some((id) => registeredScripts.includes(id)) ||
          ruleIds.some((id) => installedRuleIds.includes(id))
        ),
      };
    },
    { scriptIds: optionalScriptIds, ruleIds: optionalRuleIds }
  );

  const initialAccess = await checkAccessState();
  if (!initialAccess.allReady) {
    await serviceWorker.evaluate(async () => {
      await chrome.storage.sync.remove('enabledProviders');
    });
    const drainDeadline = Date.now() + 5000;
    while (Date.now() < drainDeadline) {
      const state = await checkAccessState();
      if (!state.anyRemaining) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  await serviceWorker.evaluate(async (settings) => {
    await chrome.storage.sync.set(settings);
  }, {
    enabledProviders: providerIds,
    providerOrder: panelOrder,
    multiPanelProviders: panelOrder,
    multiPanelLayout: layout,
  });

  if (optionalScriptIds.length === 0 && optionalRuleIds.length === 0) {
    return;
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await checkAccessState();
    if (state.allReady) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Optional provider access was not ready: scripts=${optionalScriptIds.join(', ')}`);
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

/**
 * ChatGPT's composer selectors, which live in the shared chatgpt-composer.js
 * instead of the PROVIDER_SELECTORS table.
 * @returns {string[]}
 */
export function readChatgptEditorSelectors() {
  const source = readFileSync(path.join(REPO_EXTENSION_PATH, 'content-scripts/chatgpt-composer.js'), 'utf8');
  const scope = {};
  new Function('window', source)(scope);
  return [...scope.PanelizeChatgptComposer.EDITOR_SELECTORS];
}
