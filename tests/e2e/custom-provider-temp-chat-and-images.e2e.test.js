import { test, expect } from '@playwright/test';
import {
  createPatchedExtensionCopy,
  launchExtension,
  startFixtureServer,
} from './extension-harness.js';

function renderPerplexityLikeFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Perplexity Custom Fixture</title>
  </head>
  <body>
    <header style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px">
      <h1 id="fixture-title" style="margin:0;font-size:18px">Perplexity Custom Fixture</h1>
      <button
        id="incognito-toggle"
        type="button"
        style="width:32px;height:32px"
      >Spy</button>
    </header>
    <div id="submitted-turns"></div>
    <form id="composer-shell" style="margin-top:24px;padding:12px;border:1px solid #ccc">
      <div id="attachment-previews" style="display:flex;gap:8px;margin-bottom:8px"></div>
      <div data-composer="true" style="display:flex;gap:8px;align-items:center">
        <textarea
          id="composer"
          aria-label="Ask anything"
          placeholder="Ask anything..."
          style="width:360px;height:64px"
        ></textarea>
        <input
          id="file-input"
          type="file"
          multiple
          accept="image/*,.png,.jpg,.jpeg,.webp"
          style="display:none"
        />
        <button
          id="submit-btn"
          type="submit"
          aria-label="Submit"
          style="width:72px;height:36px"
        >Submit</button>
      </div>
    </form>
    <script>
      const incognitoBtn = document.getElementById('incognito-toggle');
      const fileInput = document.getElementById('file-input');
      const previews = document.getElementById('attachment-previews');
      const composer = document.getElementById('composer');
      const form = document.getElementById('composer-shell');
      const turns = document.getElementById('submitted-turns');

      function readIncognitoCookie() {
        return (
          /(?:^|;\\s*)pplx\\.is-incognito=true(?:;|$)/.test(document.cookie || '') ||
          localStorage.getItem('pplx.is-incognito') === 'true'
        );
      }

      function syncIncognitoButton() {
        const active = readIncognitoCookie();
        incognitoBtn.dataset.incognito = active ? 'true' : 'false';
        incognitoBtn.setAttribute(
          'aria-label',
          active
            ? 'Exit incognito'
            : "Use incognito: create anonymous sessions that aren't saved to your history and expire after 24 hours"
        );
      }

      syncIncognitoButton();

      incognitoBtn.addEventListener('click', () => {
        const next = !readIncognitoCookie();
        localStorage.setItem('pplx.is-incognito', next ? 'true' : 'false');
        document.cookie =
          'pplx.is-incognito=' +
          (next ? 'true' : 'false') +
          '; path=/; SameSite=None; Secure; Partitioned';
        syncIncognitoButton();
      });

      const uploadedStems = [];

      fileInput.addEventListener('change', () => {
        const files = Array.from(fileInput.files || []);
        for (const file of files) {
          const stem = file.name.replace(/\\.[^.]+$/, '');
          const chip = document.createElement('div');
          chip.className = 'attachment-chip';

          const previewBtn = document.createElement('button');
          previewBtn.type = 'button';
          previewBtn.disabled = true;
          previewBtn.setAttribute('aria-label', 'Preview ' + file.name);

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.style.width = '24px';
          removeBtn.style.height = '24px';
          removeBtn.setAttribute('aria-label', 'Remove ' + file.name);
          removeBtn.textContent = 'x';
          removeBtn.addEventListener('click', () => {
            const idx = uploadedStems.indexOf(stem);
            if (idx >= 0) uploadedStems.splice(idx, 1);
            chip.remove();
          });

          chip.append(previewBtn, removeBtn);
          previews.appendChild(chip);

          // Simulate Perplexity's async .png -> .jpg transcode while disabled, then ready
          setTimeout(() => {
            previewBtn.setAttribute('aria-label', 'Preview ' + stem + '.jpg');
            removeBtn.setAttribute('aria-label', 'Remove ' + stem + '.jpg');
          }, 80);

          setTimeout(() => {
            const img = document.createElement('img');
            img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
            img.alt = stem + '.jpg';
            img.style.width = '40px';
            img.style.height = '40px';
            previewBtn.appendChild(img);
            previewBtn.disabled = false;
            uploadedStems.push(stem);
          }, 220);
        }
      });

      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = composer.value.trim();
        if (!text && uploadedStems.length === 0) return;
        const turn = document.createElement('div');
        turn.className = 'submitted-turn';
        turn.dataset.incognito = readIncognitoCookie() ? 'true' : 'false';
        turn.dataset.attachments = uploadedStems.join(',');
        turn.textContent = text;
        turns.appendChild(turn);
        composer.value = '';
        uploadedStems.length = 0;
        previews.replaceChildren();
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

test.describe('Custom web provider Temporary Chat and Image Upload E2E', () => {
  test.setTimeout(90_000);

  test('enables/preserves/disables sticky cookie incognito mode and uploads/clears/submits multiple images on a Perplexity-like custom web panel', async () => {
    // Minimal 1x1 PNG buffer
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );

    const fixture = await startFixtureServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.end(renderPerplexityLikeFixtureHtml());
    });

    const fixtureOrigin = `http://127.0.0.1:${fixture.port}`;
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

      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: [],
          providerOrder: [],
          multiPanelProviders: [],
          multiPanelLayout: '1x1',
        });
      });

      const optionsPage = await extension.context.newPage();
      await optionsPage.goto(extension.extensionUrl('options/options.html'));
      await optionsPage.locator('#custom-provider-name').fill('Perplexity');
      await optionsPage.locator('#custom-provider-url').fill(`${fixtureOrigin}/`);
      await optionsPage.locator('#custom-provider-add-btn').click();

      const customRow = optionsPage.locator(
        '#provider-list .provider-item[data-custom-provider="true"]'
      );
      await expect(customRow).toHaveCount(1);
      const customId = await customRow.getAttribute('data-provider-id');

      await extension.serviceWorker.evaluate(async (id) => {
        await chrome.storage.sync.set({
          enabledProviders: [id],
          providerOrder: [id],
          multiPanelProviders: [id],
          multiPanelLayout: '1x1',
        });
      }, customId);

      const mpPage = await extension.context.newPage();
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));

      const iframeLocator = mpPage.locator(
        '#panel-grid .panel-item[data-custom-provider="true"] iframe'
      );
      await expect(iframeLocator).toBeVisible();

      const readIncognitoState = async () => {
        const handle = await iframeLocator.elementHandle();
        const frame = await handle?.contentFrame();
        if (!frame) return null;
        return frame
          .evaluate(() => document.getElementById('incognito-toggle')?.dataset.incognito ?? null)
          .catch(() => null);
      };

      await expect.poll(readIncognitoState, { timeout: 15_000 }).toBe('false');

      // 1. Enable Temporary Chat -> reloads custom panel and activates Incognito
      await mpPage.locator('#temporary-chat-btn').click();
      await expect(mpPage.locator('#temporary-chat-btn')).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(readIncognitoState, { timeout: 15_000 }).toBe('true');

      // 2. Click New Chat while Temporary Chat is ON -> preserves Incognito without toggling it off
      await expect(mpPage.locator('#new-chat-btn')).toBeEnabled({ timeout: 5_000 });
      await mpPage.locator('#new-chat-btn').click();
      await expect.poll(readIncognitoState, { timeout: 15_000 }).toBe('true');

      // 3. Disable Temporary Chat -> reloads custom panel and exits sticky cookie Incognito
      await expect(mpPage.locator('#temporary-chat-btn')).toBeEnabled({ timeout: 5_000 });
      await mpPage.locator('#temporary-chat-btn').click();
      await expect(mpPage.locator('#temporary-chat-btn')).toHaveAttribute('aria-pressed', 'false');
      await expect.poll(readIncognitoState, { timeout: 15_000 }).toBe('false');

      // 4. Upload 1 image + text -> Fill -> Clear All removes in-panel attachment chip & text
      await mpPage.locator('#image-file-input').setInputFiles([
        { name: 'draft-shot.png', mimeType: 'image/png', buffer: pngBuffer },
      ]);
      await mpPage.locator('#unified-input').fill('Draft prompt to clear');
      await mpPage.locator('#fill-input-btn').click();
      await expect(mpPage.locator('#image-preview-container .image-preview-item')).toHaveCount(0, {
        timeout: 15_000,
      });

      const customFrame = mpPage
        .locator('#panel-grid .panel-item[data-custom-provider="true"]')
        .frameLocator('iframe');
      await expect(customFrame.locator('.attachment-chip')).toHaveCount(1);
      await expect(customFrame.locator('#composer')).toHaveValue('Draft prompt to clear');

      await mpPage.locator('#clear-all-btn').click();
      await expect(customFrame.locator('.attachment-chip')).toHaveCount(0);
      await expect(customFrame.locator('#composer')).toHaveValue('');

      // 5. Upload 2 PNG images + prompt text -> Send All (fills & clears unified bar) -> Send All (submits)
      await mpPage.locator('#image-file-input').setInputFiles([
        { name: 'first-shot.png', mimeType: 'image/png', buffer: pngBuffer },
        { name: 'second-shot.png', mimeType: 'image/png', buffer: pngBuffer },
      ]);
      await expect(mpPage.locator('#image-preview-container .image-preview-item')).toHaveCount(2);

      await mpPage.locator('#unified-input').fill('Analyze both screenshots');
      await mpPage.locator('#send-all-btn').click();

      // Wait for fill completion: unified input & image previews clear automatically
      await expect(mpPage.locator('#image-preview-container .image-preview-item')).toHaveCount(0, {
        timeout: 15_000,
      });
      await expect(mpPage.locator('#unified-input')).toHaveValue('');

      // Second Send All triggers submit inside the custom panel
      await expect(mpPage.locator('#send-all-btn')).toBeEnabled();
      await mpPage.locator('#send-all-btn').click();

      await expect
        .poll(
          async () => {
            const handle = await iframeLocator.elementHandle();
            const frame = await handle?.contentFrame();
            if (!frame) return null;
            return frame
              .evaluate(() => {
                const turn = document.querySelector('.submitted-turn');
                return turn
                  ? {
                      text: turn.textContent,
                      attachments: turn.dataset.attachments,
                      incognito: turn.dataset.incognito,
                    }
                  : null;
              })
              .catch(() => null);
          },
          { timeout: 15_000 }
        )
        .toEqual({
          text: 'Analyze both screenshots',
          attachments: 'first-shot,second-shot',
          incognito: 'false',
        });
    } finally {
      await extension?.close();
      await extensionCopy.cleanup();
      await fixture.close();
    }
  });
});
