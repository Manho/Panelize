import { test, expect } from '@playwright/test';
import { launchExtension, startFixtureServer } from './extension-harness.js';

async function waitForServiceWorkerReady(extension) {
  await expect
    .poll(
      async () => {
        extension.serviceWorker =
          extension.context.serviceWorkers().at(-1) ?? extension.serviceWorker;
        return extension.serviceWorker
          .evaluate(() => Boolean(chrome.storage?.local && chrome.storage?.sync))
          .catch(() => false);
      },
      { timeout: 10000 }
    )
    .toBe(true);
}

test.describe('Custom AI onboarding flow from Multi-Panel menus to Settings', () => {
  test('opens Settings scrolled & highlighted from + menu when all enabled AIs are open, switches all 3 modes, quick-fills Perplexity, and reuses Options tab from ⇄ menu', async () => {
    const chatgptFixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><textarea aria-label="Prompt"></textarea></body></html>');
    });

    let extension;
    try {
      extension = await launchExtension({
        viewport: { width: 1280, height: 800 },
        args: [`--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${chatgptFixture.port}`],
      });
      await waitForServiceWorkerReady(extension);

      // Seed Multi-Panel with 1 enabled provider ('chatgpt') already open so availableProviders === 0
      await extension.serviceWorker.evaluate(async () => {
        await chrome.storage.sync.set({
          enabledProviders: ['chatgpt'],
          defaultLayout: '1x1',
        });
        await chrome.storage.local.set({
          language: 'en',
          currentLayout: '1x1',
          multiPanelProviders: ['chatgpt'],
        });
      });

      const mpPage = await extension.context.newPage();
      const pageErrors = [];
      mpPage.on('pageerror', (err) => pageErrors.push(String(err)));
      await mpPage.goto(extension.extensionUrl('multi-panel/multi-panel.html'));
      await expect(mpPage.locator('.panel-item')).toHaveCount(1);

      // 1. Click `+` (#add-panel-btn) when all enabled providers are already open
      await mpPage.locator('#add-panel-btn').click();
      const addMenu = mpPage.locator('.add-panel-menu');
      await expect(addMenu).toBeVisible();
      await expect(addMenu).toHaveAttribute('role', 'menu');
      await expect(addMenu.locator('.menu-all-providers-open')).toHaveText(
        'All enabled AIs are already open'
      );
      const addCustomAction = addMenu.locator('.menu-custom-ai-action');
      await expect(addCustomAction).toBeVisible();
      await expect(addCustomAction).toBeFocused();
      await expect(addCustomAction.locator('.menu-custom-ai-label')).toHaveText(
        'Add custom AI / More providers…'
      );
      await expect(addCustomAction.locator('.menu-custom-ai-hint')).toHaveText(
        'Perplexity, Poe, Ollama, API…'
      );

      // Escape closes the menu and restores focus to #add-panel-btn; ArrowDown re-opens it
      await mpPage.keyboard.press('Escape');
      await expect(addMenu).toHaveCount(0);
      await expect(mpPage.locator('#add-panel-btn')).toBeFocused();
      await mpPage.keyboard.press('ArrowDown');
      await expect(addMenu).toBeVisible();
      await expect(addCustomAction).toBeFocused();

      // 2. Click `Add custom AI / More providers…` -> opens Options tab at #custom-provider-card
      const [optionsPage] = await Promise.all([
        extension.context.waitForEvent('page'),
        addCustomAction.click(),
      ]);
      const optionsPageErrors = [];
      optionsPage.on('pageerror', (err) => optionsPageErrors.push(String(err)));
      await optionsPage.waitForLoadState('domcontentloaded');

      const customCard = optionsPage.locator('#custom-provider-card');
      await expect(customCard).toBeVisible();
      await expect(customCard).toHaveClass(/custom-provider-card--highlight/);
      await expect(optionsPage.locator('#custom-provider-name')).toBeFocused();
      await expect(customCard).toBeInViewport();
      await expect(optionsPage).toHaveURL(/\/options\/options\.html$/);

      // Verify guide link
      const guideLink = optionsPage.locator('#custom-provider-guide-link');
      await expect(guideLink).toHaveAttribute(
        'href',
        'https://panelize.dev/guides/add-custom-ai-and-api/'
      );

      // 3. Verify all 3 connection modes update hints, placeholders, and example chips
      const nameInput = optionsPage.locator('#custom-provider-name');
      const urlLabel = optionsPage.locator('#custom-provider-url-label');
      const urlInput = optionsPage.locator('#custom-provider-url');
      const modeHint = optionsPage.locator('#custom-provider-mode-hint');
      const chipButtons = optionsPage.locator(
        '#custom-provider-examples .custom-provider-example-chip'
      );

      // Default mode: AI Website
      await expect(nameInput).toHaveAttribute('placeholder', 'Perplexity');
      await expect(urlLabel).toHaveText('AI Website URL');
      await expect(urlInput).toHaveAttribute('placeholder', 'https://www.perplexity.ai');
      await expect(modeHint).toContainText('https://www.perplexity.ai');
      await expect(chipButtons).toHaveText([
        'Perplexity',
        'Mistral Le Chat',
        'Poe',
        'HuggingChat',
      ]);

      // Mode 2: Local / Self-hosted Web
      await optionsPage.locator('#custom-provider-kind-web-local').check();
      await expect(nameInput).toHaveAttribute('placeholder', 'Open WebUI');
      await expect(urlLabel).toHaveText('Local or Self-hosted URL');
      await expect(urlInput).toHaveAttribute(
        'placeholder',
        'http://localhost:3000 or http://127.0.0.1:8080'
      );
      await expect(modeHint).toContainText('Open WebUI');
      await expect(chipButtons).toHaveText(['Open WebUI', 'LobeChat']);

      // Mode 3: OpenAI-compatible API
      await optionsPage.locator('#custom-provider-kind-api').check();
      await expect(nameInput).toHaveAttribute('placeholder', 'Ollama / OpenRouter');
      await expect(urlLabel).toHaveText('Base URL or Chat Completions URL');
      await expect(urlInput).toHaveAttribute(
        'placeholder',
        'https://openrouter.ai/api/v1 or http://localhost:11434/v1'
      );
      await expect(modeHint).toContainText('Ollama works with no CORS setup');
      await expect(optionsPage.locator('#custom-provider-api-note')).toBeVisible();
      await expect(chipButtons).toHaveText([
        'Magpie',
        'Ollama (local)',
        'LM Studio',
        'OpenRouter',
        'DeepSeek API',
      ]);
      await chipButtons.first().click();
      await expect(nameInput).toHaveValue('Magpie');
      await expect(urlInput).toHaveValue('http://127.0.0.1:3425/v1');

      // Check mobile viewport (375x667) has no horizontal overflow on Settings page
      await optionsPage.setViewportSize({ width: 375, height: 667 });
      const mobileOverflow = await optionsPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(mobileOverflow).toBeLessThanOrEqual(1);
      await optionsPage.setViewportSize({ width: 1280, height: 800 });

      // 4. Switch back to AI Website and click the Perplexity quick-fill chip
      await optionsPage.locator('#custom-provider-kind-web').check();
      await chipButtons.filter({ hasText: 'Perplexity' }).click();
      await expect(nameInput).toHaveValue('Perplexity');
      await expect(urlInput).toHaveValue('https://www.perplexity.ai');
      await expect(optionsPage.locator('#custom-provider-origin-preview')).toContainText(
        'https://www.perplexity.ai'
      );

      // 5. Wait for initial highlight to expire while focus is off #custom-provider-name,
      // then return to Multi-Panel WITHOUT touching Options URL/history and click the
      // Custom AI footer action from `⇄` (.switch-provider-btn) -> reuses the existing Options tab,
      // re-adds custom-provider-card--highlight, focuses #custom-provider-name, and strips the hash again!
      await expect(customCard).not.toHaveClass(/custom-provider-card--highlight/);
      await expect(nameInput).not.toBeFocused();
      await mpPage.bringToFront();
      await mpPage.locator('.panel-item .switch-provider-btn').click();
      const switcherMenu = mpPage.locator('.provider-switcher-menu');
      await expect(switcherMenu).toBeVisible();
      const switcherCustomAction = switcherMenu.locator('.menu-custom-ai-action');
      await expect(switcherCustomAction).toBeVisible();
      await switcherCustomAction.click();

      const optionsPrefix = extension.extensionUrl('options/options.html');
      await expect
        .poll(async () => {
          const openOptionsPages = extension.context
            .pages()
            .filter((p) => p.url().startsWith(optionsPrefix));
          const visibility = await optionsPage.evaluate(() => document.visibilityState);
          return {
            count: openOptionsPages.length,
            url: optionsPage.url(),
            visibility,
          };
        })
        .toEqual({
          count: 1,
          url: extension.extensionUrl('options/options.html'),
          visibility: 'visible',
        });
      await expect(customCard).toHaveClass(/custom-provider-card--highlight/);
      await expect(nameInput).toBeFocused();

      expect(pageErrors).toEqual([]);
      expect(optionsPageErrors).toEqual([]);
    } finally {
      await extension?.close();
      await chatgptFixture.close();
    }
  });
});
