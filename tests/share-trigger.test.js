import { describe, expect, it, vi } from 'vitest';
import {
  getExecuteActionShortcut,
  isMultiPanelPageUrl,
  isMultiPanelTab
} from '../modules/share-trigger.js';

const MULTI_PANEL_URL = 'chrome-extension://abc/multi-panel/multi-panel.html';

function createRuntime(contexts = []) {
  return {
    getURL: (path) => `chrome-extension://abc/${path}`,
    getContexts: vi.fn(async () => contexts)
  };
}

describe('isMultiPanelPageUrl', () => {
  it('matches the page with any query or hash', () => {
    expect(isMultiPanelPageUrl(MULTI_PANEL_URL, MULTI_PANEL_URL)).toBe(true);
    expect(isMultiPanelPageUrl(`${MULTI_PANEL_URL}?mode=popup#x`, MULTI_PANEL_URL)).toBe(true);
  });

  it('rejects other pages', () => {
    expect(isMultiPanelPageUrl('chrome-extension://abc/options/options.html', MULTI_PANEL_URL)).toBe(false);
    expect(isMultiPanelPageUrl('https://chatgpt.com/', MULTI_PANEL_URL)).toBe(false);
    expect(isMultiPanelPageUrl(undefined, MULTI_PANEL_URL)).toBe(false);
  });
});

describe('isMultiPanelTab', () => {
  it('uses the tab URL when Chrome provides it', async () => {
    const runtime = createRuntime();
    expect(await isMultiPanelTab({ id: 3, url: MULTI_PANEL_URL }, runtime)).toBe(true);
    expect(await isMultiPanelTab({ id: 3, url: 'https://example.com/' }, runtime)).toBe(false);
    expect(await isMultiPanelTab({ id: 3, pendingUrl: MULTI_PANEL_URL }, runtime)).toBe(true);
    expect(runtime.getContexts).not.toHaveBeenCalled();
  });

  it('asks for the tab contexts when the URL is hidden', async () => {
    const runtime = createRuntime([{ frameId: 0, documentUrl: MULTI_PANEL_URL }]);
    expect(await isMultiPanelTab({ id: 7 }, runtime)).toBe(true);
    expect(runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'], tabIds: [7] });
    expect(await isMultiPanelTab({ id: 7 }, createRuntime([]))).toBe(false);
  });

  it('ignores missing tabs', async () => {
    expect(await isMultiPanelTab(undefined, createRuntime())).toBe(false);
    expect(await isMultiPanelTab({ id: -1, url: MULTI_PANEL_URL }, createRuntime())).toBe(false);
  });
});

describe('getExecuteActionShortcut', () => {
  it('returns the shortcut Chrome reports for the toolbar icon', () => {
    expect(getExecuteActionShortcut([
      { name: 'open-prompt-library', shortcut: '⇧⌘P' },
      { name: '_execute_action', shortcut: '⇧⌘E' }
    ])).toBe('⇧⌘E');
  });

  it('returns an empty string when it is unbound', () => {
    expect(getExecuteActionShortcut([{ name: '_execute_action', shortcut: '' }])).toBe('');
    expect(getExecuteActionShortcut(undefined)).toBe('');
  });
});
