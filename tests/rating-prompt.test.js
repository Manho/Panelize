import { describe, expect, it } from 'vitest';
import {
  RATING_PROMPT_ACTIONS,
  RATING_PROMPT_FIRST_THRESHOLD,
  RATING_PROMPT_LATER_INTERVAL,
  RATING_PROMPT_REVIEW_URL,
  RATING_PROMPT_STORAGE_KEY,
  applyRatingPromptAction,
  countSuccessfulSend,
  createInitialRatingPromptState,
  loadRatingPromptState,
  normalizeRatingPromptState,
  recordSuccessfulSend,
  saveRatingPromptAction,
  shouldShowRatingPrompt
} from '../modules/rating-prompt.js';

function createMemoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    }
  };
}

function sendTimes(state, count) {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = recordSuccessfulSend(next);
  }
  return next;
}

describe('rating prompt thresholds', () => {
  it('uses the agreed thresholds and the Chrome Web Store reviews page', () => {
    expect(RATING_PROMPT_FIRST_THRESHOLD).toBe(20);
    expect(RATING_PROMPT_LATER_INTERVAL).toBe(50);
    expect(RATING_PROMPT_REVIEW_URL).toBe(
      'https://chromewebstore.google.com/detail/panelize/iokalaafkmjffolodkkgbbccmofbglii/reviews'
    );
  });

  it('stays hidden until the 20th successful send', () => {
    const before = sendTimes(createInitialRatingPromptState(), 19);
    expect(before.sendCount).toBe(19);
    expect(shouldShowRatingPrompt(before)).toBe(false);

    const at = recordSuccessfulSend(before);
    expect(at.sendCount).toBe(20);
    expect(shouldShowRatingPrompt(at)).toBe(true);
  });

  it('keeps showing after the threshold until the user answers', () => {
    const state = sendTimes(createInitialRatingPromptState(), 23);
    expect(shouldShowRatingPrompt(state)).toBe(true);
  });

  it('repairs missing or corrupt stored values', () => {
    expect(normalizeRatingPromptState(undefined)).toEqual(createInitialRatingPromptState());
    expect(normalizeRatingPromptState({ sendCount: 'x', nextPromptAt: -3, dismissed: 'yes' }))
      .toEqual(createInitialRatingPromptState());
    expect(normalizeRatingPromptState({ sendCount: 7.9 })).toEqual({
      sendCount: 7,
      nextPromptAt: RATING_PROMPT_FIRST_THRESHOLD,
      dismissed: false
    });
  });
});

describe('rating prompt dismiss paths', () => {
  const shown = sendTimes(createInitialRatingPromptState(), 20);

  it('"Rate" never shows the banner again', () => {
    const rated = applyRatingPromptAction(shown, RATING_PROMPT_ACTIONS.RATE);
    expect(rated.dismissed).toBe(true);
    expect(shouldShowRatingPrompt(sendTimes(rated, 500))).toBe(false);
  });

  it('"Don\'t ask again" never shows the banner again', () => {
    const declined = applyRatingPromptAction(shown, RATING_PROMPT_ACTIONS.NEVER);
    expect(declined.dismissed).toBe(true);
    expect(shouldShowRatingPrompt(sendTimes(declined, 500))).toBe(false);
  });

  it('"Later" shows the banner again after 50 more sends', () => {
    const later = applyRatingPromptAction(shown, RATING_PROMPT_ACTIONS.LATER);
    expect(later).toEqual({ sendCount: 20, nextPromptAt: 70, dismissed: false });
    expect(shouldShowRatingPrompt(later)).toBe(false);
    expect(shouldShowRatingPrompt(sendTimes(later, 49))).toBe(false);
    expect(shouldShowRatingPrompt(sendTimes(later, 50))).toBe(true);

    const laterAgain = applyRatingPromptAction(sendTimes(later, 55), RATING_PROMPT_ACTIONS.LATER);
    expect(laterAgain.nextPromptAt).toBe(125);
  });

  it('rejects unknown actions', () => {
    expect(() => applyRatingPromptAction(shown, 'maybe')).toThrow('Unknown rating prompt action');
  });
});

describe('rating prompt storage', () => {
  it('counts sends in chrome.storage.local under one key', async () => {
    const storage = createMemoryStorage();
    expect(await loadRatingPromptState(storage)).toEqual(createInitialRatingPromptState());

    for (let index = 0; index < RATING_PROMPT_FIRST_THRESHOLD; index += 1) {
      await countSuccessfulSend(storage);
    }

    expect(storage.data[RATING_PROMPT_STORAGE_KEY]).toEqual({
      sendCount: 20,
      nextPromptAt: 20,
      dismissed: false
    });
    expect(shouldShowRatingPrompt(await loadRatingPromptState(storage))).toBe(true);
  });

  it('persists each dismiss action', async () => {
    const storage = createMemoryStorage({
      [RATING_PROMPT_STORAGE_KEY]: { sendCount: 20, nextPromptAt: 20, dismissed: false }
    });

    await saveRatingPromptAction(RATING_PROMPT_ACTIONS.LATER, storage);
    expect(storage.data[RATING_PROMPT_STORAGE_KEY].nextPromptAt).toBe(70);

    await saveRatingPromptAction(RATING_PROMPT_ACTIONS.NEVER, storage);
    expect(storage.data[RATING_PROMPT_STORAGE_KEY].dismissed).toBe(true);
  });

  it('defaults to chrome.storage.local', async () => {
    chrome.storage.local.get.mockResolvedValueOnce({
      [RATING_PROMPT_STORAGE_KEY]: { sendCount: 4, nextPromptAt: 20, dismissed: false }
    });
    chrome.storage.local.set.mockClear();

    const state = await countSuccessfulSend();

    expect(state.sendCount).toBe(5);
    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      [RATING_PROMPT_STORAGE_KEY]: { sendCount: 5, nextPromptAt: 20, dismissed: false }
    });
  });
});
