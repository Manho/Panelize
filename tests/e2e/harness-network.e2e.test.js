import { test, expect } from '@playwright/test';
import { getTabUrls, launchExtension, startFixtureServer } from './extension-harness.js';

// The suite must never depend on real sites: an unmapped host has to fail at
// once rather than load from the internet. Regression: the rating prompt test
// reached the live Chrome Web Store through a tab opened by chrome.tabs.create,
// whose first navigation slipped past context.route.
test('E2E launches cannot reach hosts the test did not map', async () => {
  const server = await startFixtureServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end('fixture');
  });
  const extension = await launchExtension({
    args: ['--host-resolver-rules=MAP mapped.test 127.0.0.1'],
  });
  try {
    const page = await extension.context.newPage();
    await page.goto(extension.extensionUrl('options/options.html'));
    const fetchText = (url) => page.evaluate(
      (target) => fetch(target).then((response) => response.text(), (error) => `failed: ${error.name}`),
      url
    );

    // `no-cors` resolves with an opaque response for any reachable host, so
    // only a failed lookup rejects.
    expect(await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' })
      .then((response) => response.type, (error) => `failed: ${error.name}`))).toBe('failed: TypeError');
    // The test's own mappings and loopback fixture servers keep working.
    expect(await fetchText(`http://mapped.test:${server.port}/`)).toBe('fixture');
    expect(await fetchText(`http://127.0.0.1:${server.port}/`)).toBe('fixture');

    const blocked = await extension.context.newPage();
    await expect(blocked.goto('https://example.com/')).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);

    // A tab the extension opens itself never reaches the site either. The live
    // store answers this URL with a redirect to a slugged listing URL, so a
    // tab that finished loading at the URL it was opened with stayed offline.
    const storeUrl = 'https://chromewebstore.google.com/detail/iokalaafkmjffolodkkgbbccmofbglii/reviews';
    const tabId = await page.evaluate(async (url) => (await chrome.tabs.create({ url, active: false })).id, storeUrl);
    await expect.poll(() => page.evaluate(async (id) => (await chrome.tabs.get(id)).status, tabId))
      .toBe('complete');
    const storeTabs = (await getTabUrls(page)).filter((url) => url.startsWith('https://chromewebstore.google.com/'));
    expect(storeTabs).toEqual([storeUrl]);
  } finally {
    await extension.close();
    await server.close();
  }
});
