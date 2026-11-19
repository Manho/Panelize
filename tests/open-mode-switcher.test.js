import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
  findTargetNormalWindow,
  switchTabOpenMode
} from '../modules/open-mode-switcher.js';

function createChromeMock({
  currentWindow = { id: 10, type: 'normal', incognito: false, state: 'normal' },
  currentTab = { id: 101, windowId: 10 },
  normalWindows = [currentWindow],
  lastFocusedNormal = null
} = {}) {
  return {
    windows: {
      getCurrent: vi.fn(async () => currentWindow),
      getAll: vi.fn(async () => normalWindows),
      getLastFocused: vi.fn(async () => {
        if (lastFocusedNormal instanceof Error) {
          throw lastFocusedNormal;
        }
        return lastFocusedNormal;
      }),
      create: vi.fn(async (createData) => ({
        id: createData.type === 'popup' ? 20 : 30,
        type: createData.type,
        incognito: Boolean(currentWindow.incognito)
      })),
      update: vi.fn(async (windowId, updateInfo) => ({ id: windowId, ...updateInfo }))
    },
    tabs: {
      getCurrent: vi.fn(async () => currentTab),
      move: vi.fn(async (tabId, moveProps) => ({ id: tabId, windowId: moveProps.windowId })),
      update: vi.fn(async (tabId, updateProps) => ({ id: tabId, ...updateProps }))
    }
  };
}

describe('open-mode-switcher', () => {
  describe('findTargetNormalWindow', () => {
    it('prefers preferredWindowId when it is still open with matching incognito', async () => {
      const chromeApi = createChromeMock({
        normalWindows: [
          { id: 1, type: 'normal', incognito: false, state: 'normal' },
          { id: 2, type: 'normal', incognito: false, state: 'normal' }
        ],
        lastFocusedNormal: { id: 1, type: 'normal', incognito: false }
      });

      const win = await findTargetNormalWindow(chromeApi, {
        preferredWindowId: 2,
        incognito: false
      });

      expect(win?.id).toBe(2);
    });

    it('falls back to last-focused normal window when preferredWindowId is gone', async () => {
      const chromeApi = createChromeMock({
        normalWindows: [
          { id: 1, type: 'normal', incognito: false, state: 'normal' },
          { id: 3, type: 'normal', incognito: false, state: 'normal' }
        ],
        lastFocusedNormal: { id: 3, type: 'normal', incognito: false }
      });

      const win = await findTargetNormalWindow(chromeApi, {
        preferredWindowId: 99,
        incognito: false
      });

      expect(win?.id).toBe(3);
    });

    it('never crosses incognito boundaries', async () => {
      const chromeApi = createChromeMock({
        normalWindows: [
          { id: 1, type: 'normal', incognito: false, state: 'normal' }
        ],
        lastFocusedNormal: { id: 1, type: 'normal', incognito: false }
      });

      const win = await findTargetNormalWindow(chromeApi, {
        preferredWindowId: 1,
        incognito: true
      });

      expect(win).toBeNull();
    });

    it('prefers a non-minimized window when getLastFocused fails', async () => {
      const chromeApi = createChromeMock({
        normalWindows: [
          { id: 1, type: 'normal', incognito: false, state: 'minimized' },
          { id: 2, type: 'normal', incognito: false, state: 'normal' }
        ],
        lastFocusedNormal: new Error('No last focused window')
      });

      const win = await findTargetNormalWindow(chromeApi, { incognito: false });

      expect(win?.id).toBe(2);
    });
  });

  describe('switchTabOpenMode', () => {
    it('moves a normal tab into a new popup window using tabId without recreating the tab', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 10, type: 'normal', incognito: false },
        currentTab: { id: 101, windowId: 10 }
      });

      const result = await switchTabOpenMode(chromeApi);

      expect(chromeApi.windows.create).toHaveBeenCalledWith({
        tabId: 101,
        type: 'popup',
        width: DEFAULT_POPUP_WIDTH,
        height: DEFAULT_POPUP_HEIGHT,
        focused: true
      });
      expect(chromeApi.tabs.move).not.toHaveBeenCalled();
      expect(result).toEqual({
        mode: 'popup',
        isPopupWindow: true,
        windowId: 20,
        tabId: 101,
        previousNormalWindowId: 10
      });
    });

    it('moves a popup tab back into the preferred normal window and activates/focuses it', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: [
          { id: 10, type: 'normal', incognito: false, state: 'normal' },
          { id: 11, type: 'normal', incognito: false, state: 'normal' }
        ]
      });

      const result = await switchTabOpenMode(chromeApi, {
        preferredNormalWindowId: 10
      });

      expect(chromeApi.tabs.move).toHaveBeenCalledWith(101, {
        windowId: 10,
        index: -1
      });
      expect(chromeApi.tabs.update).toHaveBeenCalledWith(101, { active: true });
      expect(chromeApi.windows.update).toHaveBeenCalledWith(10, { focused: true });
      expect(chromeApi.windows.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        mode: 'tab',
        isPopupWindow: false,
        windowId: 10,
        tabId: 101,
        previousNormalWindowId: 10
      });
    });

    it('unminimizes a minimized target normal window when returning from popup mode', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: [
          { id: 10, type: 'normal', incognito: false, state: 'minimized' }
        ]
      });

      await switchTabOpenMode(chromeApi, { preferredNormalWindowId: 10 });

      expect(chromeApi.windows.update).toHaveBeenCalledWith(10, {
        state: 'normal',
        focused: true
      });
    });

    it('creates a new normal window adopting tabId when no compatible normal window exists', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: []
      });

      const result = await switchTabOpenMode(chromeApi, {
        preferredNormalWindowId: 10
      });

      expect(chromeApi.tabs.move).not.toHaveBeenCalled();
      expect(chromeApi.windows.create).toHaveBeenCalledWith({
        tabId: 101,
        type: 'normal',
        focused: true
      });
      expect(result).toEqual({
        mode: 'tab',
        isPopupWindow: false,
        windowId: 30,
        tabId: 101,
        previousNormalWindowId: 30
      });
    });

    it('falls back to windows.create({ tabId, type: normal }) if tabs.move rejects', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: [
          { id: 10, type: 'normal', incognito: false, state: 'normal' }
        ]
      });
      chromeApi.tabs.move.mockRejectedValueOnce(new Error('Window closed'));

      const result = await switchTabOpenMode(chromeApi, {
        preferredNormalWindowId: 10
      });

      expect(chromeApi.windows.create).toHaveBeenCalledWith({
        tabId: 101,
        type: 'normal',
        focused: true
      });
      expect(result).toEqual({
        mode: 'tab',
        isPopupWindow: false,
        windowId: 30,
        tabId: 101,
        previousNormalWindowId: 30
      });
    });

    it('does not create a duplicate normal window when tabs.move succeeds but focus update fails', async () => {
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: [
          { id: 10, type: 'normal', incognito: false, state: 'normal' }
        ]
      });
      chromeApi.windows.update.mockRejectedValueOnce(new Error('Focus rejected'));

      const result = await switchTabOpenMode(chromeApi, {
        preferredNormalWindowId: 10
      });

      expect(chromeApi.tabs.move).toHaveBeenCalledWith(101, {
        windowId: 10,
        index: -1
      });
      expect(chromeApi.windows.create).not.toHaveBeenCalled();
      expect(result.windowId).toBe(10);
    });

    it('throws when current tab or window cannot be resolved', async () => {
      const chromeApi = createChromeMock({ currentTab: null });

      await expect(switchTabOpenMode(chromeApi)).rejects.toThrow(
        'Unable to resolve current tab or window'
      );
    });
  });
});
