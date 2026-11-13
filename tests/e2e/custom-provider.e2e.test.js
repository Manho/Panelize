import { test, expect } from '@playwright/test';
import {
  createPatchedExtensionCopy,
  launchExtension,
  startFixtureServer,
} from './extension-harness.js';

const CUSTOM_PROVIDER_ID = 'custom-0123456789';
const CUSTOM_FRAME_RULE_ID = 10000;

function renderCustomChatFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Custom WebUI Fixture</title>
  </head>
  <body>
    <h1 id="fixture-title">Custom WebUI Fixture</h1>
    <div id="messages"></div>
    <form id="chat-form" style="margin-top:24px;display:flex;gap:8px;align-items:center">
      <textarea
        id="composer"
        aria-label="Prompt input"
        placeholder="Ask anything..."
        style="width:420px;height:64px"
      ></textarea>
      <button
        id="voice-btn"
        type="button"
        aria-label="Start voice mode"
        style="width:56px;height:36px"
      >Voice</button>
      <button
        id="send-btn"
        type="submit"
        aria-label="Send message"
        style="width:72px;height:36px"
      >Send</button>
    </form>
    <script>
      window.__voiceClicks = 0;
      const form = document.getElementById('chat-form');
      const composer = document.getElementById('composer');
      const messages = document.getElementById('messages');
      const voiceBtn = document.getElementById('voice-btn');

      voiceBtn.addEventListener('click', () => {
        window.__voiceClicks += 1;
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const prompt = composer.value.trim();
        if (!prompt) {
          return;
        }
        const reply = document.createElement('div');
        reply.className = 'assistant-reply';
        reply.textContent = 'Reply: ' + prompt;
        messages.appendChild(reply);
        composer.value = '';
      });
    </script>
  </body>
</html>`;
}

function renderNonExtensionFramerHtml(targetUrl, openControlUrl) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Non-extension Framer</title>
  </head>
  <body>
    <iframe id="open-control" src="${openControlUrl}" style="width:300px;height:200px"></iframe>
    <iframe id="framed-fixture" src="${targetUrl}" style="width:600px;height:400px"></iframe>
    <script>
      window.loadedFrameCount = 0;
      document.querySelectorAll('iframe').forEach((frame) => {
        frame.addEventListener(
          'load',
          () => {
            window.loadedFrameCount += 1;
          },
          { once: true }
        );
      });
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

async function readFramedTitle(frameHandle) {
  const frame = await frameHandle.contentFrame();
  if (!frame || frame.url().startsWith('chrome-error:')) {
    return null;
  }
  return frame
    .evaluate(() => document.getElementById('fixture-title')?.textContent ?? null)
    .catch(() => null);
}

test.describe('Custom web UI provider E2E (scoped DNR, dynamic driver, broadcast & clear)', () => {
  test.setTimeout(60_000);

  test('loads XFO/CSP-refusing custom fixture in Multi-Panel, drives fill/clear/send, and keeps non-extension framing blocked', async () => {
    const fixtureServer = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml());
    });

    const fixtureOrigin = `http://127.0.0.1:${fixtureServer.port}`;
    const fixtureChatUrl = `${fixtureOrigin}/chat`;

    const thirdPartyServer = await startFixtureServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (req.url === '/open-control') {
        res.end('<!doctype html><h1 id="fixture-title">Open Control</h1>');
        return;
      }
      res.end(
        renderNonExtensionFramerHtml(
          fixtureChatUrl,
          `http://localhost:${thirdPartyServer.port}/open-control`
        )
      );
    });
    const thirdPartyUrl = `http://localhost:${thirdPartyServer.port}/`;

    // Simulated host-permission grant for the custom origin (in production B3 UI,
    // chrome.permissions.request({ origins: [origin + '/*'] }) grants this per origin).
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${fixtureOrigin}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
      });
      await waitForServiceWorkerReady(extension);

      // Seed custom provider record in storage.local and enable it in storage.sync
      await extension.serviceWorker.evaluate(
        async ({ record, providerId }) => {
          await chrome.storage.local.set({
            customProviders: [record],
          });
          await chrome.storage.sync.set({
            enabledProviders: [providerId],
            providerOrder: [providerId],
            multiPanelProviders: [providerId],
            multiPanelLayout: '1x1',
          });
        },
        {
          providerId: CUSTOM_PROVIDER_ID,
          record: {
            id: CUSTOM_PROVIDER_ID,
            name: 'Local Fixture UI',
            url: fixtureChatUrl,
            frameRuleId: CUSTOM_FRAME_RULE_ID,
            createdAt: 1700000000000,
          },
        }
      );

      // Wait until service-worker reconcile registers both the dynamic driver script
      // and the scoped frame rule (restricted via topDomains to this extension).
      await expect
        .poll(
          async () => {
            extension.serviceWorker =
              extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
            return extension.serviceWorker.evaluate(
              async ({ scriptId, ruleId }) => {
                const scripts = await chrome.scripting.getRegisteredContentScripts({
                  ids: [scriptId],
                });
                const rules = await chrome.declarativeNetRequest.getDynamicRules();
                const rule = rules.find((item) => item.id === ruleId) || null;
                return {
                  scriptMatches: scripts[0]?.matches ?? null,
                  scriptJs: scripts[0]?.js ?? null,
                  scriptRunAt: scripts[0]?.runAt ?? null,
                  ruleUrlFilter: rule?.condition?.urlFilter ?? null,
                  ruleTopDomains: rule?.condition?.topDomains ?? null,
                };
              },
              {
                scriptId: `${CUSTOM_PROVIDER_ID}-scripts`,
                ruleId: CUSTOM_FRAME_RULE_ID,
              }
            );
          },
          { timeout: 20_000 }
        )
        .toEqual({
          scriptMatches: [`${fixtureOrigin}/*`],
          scriptJs: ['content-scripts/custom-provider-driver.js'],
          scriptRunAt: 'document_start',
          ruleUrlFilter: `|${fixtureOrigin}/`,
          ruleTopDomains: [extension.extensionId],
        });

      // 1. Open Multi-Panel and confirm custom panel loads inside its iframe despite XFO/CSP
      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      const panelIframeLocator = mpPage.locator('#panel-grid iframe');
      await expect(panelIframeLocator).toHaveCount(1);
      const panelHandle = await panelIframeLocator.elementHandle();
      await expect.poll(() => readFramedTitle(panelHandle), { timeout: 15_000 }).toBe(
        'Custom WebUI Fixture'
      );

      const customFrame = mpPage.frameLocator('#panel-grid iframe');
      const composer = customFrame.locator('#composer');
      await expect(composer).toBeVisible();

      // 2. Confirm Fill + CLEAR_INPUT works on the custom composer
      await mpPage.locator('#unified-input').fill('Draft before clear');
      await mpPage.locator('#fill-input-btn').click();
      await expect(composer).toHaveValue('Draft before clear');

      await mpPage.locator('#clear-all-btn').click();
      await expect(composer).toHaveValue('');

      // 3. Confirm broadcast Send fills and submits (reply visible, negative Voice button untouched)
      await mpPage.locator('#unified-input').fill('Hello custom fixture');
      await mpPage.locator('#send-all-btn').click();

      await expect(customFrame.locator('.assistant-reply')).toHaveText(
        'Reply: Hello custom fixture'
      );
      await expect(composer).toHaveValue('');

      const voiceClicks = await (await panelHandle.contentFrame()).evaluate(
        () => window.__voiceClicks
      );
      expect(voiceClicks).toBe(0);

      // 4. Confirm a non-extension page framing the exact same fixture URL is still blocked
      const thirdPartyPage = await extension.context.newPage();
      await thirdPartyPage.goto(thirdPartyUrl);
      await expect
        .poll(() => thirdPartyPage.evaluate(() => window.loadedFrameCount))
        .toBe(2);

      const openControlHandle = await thirdPartyPage
        .locator('#open-control')
        .elementHandle();
      const thirdPartyFrameHandle = await thirdPartyPage
        .locator('#framed-fixture')
        .elementHandle();

      expect(await readFramedTitle(openControlHandle)).toBe('Open Control');
      expect(await readFramedTitle(thirdPartyFrameHandle)).toBeNull();
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await thirdPartyServer.close();
      await fixtureServer.close();
    }
  });
});
