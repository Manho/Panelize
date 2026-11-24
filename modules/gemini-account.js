/**
 * Shared Gemini Google account index helpers (`/u/0`, `/u/1`, ...).
 */

export const DEFAULT_GEMINI_ACCOUNT_INDEX = null;
export const GEMINI_ACCOUNT_OPTIONS = Object.freeze([null, 0, 1, 2, 3, 4]);
const MAX_GOOGLE_ACCOUNT_INDEX = 9;

/**
 * Normalize an arbitrary value to a supported Google account index or null (default session).
 * @param {number | string | null | undefined} value
 * @returns {number | null}
 */
export function normalizeGeminiAccountIndex(value) {
  if (value === null || value === undefined || value === '' || value === 'default') {
    return DEFAULT_GEMINI_ACCOUNT_INDEX;
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value <= MAX_GOOGLE_ACCOUNT_INDEX
      ? value
      : DEFAULT_GEMINI_ACCOUNT_INDEX;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      return DEFAULT_GEMINI_ACCOUNT_INDEX;
    }
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_GOOGLE_ACCOUNT_INDEX
      ? parsed
      : DEFAULT_GEMINI_ACCOUNT_INDEX;
  }

  return DEFAULT_GEMINI_ACCOUNT_INDEX;
}

/**
 * Extract the `/u/<n>` Google account index from an https URL, if present.
 * @param {string | null | undefined} rawUrl
 * @returns {number | null}
 */
export function extractGoogleAccountIndexFromUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    const match = /^\/u\/(\d+)(?:\/|$)/.exec(parsed.pathname);
    return match ? normalizeGeminiAccountIndex(match[1]) : null;
  } catch {
    return null;
  }
}

/**
 * Strip a leading `/u/<n>` segment from a URL pathname while keeping a leading slash.
 * @param {string | null | undefined} pathname
 * @returns {string}
 */
export function stripGoogleAccountPathPrefix(pathname) {
  if (typeof pathname !== 'string' || pathname.length === 0) {
    return '/';
  }
  const stripped = pathname.replace(/^\/u\/\d+(?=\/|$)/, '');
  return stripped || '/';
}

/**
 * Resolve the initial/reload iframe URL for Gemini given an account index.
 * @param {number | string | null | undefined} accountIndex
 * @returns {string}
 */
export function getGeminiProviderUrl(accountIndex) {
  const normalized = normalizeGeminiAccountIndex(accountIndex);
  return normalized === null
    ? 'https://gemini.google.com'
    : `https://gemini.google.com/u/${normalized}/app`;
}

/**
 * Resolve the normal (non-temporary) URL for Gemini given an account index.
 * @param {number | string | null | undefined} accountIndex
 * @returns {string}
 */
export function getGeminiTemporaryChatNormalUrl(accountIndex) {
  const normalized = normalizeGeminiAccountIndex(accountIndex);
  return normalized === null
    ? 'https://gemini.google.com/'
    : `https://gemini.google.com/u/${normalized}/app`;
}

/**
 * Resolve the top-level fallback URL for Gemini given an account index.
 * @param {number | string | null | undefined} accountIndex
 * @returns {string}
 */
export function getGeminiTopLevelFallbackUrl(accountIndex) {
  const normalized = normalizeGeminiAccountIndex(accountIndex);
  return normalized === null
    ? 'https://gemini.google.com/app'
    : `https://gemini.google.com/u/${normalized}/app`;
}

/**
 * Convert a normalized account index to its `<select>` option value string.
 * @param {number | string | null | undefined} accountIndex
 * @returns {string}
 */
export function toGeminiAccountSelectValue(accountIndex) {
  const normalized = normalizeGeminiAccountIndex(accountIndex);
  return normalized === null ? '' : String(normalized);
}

/**
 * Human-readable compact label for the Gemini account dropdown.
 * @param {number | string | null | undefined} accountIndex
 * @returns {string}
 */
export function getGeminiAccountOptionLabel(accountIndex) {
  const normalized = normalizeGeminiAccountIndex(accountIndex);
  return normalized === null ? 'Default' : `/u/${normalized}`;
}
