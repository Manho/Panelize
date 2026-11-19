import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_POPUP_HEIGHT,
  DEFAULT_POPUP_WIDTH,
  HANDOFF_QUERY_PARAM,
  OpenModeSwitchUnsupportedError,
  createHandoffStorageKey,
  findTargetNormalWindow,
  getHandoffTokenFromUrl,
  isTransientTabEditError,
  retryOnTransientTabEditError,
  stripHandoffTokenFromUrl,
  switchTabOpenMode
} from '../modules/open-mode-switcher.js';

const multiPanelHtml = readFileSync(
  path.resolve(process.cwd(), 'multi-panel/multi-panel.html'),
  'utf8'
);

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
  describe('transient error retry and handoff URL helpers', () => {
    it('detects Chrome tab-strip-busy errors accurately', () => {
      expect(
        isTransientTabEditError(
          new Error('Tabs cannot be edited right now (user may be dragging a tab).')
        )
      ).toBe(true);
      expect(isTransientTabEditError('Tabs cannot be edited right now')).toBe(true);
      expect(isTransientTabEditError(new Error('No window with id: 10.'))).toBe(false);
      expect(isTransientTabEditError(null)).toBe(false);
    });

    it('retries transient tab-edit errors until the operation succeeds', async () => {
      const sleep = vi.fn(async () => {});
      let attempts = 0;
      const result = await retryOnTransientTabEditError(
        async () => {
          attempts += 1;
          if (attempts < 3) {
            throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
          }
          return 'moved';
        },
        { maxRetries: 4, retryDelayMs: 25, sleep }
      );

      expect(result).toBe('moved');
      expect(attempts).toBe(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(25);
    });

    it('does not retry non-transient errors', async () => {
      const sleep = vi.fn(async () => {});
      let attempts = 0;

      await expect(
        retryOnTransientTabEditError(
          async () => {
            attempts += 1;
            throw new Error('No window with id: 42.');
          },
          { maxRetries: 4, retryDelayMs: 25, sleep }
        )
      ).rejects.toThrow('No window with id: 42.');

      expect(attempts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('extracts and strips scoped handoff tokens from URLs', () => {
      const url = `chrome-extension://abc/multi-panel/multi-panel.html?foo=1&${HANDOFF_QUERY_PARAM}=tok-123`;
      expect(getHandoffTokenFromUrl(url)).toBe('tok-123');
      expect(stripHandoffTokenFromUrl(url)).toBe(
        'chrome-extension://abc/multi-panel/multi-panel.html?foo=1'
      );
      expect(getHandoffTokenFromUrl('chrome-extension://abc/multi-panel/multi-panel.html')).toBeNull();
      expect(stripHandoffTokenFromUrl('chrome-extension://abc/multi-panel/multi-panel.html')).toBeNull();
      expect(createHandoffStorageKey('tok-123')).toBe('preservedState:tok-123');
    });
  });

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

    it('retries transient tab-strip-busy errors when moving a tab to a popup window', async () => {
      const sleep = vi.fn(async () => {});
      const chromeApi = createChromeMock({
        currentWindow: { id: 10, type: 'normal', incognito: false },
        currentTab: { id: 101, windowId: 10 }
      });
      chromeApi.windows.create
        .mockRejectedValueOnce(new Error('Tabs cannot be edited right now (user may be dragging a tab).'))
        .mockResolvedValueOnce({ id: 25, type: 'popup', incognito: false });

      const result = await switchTabOpenMode(chromeApi, { sleep, retryDelayMs: 10 });

      expect(chromeApi.windows.create).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(result.windowId).toBe(25);
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

    it('falls back to windows.create({ tabId, type: normal }) if tabs.move rejects with a non-transient error', async () => {
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

    it('rethrows without creating an extra window when tabs.move exhausts retries on transient errors', async () => {
      const sleep = vi.fn(async () => {});
      const chromeApi = createChromeMock({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 },
        normalWindows: [
          { id: 10, type: 'normal', incognito: false, state: 'normal' }
        ]
      });
      chromeApi.tabs.move.mockRejectedValue(
        new Error('Tabs cannot be edited right now (user may be dragging a tab).')
      );

      await expect(
        switchTabOpenMode(chromeApi, {
          preferredNormalWindowId: 10,
          maxRetries: 2,
          retryDelayMs: 5,
          sleep
        })
      ).rejects.toThrow('Tabs cannot be edited right now');

      expect(chromeApi.tabs.move).toHaveBeenCalledTimes(3);
      expect(chromeApi.windows.create).not.toHaveBeenCalled();
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

    it('throws OpenModeSwitchUnsupportedError when current tab or window cannot be resolved', async () => {
      const chromeApi = createChromeMock({ currentTab: null });

      await expect(switchTabOpenMode(chromeApi)).rejects.toThrow(
        OpenModeSwitchUnsupportedError
      );
    });
  });

  describe('multi-panel open-mode integration regressions', () => {
    let cleanupListeners = [];

    function createStorageArea(initial = {}) {
      const store = { ...initial };
      return {
        store,
        area: {
          get: vi.fn(async (keys) => {
            if (typeof keys === 'string') {
              return keys in store ? { [keys]: store[keys] } : {};
            }
            if (keys && typeof keys === 'object') {
              const out = {};
              for (const [k, fallback] of Object.entries(keys)) {
                out[k] = k in store ? store[k] : fallback;
              }
              return out;
            }
            return { ...store };
          }),
          set: vi.fn(async (entries) => {
            Object.assign(store, entries);
          }),
          remove: vi.fn(async (keys) => {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) {
              delete store[key];
            }
          }),
          clear: vi.fn(async () => {
            for (const key of Object.keys(store)) {
              delete store[key];
            }
          })
        }
      };
    }

    function mountMultiPanel({
      currentWindow = { id: 10, type: 'normal', incognito: false },
      currentTab = { id: 101, windowId: 10 },
      syncInitial = {},
      sessionInitial = {},
      localInitial = {}
    } = {}) {
      const bodyMatch = multiPanelHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyHtml = (bodyMatch ? bodyMatch[1] : '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      document.body.innerHTML = bodyHtml;

      const sync = createStorageArea({
        theme: 'light',
        language: 'en',
        multiPanelLayout: '1x1',
        enabledProviders: ['chatgpt'],
        providerOrder: ['chatgpt'],
        multiPanelProviders: ['chatgpt'],
        ...syncInitial
      });
      const session = createStorageArea(sessionInitial);
      const local = createStorageArea(localInitial);
      const attachedListeners = [];

      chrome.storage = {
        sync: sync.area,
        session: session.area,
        local: local.area,
        onChanged: { addListener: vi.fn() }
      };
      chrome.i18n = {
        getMessage: vi.fn((key) => key),
        getUILanguage: vi.fn(() => 'en')
      };
      chrome.runtime.getManifest = vi.fn(() => ({ version: '2.2.3' }));
      chrome.management = {
        getSelf: vi.fn(async () => ({ installType: 'normal' }))
      };
      chrome.permissions = {
        contains: vi.fn(async () => true),
        request: vi.fn(async () => true),
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() }
      };

      let activeWindow = { ...currentWindow };
      chrome.windows = {
        getCurrent: vi.fn(async () => activeWindow),
        getAll: vi.fn(async () => (activeWindow.type === 'normal' ? [activeWindow] : [])),
        getLastFocused: vi.fn(async () => activeWindow),
        create: vi.fn(async (createData) => {
          activeWindow = {
            id: createData.type === 'popup' ? 20 : 30,
            type: createData.type,
            incognito: false
          };
          return activeWindow;
        }),
        update: vi.fn(async () => activeWindow)
      };
      chrome.tabs = {
        getCurrent: vi.fn(async () => currentTab),
        create: vi.fn(async () => ({ id: 999 })),
        move: vi.fn(async () => currentTab),
        update: vi.fn(async () => currentTab),
        remove: vi.fn(async () => {}),
        onAttached: {
          addListener: vi.fn((listener) => {
            attachedListeners.push(listener);
          })
        }
      };

      return {
        sync,
        session,
        local,
        attachedListeners,
        setCurrentWindow(nextWin) {
          activeWindow = { ...nextWin };
        }
      };
    }

    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      cleanupListeners = [];

      if (window.happyDOM?.settings?.navigation) {
        window.happyDOM.settings.navigation.disableChildFrameNavigation = true;
      }

      const origWinAdd = window.addEventListener.bind(window);
      const origWinRemove = window.removeEventListener.bind(window);
      const origDocAdd = document.addEventListener.bind(document);
      const origDocRemove = document.removeEventListener.bind(document);

      vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
        cleanupListeners.push(() => origWinRemove(type, listener, options));
        return origWinAdd(type, listener, options);
      });
      vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
        cleanupListeners.push(() => origDocRemove(type, listener, options));
        return origDocAdd(type, listener, options);
      });

      globalThis.fetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ prompts: [] })
      }));
    });

    afterEach(() => {
      for (const cleanup of cleanupListeners.splice(0)) {
        cleanup();
      }
      vi.restoreAllMocks();
      delete globalThis.fetch;
      document.body.innerHTML = '';
    });

    it('preserves the live tab and never recreates or closes it when Chrome throws a persistent transient tab-edit error', async () => {
      const env = mountMultiPanel();
      const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {});
      const mpMod = await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        expect(document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent).toBe('open_in_new');
      });

      document.getElementById('unified-input').value = 'unsent chat draft';
      chrome.windows.create.mockRejectedValue(
        new Error('Tabs cannot be edited right now (user may be dragging a tab).')
      );

      await mpMod.toggleOpenMode();

      expect(chrome.tabs.create).not.toHaveBeenCalled();
      expect(chrome.tabs.remove).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
      expect(Object.keys(env.session.store)).toEqual([]);
      expect(Object.keys(env.local.store).filter((k) => k.startsWith('preservedState'))).toEqual([]);
      expect(document.getElementById('unified-input').value).toBe('unsent chat draft');
    });

    it('scopes fallback preservedState to a unique token and cleans it up if fallback creation fails', async () => {
      const env = mountMultiPanel({ currentTab: null });
      const mpMod = await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        expect(document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent).toBe('open_in_new');
      });

      document.getElementById('unified-input').value = 'fallback draft';
      chrome.windows.create.mockRejectedValueOnce(new Error('Window creation blocked'));

      await mpMod.toggleOpenMode();

      expect(Object.keys(env.session.store)).toEqual([]);
      expect(Object.keys(env.local.store).filter((k) => k.startsWith('preservedState'))).toEqual([]);

      let createdUrl = null;
      chrome.windows.create.mockImplementationOnce(async (opts) => {
        createdUrl = opts.url;
        return { id: 55, type: 'popup' };
      });
      env.sync.area.set.mockRejectedValueOnce(new Error('Sync quota exceeded'));

      await mpMod.toggleOpenMode();

      expect(createdUrl).toContain(`${HANDOFF_QUERY_PARAM}=`);
      const token = getHandoffTokenFromUrl(createdUrl);
      expect(token).toBeTruthy();
      expect(env.session.store[createHandoffStorageKey(token)]?.inputText).toBe('fallback draft');
      expect(env.session.store.preservedState).toBeUndefined();
    });

    it('restores scoped handoff state only for the matching URL token and leaves other tokens untouched', async () => {
      const targetKey = createHandoffStorageKey('tok-target');
      const otherKey = createHandoffStorageKey('tok-other');

      const originalHref = window.location.href;
      window.history.replaceState(null, '', `/?${HANDOFF_QUERY_PARAM}=tok-target`);
      try {
        const env = mountMultiPanel({
          sessionInitial: {
            [targetKey]: {
              inputText: 'scoped target draft',
              uploadedImages: [],
              currentLayout: '1x1',
              panels: [{ providerId: 'chatgpt' }]
            },
            [otherKey]: {
              inputText: 'other tab draft',
              uploadedImages: [],
              currentLayout: '1x1',
              panels: [{ providerId: 'chatgpt' }]
            }
          }
        });

        await import('../multi-panel/multi-panel.js');

        await vi.waitFor(() => {
          expect(document.getElementById('unified-input')?.value).toBe('scoped target draft');
        });
        expect(env.session.store[targetKey]).toBeUndefined();
        expect(env.session.store[otherKey]?.inputText).toBe('other tab draft');
        expect(getHandoffTokenFromUrl(window.location.href)).toBeNull();
      } finally {
        window.history.replaceState(null, '', originalHref);
      }
    });

    it('reconciles native tabs.onAttached fired while toggleOpenMode is awaiting storage.sync.set', async () => {
      const env = mountMultiPanel({
        currentWindow: { id: 10, type: 'normal', incognito: false },
        currentTab: { id: 101, windowId: 10 }
      });
      const mpMod = await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        expect(env.attachedListeners).toHaveLength(1);
      });

      let resolveSyncSet;
      env.sync.area.set.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSyncSet = resolve;
          })
      );

      const togglePromise = mpMod.toggleOpenMode();

      await vi.waitFor(() => {
        expect(typeof resolveSyncSet).toBe('function');
      });

      // Simulate native "Show as tab" moving the tab back to normal window 10
      // while toggleOpenMode is still awaiting chrome.storage.sync.set.
      env.setCurrentWindow({ id: 10, type: 'normal', incognito: false });
      env.attachedListeners[0](101, { newWindowId: 10, newPosition: 0 });

      resolveSyncSet();
      await togglePromise;

      expect(document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent).toBe('open_in_new');
    });

    it('updates the toggle button even when chrome.storage.sync.get rejects during init', async () => {
      const env = mountMultiPanel({
        currentWindow: { id: 20, type: 'popup', incognito: false },
        currentTab: { id: 101, windowId: 20 }
      });
      env.sync.area.get.mockRejectedValue(new Error('Sync storage unavailable'));

      await import('../multi-panel/multi-panel.js');

      await vi.waitFor(() => {
        expect(document.querySelector('#toggle-open-mode-btn .material-symbols-outlined')?.textContent).toBe('tab');
      });
    });
  });
});
