import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkForUpdates,
  fetchLatestRelease,
  getReleasesUrl
} from '../modules/version-checker.js';

const RELEASE_URL = 'https://github.com/Manho/Panelize/releases/tag/v1.2.6';
const DOWNLOAD_URL = 'https://github.com/Manho/Panelize/releases/download/v1.2.6/panelize-1.2.6-release.zip';

function createRelease(overrides = {}) {
  return {
    tag_name: 'v1.2.6',
    html_url: RELEASE_URL,
    assets: [
      {
        name: 'panelize-1.2.6-release.zip',
        browser_download_url: DOWNLOAD_URL
      }
    ],
    ...overrides
  };
}

function mockReleaseResponse(release = createRelease()) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue(release)
  });
}

describe('version checker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    chrome.runtime.getManifest = vi.fn(() => ({ version: '1.2.5' }));
  });

  it('returns the latest release asset when an update is available', async () => {
    mockReleaseResponse();

    await expect(checkForUpdates()).resolves.toEqual({
      updateAvailable: true,
      currentVersion: '1.2.5',
      latestVersion: '1.2.6',
      releaseUrl: RELEASE_URL,
      downloadUrl: DOWNLOAD_URL,
      error: null
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/Manho/Panelize/releases/latest',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/vnd.github+json' })
      })
    );
  });

  it.each([
    ['1.2.6', false],
    ['1.2.7', false]
  ])('does not offer an update to local version %s', async (localVersion, updateAvailable) => {
    chrome.runtime.getManifest = vi.fn(() => ({ version: localVersion }));
    mockReleaseResponse();

    const result = await checkForUpdates();

    expect(result.updateAvailable).toBe(updateAvailable);
    expect(result.latestVersion).toBe('1.2.6');
  });

  it('falls back to the release page when the expected asset is missing', async () => {
    mockReleaseResponse(createRelease({ assets: [] }));

    await expect(fetchLatestRelease()).resolves.toEqual({
      version: '1.2.6',
      releaseUrl: RELEASE_URL,
      downloadUrl: RELEASE_URL
    });
  });

  it('rejects an invalid release tag', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockReleaseResponse(createRelease({ tag_name: 'latest' }));

    await expect(fetchLatestRelease()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('returns an error when GitHub responds unsuccessfully', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await checkForUpdates();

    expect(result).toMatchObject({
      updateAvailable: false,
      currentVersion: '1.2.5',
      latestVersion: null,
      releaseUrl: getReleasesUrl(),
      downloadUrl: getReleasesUrl()
    });
    expect(result.error).toBeTruthy();
  });
});
