// Store rating prompt: counts successful "Send All" actions locally and decides
// when the comparison page should ask the user to rate Panelize. Nothing leaves
// the device; the state lives in chrome.storage.local.

export const RATING_PROMPT_STORAGE_KEY = 'ratingPrompt';

/** Successful sends before the banner first appears. */
export const RATING_PROMPT_FIRST_THRESHOLD = 20;

/** Further successful sends before the banner returns after "Later". */
export const RATING_PROMPT_LATER_INTERVAL = 50;

export const RATING_PROMPT_REVIEW_URL =
  'https://chromewebstore.google.com/detail/panelize/iokalaafkmjffolodkkgbbccmofbglii/reviews';

export const RATING_PROMPT_ACTIONS = Object.freeze({
  RATE: 'rate',
  LATER: 'later',
  NEVER: 'never'
});

/**
 * @typedef {object} RatingPromptState
 * @property {number} sendCount - Successful "Send All" actions so far.
 * @property {number} nextPromptAt - sendCount at which the banner shows.
 * @property {boolean} dismissed - True once the user rated or opted out.
 */

/** @returns {RatingPromptState} */
export function createInitialRatingPromptState() {
  return {
    sendCount: 0,
    nextPromptAt: RATING_PROMPT_FIRST_THRESHOLD,
    dismissed: false
  };
}

function toCount(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/**
 * Repairs a stored value so missing or corrupt fields fall back to defaults.
 * @param {unknown} value
 * @returns {RatingPromptState}
 */
export function normalizeRatingPromptState(value) {
  const initial = createInitialRatingPromptState();
  if (!value || typeof value !== 'object') {
    return initial;
  }
  return {
    sendCount: toCount(value.sendCount, initial.sendCount),
    nextPromptAt: toCount(value.nextPromptAt, initial.nextPromptAt),
    dismissed: value.dismissed === true
  };
}

/**
 * @param {RatingPromptState} state
 * @returns {RatingPromptState}
 */
export function recordSuccessfulSend(state) {
  const current = normalizeRatingPromptState(state);
  return { ...current, sendCount: current.sendCount + 1 };
}

/**
 * @param {RatingPromptState} state
 * @returns {boolean}
 */
export function shouldShowRatingPrompt(state) {
  const current = normalizeRatingPromptState(state);
  return !current.dismissed && current.sendCount >= current.nextPromptAt;
}

/**
 * Applies a banner button. "Rate" and "Don't ask again" stop the prompt for
 * good; "Later" pushes it back by RATING_PROMPT_LATER_INTERVAL sends.
 * @param {RatingPromptState} state
 * @param {string} action - One of RATING_PROMPT_ACTIONS.
 * @returns {RatingPromptState}
 */
export function applyRatingPromptAction(state, action) {
  const current = normalizeRatingPromptState(state);
  switch (action) {
    case RATING_PROMPT_ACTIONS.RATE:
    case RATING_PROMPT_ACTIONS.NEVER:
      return { ...current, dismissed: true };
    case RATING_PROMPT_ACTIONS.LATER:
      return { ...current, nextPromptAt: current.sendCount + RATING_PROMPT_LATER_INTERVAL };
    default:
      throw new Error(`Unknown rating prompt action: ${action}`);
  }
}

/**
 * @param {chrome.storage.StorageArea} [storage]
 * @returns {Promise<RatingPromptState>}
 */
export async function loadRatingPromptState(storage = chrome.storage.local) {
  const result = await storage.get(RATING_PROMPT_STORAGE_KEY);
  return normalizeRatingPromptState(result?.[RATING_PROMPT_STORAGE_KEY]);
}

async function updateRatingPromptState(storage, update) {
  const next = update(await loadRatingPromptState(storage));
  await storage.set({ [RATING_PROMPT_STORAGE_KEY]: next });
  return next;
}

/**
 * Counts one successful "Send All" and returns the new state.
 * @param {chrome.storage.StorageArea} [storage]
 * @returns {Promise<RatingPromptState>}
 */
export function countSuccessfulSend(storage = chrome.storage.local) {
  return updateRatingPromptState(storage, recordSuccessfulSend);
}

/**
 * Stores the user's answer to the banner and returns the new state.
 * @param {string} action - One of RATING_PROMPT_ACTIONS.
 * @param {chrome.storage.StorageArea} [storage]
 * @returns {Promise<RatingPromptState>}
 */
export function saveRatingPromptAction(action, storage = chrome.storage.local) {
  return updateRatingPromptState(storage, (state) => applyRatingPromptAction(state, action));
}
