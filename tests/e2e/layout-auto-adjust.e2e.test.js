import { test, expect } from '@playwright/test';
import { createPatchedExtensionCopy, launchExtension, openMultiPanel } from './extension-harness.js';
import { PROVIDERS } from '../../modules/providers.js';

// Every provider, so the add panel menu can fill all MAX_PANELS (12) slots.
const ALL_PROVIDERS = PROVIDERS.map((provider) => provider.id);

/**
 * Layout auto-adjust through the real multi-panel UI. The rules themselves
 * are unit tested in tests/layout-auto-adjust.test.js; this covers wiring:
 * the add/remove controls, the grid class and the persisted layout.
 */
test.describe('Layout auto-adjust E2E', () => {
  let extensionCopy;
  let extension;
  let page;

  test.beforeAll(async () => {
    // Optional providers only appear once their host permission is granted,
    // which needs a user gesture; grant them up front in a patched copy.
    extensionCopy = await createPatchedExtensionCopy((manifest) => {
      manifest.host_permissions.push(...manifest.optional_host_permissions);
    });
    extension = await launchExtension({
      extensionPath: extensionCopy.extensionPath,
      viewport: { width: 1920, height: 1080 },
    });
    // Provider sites are irrelevant here; serve blank pages instead of the network.
    await extension.context.route((url) => url.protocol === 'https:', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>provider</title>',
    }));
  });

  test.afterEach(async () => {
    await page?.close();
    page = null;
  });

  test.afterAll(async () => {
    await extension?.close();
    await extensionCopy?.cleanup();
  });

  // multi-panel opens min(enabled providers, layout capacity) panels.
  async function openLayout(layout, capacity) {
    page = await openMultiPanel(extension, {
      providers: ALL_PROVIDERS.slice(0, capacity),
      layout,
      enabledProviders: ALL_PROVIDERS,
    });
  }

  async function addPanel() {
    const panelCount = await page.locator('#panel-grid iframe').count();
    await page.click('#add-panel-btn');
    await page.locator('.add-panel-item').first().click();
    await expect(page.locator('#panel-grid iframe')).toHaveCount(panelCount + 1);
  }

  async function removeLastPanel() {
    const panelCount = await page.locator('#panel-grid iframe').count();
    await page.locator('.panel-selector .remove-panel').last().evaluate((button) => button.click());
    await expect(page.locator('#panel-grid iframe')).toHaveCount(panelCount - 1);
  }

  async function storedLayout() {
    return extension.serviceWorker.evaluate(async () => (
      (await chrome.storage.sync.get('multiPanelLayout')).multiPanelLayout
    ));
  }

  const panelGrid = () => page.locator('#panel-grid');

  test('keeps the layout while the new panel still fits', async () => {
    await openLayout('2x3', 6);
    await removeLastPanel();
    await expect(panelGrid()).toHaveClass('layout-2x3');

    await addPanel();

    await expect(panelGrid()).toHaveClass('layout-2x3');
  });

  test('expands 1xN layouts and persists the new layout', async () => {
    await openLayout('1x2', 2);

    await addPanel();

    await expect(panelGrid()).toHaveClass('layout-1x3');
    await expect.poll(storedLayout).toBe('1x3');
  });

  test('walks 1x2 through 4x2 and 1x9 up to 1x12, then stops at 12 panels', async () => {
    test.setTimeout(60000);
    await openLayout('1x2', 2);

    const expected = ['1x3', '1x4', '1x5', '1x6', '1x7', '4x2', '1x9', '1x10', '1x11', '1x12'];
    for (const layout of expected) {
      await test.step(`add a panel and expect ${layout}`, async () => {
        await addPanel();
        await expect(panelGrid()).toHaveClass(`layout-${layout}`);
      });
    }
    await expect.poll(storedLayout).toBe('1x12');

    await page.click('#add-panel-btn');
    await expect(page.getByText('Maximum number of panels reached (12)')).toBeVisible();
    await expect(page.locator('.add-panel-item')).toHaveCount(0);
    await expect(page.locator('#panel-grid iframe')).toHaveCount(12);
    await expect(panelGrid()).toHaveClass('layout-1x12');
  });

  test('does not auto-expand manually chosen grid layouts', async () => {
    await openLayout('2x2', 4);

    await addPanel();

    await expect(panelGrid()).toHaveClass('layout-2x2');
  });

  test('shrinks back when panels are removed', async () => {
    await openLayout('4x2', 8);

    await removeLastPanel();
    await expect(panelGrid()).toHaveClass('layout-1x7');

    await removeLastPanel();
    await expect(panelGrid()).toHaveClass('layout-1x6');
    await expect.poll(storedLayout).toBe('1x6');
  });
});
