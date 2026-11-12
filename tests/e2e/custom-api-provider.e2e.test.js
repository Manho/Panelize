import { test, expect } from '@playwright/test';
import {
  createPatchedExtensionCopy,
  launchExtension,
  openMultiPanel,
  startFixtureServer,
} from './extension-harness.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

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

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

test.describe('M3 Custom OpenAI-compatible API provider E2E', () => {
  test.setTimeout(90_000);

  test('adds two API models on one strict-Origin server, isolates secrets in IndexedDB, streams Markdown/reasoning/images side-by-side, supports Stop & New Chat, and retains shared permission on partial delete', async ({}, testInfo) => {
    const serverState = {
      requests: [],
      abortedModels: [],
      rejectedOrigins: [],
    };
    const runtimeErrors = [];

    const apiServer = await startFixtureServer(async (req, res) => {
      // Serve a tiny HTML helper page for verifying non-extension Origin preservation
      if (req.method === 'GET' && req.url === '/probe-page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><title>Probe</title><h1>Probe</h1>');
        return;
      }

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Unexpected route: ${req.method} ${req.url}` } }));
        return;
      }

      // Strict Ollama-style Origin enforcement: NO CORS headers, and any request
      // carrying an Origin header is rejected with HTTP 403. Extension top-level
      // fetches only succeed when our dynamic DNR rule strips `Origin`.
      if (req.headers.origin) {
        serverState.rejectedOrigins.push(req.headers.origin);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: `Rejected unexpected Origin header: ${req.headers.origin}` },
          })
        );
        return;
      }

      const rawBody = await readRequestBody(req);
      const parsed = JSON.parse(rawBody);
      const authHeader = req.headers.authorization || null;

      serverState.requests.push({
        model: parsed.model,
        authHeader,
        messages: parsed.messages,
        stream: parsed.stream,
      });

      if (
        (parsed.model === 'alpha-reasoner' || parsed.model === 'alpha-reasoner-v2') &&
        authHeader !== 'Bearer sk-e2e-alpha'
      ) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing or invalid Alpha API key' } }));
        return;
      }
      if (
        (parsed.model === 'beta-local' || parsed.model === 'beta-upgraded') &&
        authHeader !== null
      ) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Beta expects no Authorization header' } }));
        return;
      }

      const lastMessage = parsed.messages.at(-1);
      const textPrompt = Array.isArray(lastMessage?.content)
        ? lastMessage.content.find((p) => p.type === 'text')?.text || ''
        : String(lastMessage?.content || '');
      const imageCount = Array.isArray(lastMessage?.content)
        ? lastMessage.content.filter((p) => p.type === 'image_url').length
        : 0;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      if (textPrompt.includes('[SLOW_STREAM]')) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: `Streaming slow on ${parsed.model}...` } }],
          })}\r\n\r\n`
        );
        res.on('close', () => {
          if (!res.writableEnded) {
            serverState.abortedModels.push(parsed.model);
          }
        });
        return;
      }

      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { reasoning_content: `Thinking as ${parsed.model}` } }],
        })}\r\n\r\n`
      );
      const replyMarkdown =
        imageCount > 0
          ? `Received **${imageCount} image** on \`${parsed.model}\`: ${textPrompt}`
          : `Reply from **${parsed.model}**\n\n\`\`\`js\nconst ok = true;\n\`\`\`\n\n<img src=x onerror="window.__e2eXss=1">`;

      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: replyMarkdown }, finish_reason: 'stop' }],
        })}\r\n\r\n`
      );
      res.write('data: [DONE]\r\n\r\n');
      res.end();
    });

    const apiOrigin = `http://127.0.0.1:${apiServer.port}`;
    const webProbeServer = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>External Web Page</title><h1>External Web Page</h1>');
    });
    const externalWebUrl = `http://localhost:${webProbeServer.port}/`;

    // Simulated host-permission grant for apiOrigin so chrome.permissions.request resolves true in headless E2E
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${apiOrigin}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 840 },
      });
      await waitForServiceWorkerReady(extension);

      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt'],
          providerOrder: ['chatgpt'],
          multiPanelProviders: ['chatgpt'],
          multiPanelLayout: '1x2',
        });
      });

      // 1. Add two Custom API providers on the same origin via Options UI
      const isExpectedOfflineUpdateError = (text) =>
        text.includes('ERR_NAME_NOT_RESOLVED') ||
        text.includes('Error fetching latest GitHub release');

      const optionsPage = await extension.context.newPage();
      optionsPage.on('pageerror', (err) => runtimeErrors.push(`options pageerror: ${err.message}`));
      optionsPage.on('console', (msg) => {
        if (msg.type() === 'error' && !isExpectedOfflineUpdateError(msg.text())) {
          runtimeErrors.push(`options console.error: ${msg.text()}`);
        }
      });
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await expect(optionsPage.locator('#custom-provider-form')).toBeVisible();
      await expect(optionsPage.locator('#custom-provider-api-fields')).toBeHidden();
      await expect(optionsPage.locator('#custom-provider-api-note')).toBeHidden();

      await optionsPage.locator('#custom-provider-kind-api').check();
      await expect(optionsPage.locator('#custom-provider-api-fields')).toBeVisible();
      await expect(optionsPage.locator('#custom-provider-api-note')).toBeVisible();

      // Verify mobile viewport (375x667) renders the Custom API form cleanly without horizontal overflow
      await optionsPage.setViewportSize({ width: 375, height: 667 });
      await optionsPage.locator('#custom-provider-card').scrollIntoViewIfNeeded();
      const mobileOptionsOverflow = await optionsPage.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1
      );
      expect(mobileOptionsOverflow).toBe(true);
      const optionsMobileShot = testInfo.outputPath('options-custom-api-mobile.png');
      await optionsPage.screenshot({ path: optionsMobileShot });
      await testInfo.attach('options-custom-api-mobile', {
        path: optionsMobileShot,
        contentType: 'image/png',
      });
      await optionsPage.setViewportSize({ width: 1280, height: 840 });

      // Add Local Alpha (with API key)
      await optionsPage.locator('#custom-provider-name').fill('Local Alpha');
      await optionsPage.locator('#custom-provider-url').fill(apiOrigin);
      await expect(optionsPage.locator('#custom-provider-origin-preview')).toContainText(
        `${apiOrigin}/v1/chat/completions`
      );
      await optionsPage.locator('#custom-provider-model').fill('alpha-reasoner');
      await optionsPage.locator('#custom-provider-api-key').fill('sk-e2e-alpha');

      // Verify password unmask toggle a11y state
      await optionsPage.locator('#custom-provider-api-key-toggle').click();
      await expect(optionsPage.locator('#custom-provider-api-key')).toHaveAttribute('type', 'text');
      await expect(optionsPage.locator('#custom-provider-api-key-toggle')).toHaveAttribute(
        'aria-pressed',
        'true'
      );

      await optionsPage.locator('#custom-provider-add-btn').click();

      const customRows = optionsPage.locator(
        '#provider-list .provider-item[data-custom-provider="true"]'
      );
      await expect(customRows).toHaveCount(1);
      await expect(customRows.first().locator('.provider-origin-badge')).toHaveText(apiOrigin);
      await expect(customRows.first().locator('.provider-model-badge')).toHaveText('alpha-reasoner');
      const alphaId = await customRows.first().getAttribute('data-provider-id');

      // Add Local Beta on the SAME origin (without API key)
      await optionsPage.locator('#custom-provider-name').fill('Local Beta');
      await optionsPage.locator('#custom-provider-url').fill(`${apiOrigin}/v1`);
      await optionsPage.locator('#custom-provider-model').fill('beta-local');
      await optionsPage.locator('#custom-provider-add-btn').click();

      await expect(customRows).toHaveCount(2);
      const betaId = await customRows.nth(1).getAttribute('data-provider-id');
      expect(betaId).not.toBe(alphaId);

      // 2. Verify strict secret isolation: API key is NEVER in storage.local or storage.sync
      const storageSnapshot = await extension.serviceWorker.evaluate(async () => ({
        local: await chrome.storage.local.get(null),
        sync: await chrome.storage.sync.get(null),
      }));
      expect(JSON.stringify(storageSnapshot.local)).not.toContain('sk-e2e-alpha');
      expect(JSON.stringify(storageSnapshot.sync)).not.toContain('sk-e2e-alpha');

      // Wait until dynamic DNR Origin-strip rules are active (and ZERO content scripts registered)
      await expect
        .poll(
          async () => {
            extension.serviceWorker =
              extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
            return extension.serviceWorker.evaluate(async () => {
              const rules = await chrome.declarativeNetRequest.getDynamicRules();
              const scripts = await chrome.scripting.getRegisteredContentScripts();
              const customRules = rules.filter((r) => r.id >= 10000);
              return {
                customRuleCount: customRules.length,
                headersRemoved: customRules.flatMap((r) =>
                  (r.action?.requestHeaders || []).map((h) => `${h.operation}:${h.header}`)
                ),
                scriptCount: scripts.length,
              };
            });
          },
          { timeout: 15_000 }
        )
        .toEqual({
          customRuleCount: 2,
          headersRemoved: ['remove:Origin', 'remove:Origin'],
          scriptCount: 0,
        });

      // Confirm non-extension web pages still send their Origin header (not stripped by initiatorDomains rule)
      const externalPage = await extension.context.newPage();
      await externalPage.goto(externalWebUrl);
      await externalPage.evaluate(async (endpoint) => {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ model: 'beta-local', messages: [] }),
        }).catch(() => {});
      }, `${apiOrigin}/v1/chat/completions`);
      expect(serverState.rejectedOrigins).toContain(`http://localhost:${webProbeServer.port}`);
      await externalPage.close();

      // 3. Open Multi-Panel with both Custom API panels side by side
      const mpPage = await openMultiPanel(extension, {
        providers: [alphaId, betaId],
        layout: '1x2',
        enabledProviders: [alphaId, betaId],
      });
      mpPage.on('pageerror', (err) => runtimeErrors.push(`multi-panel pageerror: ${err.message}`));
      mpPage.on('console', (msg) => {
        if (msg.type() === 'error') runtimeErrors.push(`multi-panel console.error: ${msg.text()}`);
      });

      const panels = mpPage.locator('#panel-grid .panel-item');
      await expect(panels).toHaveCount(2);
      // Custom API panels have topLevelUrl === null, so Open-in-New-Tab button is omitted
      await expect(mpPage.locator('#panel-grid .open-provider-top-level-btn')).toHaveCount(0);
      await expect(panels.nth(0).locator('.panel-origin-badge')).toHaveText(apiOrigin);
      await expect(panels.nth(1).locator('.panel-origin-badge')).toHaveText(apiOrigin);

      const alphaFrame = panels.nth(0).frameLocator('iframe');
      const betaFrame = panels.nth(1).frameLocator('iframe');

      await expect(alphaFrame.locator('#api-model-badge')).toHaveText('alpha-reasoner');
      await expect(betaFrame.locator('#api-model-badge')).toHaveText('beta-local');

      // 4. Broadcast prompt via Send All -> real SSE streaming + Markdown + reasoning + XSS neutralization
      await mpPage.locator('#unified-input').fill('Compare architectures');
      await mpPage.locator('#send-all-btn').click();

      await expect(alphaFrame.locator('.turn-assistant .turn-markdown strong')).toHaveText(
        'alpha-reasoner'
      );
      await expect(betaFrame.locator('.turn-assistant .turn-markdown strong')).toHaveText(
        'beta-local'
      );
      await expect(alphaFrame.locator('.thinking-content')).toHaveText(
        'Thinking as alpha-reasoner'
      );
      await expect(alphaFrame.locator('.turn-markdown pre code')).toContainText('const ok = true;');
      await expect(alphaFrame.locator('.turn-markdown img')).toHaveCount(0);

      const alphaFrameHandle = await panels.nth(0).locator('iframe').elementHandle();
      const xssFlag = await (await alphaFrameHandle.contentFrame()).evaluate(
        () => window.__e2eXss
      );
      expect(xssFlag).toBeUndefined();

      // 5. Multimodal image Fill + Send All
      await mpPage.locator('#image-file-input').setInputFiles({
        name: 'pixel.png',
        mimeType: 'image/png',
        buffer: PNG_BYTES,
      });
      await mpPage.locator('#unified-input').fill('Inspect pixel');
      await mpPage.locator('#fill-input-btn').click();

      await expect(mpPage.locator('#send-status')).toHaveText('Filled 2 inputs');
      await expect(alphaFrame.locator('#staged-images .staged-image-item')).toHaveCount(1);
      await expect(betaFrame.locator('#staged-images .staged-image-item')).toHaveCount(1);

      await mpPage.locator('#send-all-btn').click();
      await expect(alphaFrame.locator('.turn-assistant .turn-markdown').nth(1)).toContainText(
        'Received 1 image on alpha-reasoner: Inspect pixel'
      );
      await expect(betaFrame.locator('.turn-assistant .turn-markdown').nth(1)).toContainText(
        'Received 1 image on beta-local: Inspect pixel'
      );

      // Capture desktop side-by-side comparison screenshot and mobile narrow-panel screenshot
      const desktopShot = testInfo.outputPath('multi-panel-custom-api-desktop.png');
      await mpPage.screenshot({ path: desktopShot });
      await testInfo.attach('multi-panel-custom-api-desktop', {
        path: desktopShot,
        contentType: 'image/png',
      });
      await mpPage.setViewportSize({ width: 390, height: 844 });
      await expect(alphaFrame.locator('#composer-input')).toBeVisible();
      const mobileShot = testInfo.outputPath('multi-panel-custom-api-mobile.png');
      await mpPage.screenshot({ path: mobileShot });
      await testInfo.attach('multi-panel-custom-api-mobile', {
        path: mobileShot,
        contentType: 'image/png',
      });
      await mpPage.setViewportSize({ width: 1280, height: 840 });

      // 6. Mid-stream Stop button + toolbar New Chat for All
      await mpPage.locator('#unified-input').fill('[SLOW_STREAM] Hold open');
      await mpPage.locator('#send-all-btn').click();

      await expect(alphaFrame.locator('#stop-stream-btn')).toBeVisible();
      await alphaFrame.locator('#stop-stream-btn').click();
      await expect.poll(() => serverState.abortedModels).toContain('alpha-reasoner');
      await expect(alphaFrame.locator('#stop-stream-btn')).toBeHidden();

      // Toolbar New Chat aborts Beta's stream too and clears turns in both panels in place
      await mpPage.locator('#new-chat-btn').click();
      await expect.poll(() => serverState.abortedModels).toContain('beta-local');
      await expect(alphaFrame.locator('#empty-state')).toBeVisible();
      await expect(betaFrame.locator('#empty-state')).toBeVisible();

      // 6.5. Edit Local Alpha in Options (keep saved IndexedDB key blank) and Local Beta (upgrade model) -> live Multi-Panel sync
      const alphaOptRow = optionsPage.locator(
        `#provider-list .provider-item[data-provider-id="${alphaId}"]`
      );
      await alphaOptRow.locator('[data-action="edit-custom-provider"]').click();
      await expect(optionsPage.locator('#custom-provider-form-title')).toHaveText('Edit custom AI');
      await expect(optionsPage.locator('#custom-provider-api-key')).toHaveValue('');
      await optionsPage.locator('#custom-provider-name').fill('Local Alpha v2');
      await optionsPage.locator('#custom-provider-model').fill('alpha-reasoner-v2');
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(optionsPage.locator('#custom-provider-form-title')).toHaveText('Add custom AI');

      const betaOptRow = optionsPage.locator(
        `#provider-list .provider-item[data-provider-id="${betaId}"]`
      );
      await betaOptRow.locator('[data-action="edit-custom-provider"]').click();
      await optionsPage.locator('#custom-provider-name').fill('Local Beta v2');
      await optionsPage.locator('#custom-provider-model').fill('beta-upgraded');
      await optionsPage.locator('#custom-provider-add-btn').click();

      // Open Multi-Panel updates headers and iframe model badges live without reload, preserving Alpha's IndexedDB key!
      await expect(panels.nth(0).locator('.panel-provider-name')).toHaveText('Local Alpha v2');
      await expect(panels.nth(1).locator('.panel-provider-name')).toHaveText('Local Beta v2');
      await expect(alphaFrame.locator('#api-model-badge')).toHaveText('alpha-reasoner-v2');
      await expect(betaFrame.locator('#api-model-badge')).toHaveText('beta-upgraded');

      await mpPage.locator('#unified-input').fill('Verify edited models');
      await mpPage.locator('#send-all-btn').click();
      await expect(alphaFrame.locator('.turn-assistant .turn-markdown strong')).toHaveText(
        'alpha-reasoner-v2'
      );
      await expect(betaFrame.locator('.turn-assistant .turn-markdown strong')).toHaveText(
        'beta-upgraded'
      );

      // 7. Deleting Local Alpha in Options retains shared permission so Local Beta keeps working
      await alphaOptRow.locator('[data-action="delete-custom-provider"]').click();
      await alphaOptRow.locator('[data-action="confirm-delete-custom-provider"]').click();
      await expect(alphaOptRow).toHaveCount(0);

      await expect(mpPage.locator('#panel-grid .panel-item')).toHaveCount(1);
      await mpPage.locator('#unified-input').fill('Still working after Alpha deleted');
      await mpPage.locator('#send-all-btn').click();
      await expect(
        mpPage
          .locator('#panel-grid .panel-item')
          .first()
          .frameLocator('iframe')
          .locator('.turn-assistant .turn-markdown strong')
          .nth(1)
      ).toHaveText('beta-upgraded');

      expect(runtimeErrors).toEqual([]);
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await webProbeServer.close();
      await apiServer.close();
    }
  });
});
