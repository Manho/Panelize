import { test, expect } from '@playwright/test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createPatchedExtensionCopy, launchExtension, openMultiPanel } from './extension-harness.js';
import { renderChatgptFixture } from './fixtures/chatgpt-fixture.js';

// Smallest valid PNG (1x1, transparent).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// The extension CSP is `script-src 'self'`; Chrome reports any blocked inline
// handler through a console error.
function collectCspViolations(page) {
  const violations = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) {
      violations.push(message.text());
    }
  });
  return violations;
}

test('an attached image is removed by its remove button', async () => {
  const extension = await launchExtension({ viewport: { width: 1280, height: 800 } });
  try {
    await extension.context.route('https://chatgpt.com/**', route => route.fulfill({
      contentType: 'text/html', body: renderChatgptFixture(),
    }));
    const page = await openMultiPanel(extension, { providers: ['chatgpt'] });
    const violations = collectCspViolations(page);

    const files = (names) => names.map((name) => ({ name, mimeType: 'image/png', buffer: PNG_BYTES }));
    await page.locator('#image-file-input').setInputFiles(files(['first "quoted".png', 'second.png']));
    const items = page.locator('#image-preview-container .image-preview-item');
    await expect(items).toHaveCount(2);
    // File names are text, never markup.
    await expect(items.first().locator('img')).toHaveAttribute('alt', 'first "quoted".png');

    await items.first().locator('.remove-image').click();
    await expect(items).toHaveCount(1);
    await expect(items.locator('img')).toHaveAttribute('alt', 'second.png');

    await items.locator('.remove-image').click();
    await expect(items).toHaveCount(0);

    expect(await page.evaluate(() => typeof window.removeImageById)).toBe('undefined');
    expect(violations).toEqual([]);
  } finally {
    await extension.close();
  }
});

test('a provider icon that fails to load is hidden on the options page', async () => {
  const copy = await createPatchedExtensionCopy(() => {});
  // Break one icon so its image fails to load.
  await rm(path.join(copy.extensionPath, 'icons/providers/claude.png'));
  const extension = await launchExtension({ extensionPath: copy.extensionPath });
  try {
    const page = await extension.context.newPage();
    const violations = collectCspViolations(page);
    await page.goto(extension.extensionUrl('options/options.html'));

    const icon = (providerId) => page.locator(`.provider-item[data-provider-id="${providerId}"] .provider-icon img`);
    await expect(icon('claude')).toBeHidden();
    await expect(icon('chatgpt')).toBeVisible();
    expect(await icon('chatgpt').evaluate((image) => image.naturalWidth > 0)).toBe(true);
    expect(violations).toEqual([]);
  } finally {
    await extension.close();
    await copy.cleanup();
  }
});
