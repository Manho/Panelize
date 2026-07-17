// T073: Version Check Module
// Checks for updates by comparing manifest version with GitHub

import { t } from './i18n.js';
import { compareVersions } from './version-utils.js';

const GITHUB_LATEST_RELEASE_URL = 'https://api.github.com/repos/Manho/Panelize/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/Manho/Panelize/releases/latest';

/**
 * @typedef {Object} LatestReleaseInfo
 * @property {string} version
 * @property {string} releaseUrl
 * @property {string} downloadUrl
 */

/**
 * @typedef {Object} UpdateCheckResult
 * @property {boolean} updateAvailable
 * @property {string|null} currentVersion
 * @property {string|null} latestVersion
 * @property {string} releaseUrl
 * @property {string} downloadUrl
 * @property {string|null} error
 */

/**
 * Load local manifest version
 * @returns {Promise<Object>} {version, manifest}
 */
export async function loadVersionInfo() {
  try {
    const manifest = chrome.runtime.getManifest();
    return {
      version: manifest.version,
      manifest: manifest
    };
  } catch (error) {
    console.error('Error loading manifest:', error);
    return null;
  }
}

/**
 * Fetch the latest published release from GitHub.
 *
 * @returns {Promise<LatestReleaseInfo|null>} Latest release or null on error.
 */
export async function fetchLatestRelease() {
  try {
    const response = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub fetch error: ${response.status}`);
    }

    const release = await response.json();
    const versionMatch = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? '');

    if (!versionMatch || typeof release.html_url !== 'string') {
      throw new Error('GitHub release metadata is invalid');
    }

    const version = versionMatch[1];
    const expectedAssetName = `panelize-${version}-release.zip`;
    const releaseAsset = Array.isArray(release.assets)
      ? release.assets.find(asset => asset?.name === expectedAssetName)
      : null;

    return {
      version,
      releaseUrl: release.html_url,
      downloadUrl: releaseAsset?.browser_download_url || release.html_url
    };
  } catch (error) {
    console.error('Error fetching latest GitHub release:', error);
    return null;
  }
}

/**
 * Check if an update is available
 * @returns {Promise<UpdateCheckResult>} Update status.
 */
export async function checkForUpdates() {
  const localInfo = await loadVersionInfo();
  if (!localInfo) {
    return {
      updateAvailable: false,
      currentVersion: null,
      latestVersion: null,
      releaseUrl: GITHUB_RELEASES_URL,
      downloadUrl: GITHUB_RELEASES_URL,
      error: t('errVersionInfoFailed')
    };
  }

  const latestRelease = await fetchLatestRelease();
  if (!latestRelease) {
    return {
      updateAvailable: false,
      currentVersion: localInfo.version,
      latestVersion: null,
      releaseUrl: GITHUB_RELEASES_URL,
      downloadUrl: GITHUB_RELEASES_URL,
      error: t('msgCheckUpdatesFailed')
    };
  }

  const comparison = compareVersions(localInfo.version, latestRelease.version);
  const updateAvailable = comparison < 0;

  return {
    updateAvailable,
    currentVersion: localInfo.version,
    latestVersion: latestRelease.version,
    releaseUrl: latestRelease.releaseUrl,
    downloadUrl: latestRelease.downloadUrl,
    error: null
  };
}

/**
 * Get the latest releases page URL.
 *
 * @returns {string} GitHub releases URL.
 */
export function getReleasesUrl() {
  return GITHUB_RELEASES_URL;
}
