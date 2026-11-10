import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { launchExtension, openMultiPanel } from './extension-harness.js';

// Provider frame responses with X-Frame-Options removed through DNR. Playwright
// route.fulfill() responses skip DNR header rules, so these tests serve the
// provider hosts from a real local TLS server: host resolver rules map each
// host to it and the URLs, and so the shipped `https://<host>/*` filters, stay
// unchanged.
const PROVIDER_HOSTS = {
  chatgpt: 'chatgpt.com',
  claude: 'claude.ai',
  gemini: 'gemini.google.com',
  grok: 'grok.com',
  deepseek: 'chat.deepseek.com',
  google: 'www.google.com',
};
const CHATGPT_ALTERNATE_HOST = 'chat.openai.com';
const THIRD_PARTY_HOST = 'third-party.test';
// Controls: a host that allows framing, and one that refuses it with no rule.
const OPEN_CONTROL_HOST = 'open-control.test';
const REFUSING_CONTROL_HOST = 'refusing-control.test';
const REFUSING_HOSTS = new Set([...Object.values(PROVIDER_HOSTS), CHATGPT_ALTERNATE_HOST, REFUSING_CONTROL_HOST]);
const ALL_HOSTS = [...REFUSING_HOSTS, THIRD_PARTY_HOST, OPEN_CONTROL_HOST];

const STATIC_RULESET_ID = 'bypass_headers';
// A custom browser (PANELIZE_E2E_EXTENSION_BROWSER) may predate topDomains;
// the bundled Chromium never does.
const CUSTOM_BROWSER = Boolean(process.env.PANELIZE_E2E_EXTENSION_BROWSER);
// Older Chrome for Testing builds start a lot slower than the bundled one.
test.describe.configure({ timeout: CUSTOM_BROWSER ? 120_000 : 30_000 });

function renderThirdPartyPage() {
  const frames = [...Object.values(PROVIDER_HOSTS), OPEN_CONTROL_HOST, REFUSING_CONTROL_HOST]
    .map((host) => `<iframe data-host="${host}" src="https://${host}/"></iframe>`)
    .join('');
  return `<!doctype html><title>third party</title><body>${frames}<script>
    window.loadedFrames = 0;
    document.querySelectorAll('iframe').forEach((frame) => {
      frame.addEventListener('load', () => { window.loadedFrames += 1; }, { once: true });
    });
  </script></body>`;
}

async function startTlsFixtureServer() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'panelize-tls-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=panelize-e2e', '-keyout', keyPath, '-out', certPath,
  ], { stdio: 'ignore' });
  const server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (request, response) => {
    const host = (request.headers.host || '').split(':')[0];
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (host === THIRD_PARTY_HOST) {
      response.end(renderThirdPartyPage());
      return;
    }
    if (REFUSING_HOSTS.has(host)) {
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    }
    response.end(`<!doctype html><title>${host}</title><p id="fixture-host">${host}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Older Chrome reports the extension service worker before its extension APIs
 * are bound, and may restart it once; wait until they are usable.
 */
async function waitForExtensionApis(extension) {
  await expect.poll(async () => {
    // After a restart only the newest worker handle is usable.
    extension.serviceWorker = extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
    return extension.serviceWorker
      .evaluate(() => Boolean(chrome.storage?.sync && chrome.declarativeNetRequest?.getDynamicRules))
      .catch(() => false);
  }, { timeout: 60_000 }).toBe(true);
}

async function launchWithFixtures() {
  const server = await startTlsFixtureServer();
  const hostRules = ALL_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${server.port}`).join(',');
  const extension = await launchExtension({
    viewport: { width: 1600, height: 900 },
    args: [`--host-resolver-rules=${hostRules}`, '--ignore-certificate-errors'],
  });
  await waitForExtensionApis(extension);
  return {
    extension,
    async close() {
      await extension.close();
      await server.close();
    },
  };
}

/** What a frame shows: the fixture host it rendered, or null if it was refused. */
async function renderedHost(frameElement) {
  const frame = await frameElement.contentFrame();
  if (!frame || frame.url().startsWith('chrome-error:')) {
    return null;
  }
  return frame.evaluate(() => document.getElementById('fixture-host')?.textContent ?? null).catch(() => null);
}

async function readRuleState(extension) {
  return extension.serviceWorker.evaluate(async (rulesetId) => ({
    topDomainsSupported: chrome.declarativeNetRequest.RuleConditionKeys?.TOP_DOMAINS === 'topDomains',
    staticEnabled: (await chrome.declarativeNetRequest.getEnabledRulesets()).includes(rulesetId),
    scopedRules: (await chrome.declarativeNetRequest.getDynamicRules())
      .filter(({ id }) => id > 3000 && id < 4000)
      .map(({ id, condition }) => ({ id, urlFilter: condition.urlFilter, topDomains: condition.topDomains })),
  }), STATIC_RULESET_ID);
}

/** Waits until the frame header rules settle for this browser and returns them. */
async function waitForSettledRules(extension) {
  const { topDomainsSupported } = await readRuleState(extension);
  if (!CUSTOM_BROWSER) {
    expect(topDomainsSupported, 'the bundled Chromium supports topDomains').toBe(true);
  }
  // The service worker reconciles the rules after install; under load that
  // can take seconds. A failed scoped install keeps the ruleset enabled for
  // good, so it still fails here.
  await expect.poll(async () => (await readRuleState(extension)).staticEnabled, { timeout: 30_000 })
    .toBe(!topDomainsSupported);
  return readRuleState(extension);
}

/** The Multi-Panel iframe that was opened on host. */
async function findPanelFrame(page, host) {
  for (const handle of await page.locator('#panel-grid iframe').elementHandles()) {
    if (await handle.evaluate((frame, expected) => new URL(frame.src).hostname === expected, host)) {
      return handle;
    }
  }
  return null;
}

async function expectEveryPanelLoads(page) {
  const panels = page.locator('#panel-grid iframe');
  await expect(panels).toHaveCount(Object.keys(PROVIDER_HOSTS).length);
  for (const [providerId, host] of Object.entries(PROVIDER_HOSTS)) {
    const panel = await findPanelFrame(page, host);
    expect(panel, providerId).not.toBeNull();
    await expect.poll(() => renderedHost(panel), { message: providerId }).toBe(host);
  }
}

async function openThirdPartyPage(extension) {
  const page = await extension.context.newPage();
  await page.goto(`https://${THIRD_PARTY_HOST}/`);
  const frameCount = await page.locator('iframe').count();
  // Every frame has finished, either rendering or showing the refusal page.
  await expect.poll(() => page.evaluate(() => window.loadedFrames)).toBe(frameCount);
  const hostOf = async (host) => renderedHost(await page.locator(`iframe[data-host="${host}"]`).elementHandle());
  // The fixture server works from this page, and refusals are enforced.
  expect(await hostOf(OPEN_CONTROL_HOST)).toBe(OPEN_CONTROL_HOST);
  expect(await hostOf(REFUSING_CONTROL_HOST)).toBeNull();
  return { page, hostOf };
}

async function simulateBrowserWithoutTopDomains(extension) {
  await extension.serviceWorker.evaluate(() => {
    Object.defineProperty(chrome.declarativeNetRequest, 'RuleConditionKeys', { configurable: true, value: undefined });
  });
}

// A provider list change reconciles the frame header rules.
async function triggerReconcile(extension) {
  await extension.serviceWorker.evaluate(async (providers) => {
    await chrome.storage.sync.set({ enabledProviders: [...providers, 'kimi'] });
    await chrome.storage.sync.set({ enabledProviders: providers });
  }, Object.keys(PROVIDER_HOSTS));
}

test('every provider panel loads in Multi-Panel with its frame header rule', async () => {
  const fixtures = await launchWithFixtures();
  try {
    const page = await openMultiPanel(fixtures.extension, { providers: Object.keys(PROVIDER_HOSTS), layout: '1x12' });
    const rules = await waitForSettledRules(fixtures.extension);
    if (rules.topDomainsSupported) {
      expect(rules.scopedRules).toHaveLength(Object.keys(PROVIDER_HOSTS).length + 1);
      rules.scopedRules.forEach((rule) => expect(rule.topDomains).toEqual([fixtures.extension.extensionId]));
    } else {
      expect(rules.scopedRules).toEqual([]);
    }

    await page.reload();
    await expectEveryPanelLoads(page);

    // A provider page that moves itself to another provider origin keeps loading.
    const chatgptPanel = await findPanelFrame(page, PROVIDER_HOSTS.chatgpt);
    await (await chatgptPanel.contentFrame()).evaluate((host) => { window.location.href = `https://${host}/`; }, CHATGPT_ALTERNATE_HOST);
    await expect.poll(() => renderedHost(chatgptPanel)).toBe(CHATGPT_ALTERNATE_HOST);
  } finally {
    await fixtures.close();
  }
});

test('a third-party page cannot frame a provider page that refuses framing', async () => {
  const fixtures = await launchWithFixtures();
  try {
    const rules = await waitForSettledRules(fixtures.extension);
    const { hostOf } = await openThirdPartyPage(fixtures.extension);

    for (const [providerId, host] of Object.entries(PROVIDER_HOSTS)) {
      // Without topDomains the manifest ruleset applies everywhere, as before.
      expect(await hostOf(host), providerId).toBe(rules.topDomainsSupported ? null : host);
    }
  } finally {
    await fixtures.close();
  }
});

test('without topDomains support the unscoped rules come back and panels keep loading', async () => {
  const fixtures = await launchWithFixtures();
  try {
    await waitForSettledRules(fixtures.extension);
    await simulateBrowserWithoutTopDomains(fixtures.extension);
    await triggerReconcile(fixtures.extension);

    await expect.poll(() => readRuleState(fixtures.extension)).toMatchObject({ staticEnabled: true, scopedRules: [] });
    const page = await openMultiPanel(fixtures.extension, { providers: Object.keys(PROVIDER_HOSTS), layout: '1x12' });
    await expectEveryPanelLoads(page);
  } finally {
    await fixtures.close();
  }
});
