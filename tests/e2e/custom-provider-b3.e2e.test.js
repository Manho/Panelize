import { test, expect } from '@playwright/test';
import {
  createPatchedExtensionCopy,
  launchExtension,
  startFixtureServer,
} from './extension-harness.js';

function renderCustomChatFixtureHtml(titleText = 'Custom WebUI Fixture') {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${titleText}</title>
  </head>
  <body>
    <h1 id="fixture-title">${titleText}</h1>
    <div id="messages"></div>
    <form id="chat-form" style="margin-top:24px;display:flex;gap:8px;align-items:center">
      <textarea
        id="composer"
        aria-label="Prompt input"
        placeholder="Ask anything..."
        style="width:360px;height:64px"
      ></textarea>
      <button
        id="send-btn"
        type="submit"
        aria-label="Send message"
        style="width:72px;height:36px"
      >Send</button>
    </form>
    <script>
      const form = document.getElementById('chat-form');
      const composer = document.getElementById('composer');
      const messages = document.getElementById('messages');
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const prompt = composer.value.trim();
        if (!prompt) return;
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

test.describe('B3 custom web provider Options flow, origin badge, and ungranted fail-closed E2E', () => {
  test.setTimeout(90_000);

  test('Granted (simulated): adds via Options form, renders persistent origin badge across narrow container widths, broadcasts/sends, updates open Multi-Panel add menu, and deletes live', async () => {
    const primaryFixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml('Primary Custom AI'));
    });

    const secondaryFixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.end(renderCustomChatFixtureHtml('Secondary Custom AI'));
    });

    const primaryOrigin = `http://127.0.0.1:${primaryFixture.port}`;
    const secondaryOrigin = `http://127.0.0.1:${secondaryFixture.port}`;

    // SIMULATED HOST PERMISSION GRANT:
    // The test build's host_permissions includes both fixture origins so
    // chrome.permissions.request({ origins: [origin + '/*'] }) resolves true
    // without a native permission prompt (native prompt click remains Unverified).
    const extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(`${primaryOrigin}/*`, `${secondaryOrigin}/*`);
    });

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
      });
      await waitForServiceWorkerReady(extension);

      // Start with a single fast local configuration (chatgpt only) so Multi-Panel focuses on our custom entry
      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt'],
          providerOrder: ['chatgpt'],
          multiPanelProviders: ['chatgpt'],
          multiPanelLayout: '1x2',
        });
      });

      // 1. Open Options and add the custom provider through the form
      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await expect(optionsPage.locator('#custom-provider-form')).toBeVisible();

      await optionsPage
        .locator('#custom-provider-name')
        .fill('My Very Long Self-Hosted Custom WebUI AI');
      await optionsPage.locator('#custom-provider-url').fill(`${primaryOrigin}/chat`);

      // Live origin preview updates via textContent while typing
      await expect(optionsPage.locator('#custom-provider-origin-preview')).toContainText(
        primaryOrigin
      );

      await optionsPage.locator('#custom-provider-add-btn').click();

      // Entry appears in the Options provider list with its origin badge
      const customListRow = optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]');
      await expect(customListRow).toHaveCount(1);
      await expect(customListRow.locator('.provider-name')).toHaveText(
        'My Very Long Self-Hosted Custom WebUI AI'
      );
      await expect(customListRow.locator('.provider-origin-badge')).toHaveText(primaryOrigin);
      const customId = await customListRow.getAttribute('data-provider-id');
      expect(customId).toMatch(/^custom-[0-9a-f]{10}$/);

      // 2. Open Multi-Panel: custom panel renders with persistent origin badge
      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      const customPanel = mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]');
      await expect(customPanel).toHaveCount(1);
      const badgeLocator = customPanel.locator('.panel-origin-badge');
      await expect(badgeLocator).toBeVisible();
      await expect(badgeLocator).toHaveText(primaryOrigin);

      const customIframeHandle = await customPanel.locator('iframe').elementHandle();
      await expect.poll(() => readFramedTitle(customIframeHandle), { timeout: 15_000 }).toBe(
        'Primary Custom AI'
      );

      // 3. Broadcast Fill and Send work end-to-end
      const customFrame = customPanel.frameLocator('iframe');
      await expect(customFrame.locator('#composer')).toBeVisible();

      await mpPage.locator('#unified-input').fill('Hello from B3 Options flow');
      await mpPage.locator('#send-all-btn').click();
      await expect(customFrame.locator('.assistant-reply')).toHaveText(
        'Reply: Hello from B3 Options flow'
      );

      // 4. Container-query check: origin badge stays visible below 300px AND below 180px panel width
      await customPanel.evaluate((el) => {
        el.style.width = '240px';
      });
      await expect(badgeLocator).toBeVisible();
      await expect(customPanel.locator('.panel-provider-name')).toBeHidden();
      const box240 = await badgeLocator.boundingBox();
      expect(box240?.width ?? 0).toBeGreaterThan(20);

      await customPanel.evaluate((el) => {
        el.style.width = '150px';
      });
      await expect(badgeLocator).toBeVisible();
      const box150 = await badgeLocator.boundingBox();
      expect(box150?.width ?? 0).toBeGreaterThan(20);

      await customPanel.evaluate((el) => {
        el.style.width = '';
      });

      // 5. Adding a second custom provider in Options appears in the already-open Multi-Panel add-panel menu without reload
      await optionsPage.locator('#custom-provider-name').fill('Second Live Added AI');
      await optionsPage.locator('#custom-provider-url').fill(`${secondaryOrigin}/app`);
      await optionsPage.locator('#custom-provider-add-btn').click();
      await expect(
        optionsPage.locator('#provider-list .provider-item[data-custom-provider="true"]')
      ).toHaveCount(2);

      await expect
        .poll(
          async () => {
            await mpPage.evaluate(() => {
              document.querySelectorAll('.add-panel-menu').forEach((m) => m.remove());
            });
            await mpPage.locator('#add-panel-btn').click();
            await mpPage.locator('.add-panel-menu').waitFor({ state: 'visible', timeout: 3000 });
            const texts = await mpPage
              .locator('.add-panel-menu .add-panel-item[data-custom-provider="true"] .menu-origin-badge')
              .allTextContents();
            return texts;
          },
          { timeout: 10_000 }
        )
        .toContain(secondaryOrigin);

      await mpPage.evaluate(() => {
        document.querySelectorAll('.add-panel-menu').forEach((m) => m.remove());
      });

      // 6. Deleting the first custom entry via inline two-step confirm removes its panel from the open Multi-Panel page
      const firstRow = optionsPage.locator(`#provider-list .provider-item[data-provider-id="${customId}"]`);
      await firstRow.locator('[data-action="delete-custom-provider"]').click();
      await expect(firstRow.locator('.custom-provider-delete-confirm')).toBeVisible();
      await firstRow.locator('[data-action="confirm-delete-custom-provider"]').click();

      await expect(firstRow).toHaveCount(0);
      await expect(mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]')).toHaveCount(0);
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await secondaryFixture.close();
      await primaryFixture.close();
    }
  });

  test('Not granted: seeded enabled custom record for an ungranted origin is not shown and registers no frame rule or content script', async () => {
    const ungrantedFixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(renderCustomChatFixtureHtml('Ungranted Custom AI'));
    });
    const ungrantedOrigin = `http://127.0.0.1:${ungrantedFixture.port}`;
    const ungrantedId = 'custom-9999999999';
    const ungrantedRuleId = 10042;

    // Do NOT grant ungrantedOrigin in host_permissions!
    const extensionCopy = await createPatchedExtensionCopy(() => {});

    let extension;
    try {
      extension = await launchExtension({
        extensionPath: extensionCopy.extensionPath,
        viewport: { width: 1280, height: 800 },
      });
      await waitForServiceWorkerReady(extension);

      await extension.serviceWorker.evaluate(
        async ({ record, providerId }) => {
          await chrome.storage.local.set({
            customProviders: [record],
          });
          await chrome.storage.sync.set({
            enabledProviders: [providerId, 'chatgpt'],
            providerOrder: [providerId, 'chatgpt'],
            multiPanelProviders: [providerId, 'chatgpt'],
            multiPanelLayout: '1x2',
          });
        },
        {
          providerId: ungrantedId,
          record: {
            id: ungrantedId,
            name: 'Ungranted Custom AI',
            url: `${ungrantedOrigin}/chat`,
            frameRuleId: ungrantedRuleId,
            createdAt: 1700000000000,
          },
        }
      );

      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      // Only the authorized built-in panel (chatgpt) renders; the ungranted custom panel is NOT shown
      await expect(mpPage.locator('#panel-grid .panel-item')).toHaveCount(1);
      await expect(
        mpPage.locator('#panel-grid .panel-item[data-custom-provider="true"]')
      ).toHaveCount(0);
      await expect(mpPage.locator('#panel-grid .panel-item .panel-header-left span')).toHaveText(
        'ChatGPT'
      );

      // Service worker check: neither dynamic frame rule nor content script is registered for the ungranted custom provider
      extension.serviceWorker =
        extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
      const registrationState = await extension.serviceWorker.evaluate(
        async ({ ruleId, scriptId }) => {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          const scripts = await chrome.scripting.getRegisteredContentScripts();
          return {
            matchingRuleIds: rules
              .filter((rule) => rule.id === ruleId || (rule.id >= 10000 && rule.id <= 19999))
              .map((rule) => rule.id),
            matchingScriptIds: scripts
              .filter(
                (script) => script.id === scriptId || /^custom-[0-9a-f]{10}-scripts$/.test(script.id)
              )
              .map((script) => script.id),
          };
        },
        {
          ruleId: ungrantedRuleId,
          scriptId: `${ungrantedId}-scripts`,
        }
      );

      expect(registrationState).toEqual({
        matchingRuleIds: [],
        matchingScriptIds: [],
      });
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await ungrantedFixture.close();
    }
  });
});
