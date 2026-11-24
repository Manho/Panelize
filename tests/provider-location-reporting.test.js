import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Window } from 'happy-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTENSION_ORIGIN } from './helpers/multi-panel-messages.js';

const contentScriptSource = readFileSync(
  resolve(process.cwd(), 'content-scripts/text-injection-all-providers.js'),
  'utf8'
);

function getLocationReports(postMessageSpy) {
  return postMessageSpy.mock.calls
    .map(call => call[0])
    .filter(payload => payload?.type === 'PANELIZE_PROVIDER_LOCATION' && payload?.context === 'multi-panel-provider-status');
}

describe('provider location reporting content script', () => {
  let testWindow;

  beforeEach(() => {
    testWindow = new Window({ url: 'https://chatgpt.com/c/initial' });
    // The content script reads its extension origin from chrome.runtime.
    testWindow.chrome = globalThis.chrome;
    Object.defineProperty(testWindow, 'parent', {
      configurable: true,
      value: { postMessage: vi.fn() },
    });
    testWindow.eval(contentScriptSource);
  });

  it('reports location on load', () => {
    const reports = getLocationReports(testWindow.parent.postMessage);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/initial',
    });
  });

  it('posts reports only to the extension origin', () => {
    const targetOrigins = testWindow.parent.postMessage.mock.calls.map(call => call[1]);

    expect(targetOrigins.length).toBeGreaterThan(0);
    expect(new Set(targetOrigins)).toEqual(new Set([EXTENSION_ORIGIN]));
  });

  it('reports location after pushState', async () => {
    testWindow.history.pushState({}, '', '/c/pushed');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(getLocationReports(testWindow.parent.postMessage)).toContainEqual(expect.objectContaining({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/pushed',
    }));
  });

  it('reports location after replaceState', async () => {
    testWindow.history.replaceState({}, '', '/c/replaced');
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(getLocationReports(testWindow.parent.postMessage)).toContainEqual(expect.objectContaining({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/replaced',
    }));
  });

  it('reports location after hashchange', async () => {
    testWindow.location.hash = 'thread';
    testWindow.dispatchEvent(new testWindow.HashChangeEvent('hashchange'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(getLocationReports(testWindow.parent.postMessage)).toContainEqual(expect.objectContaining({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/initial#thread',
    }));
  });

  it('reports location after popstate', async () => {
    testWindow.happyDOM.setURL('https://chatgpt.com/c/popstate-target');
    testWindow.parent.postMessage.mockClear();

    testWindow.dispatchEvent(new testWindow.PopStateEvent('popstate'));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(getLocationReports(testWindow.parent.postMessage)).toContainEqual(expect.objectContaining({
      provider: 'chatgpt',
      url: 'https://chatgpt.com/c/popstate-target',
    }));
  });
});

describe('postToMultiPanelHost frame-origin guard', () => {
  function runInFrame({ url = 'https://gemini.google.com/u/1/app', topLevel = false, nested = false, ancestorOrigins, parentLocationOrigin } = {}) {
    const frame = new Window({ url });
    frame.chrome = globalThis.chrome;
    const postMessageSpy = vi.fn();

    if (topLevel) {
      // Standalone top-level browser tab: window.parent === window && window.top === window
      frame.postMessage = postMessageSpy;
      if (ancestorOrigins !== undefined) {
        Object.defineProperty(frame.location, 'ancestorOrigins', {
          configurable: true,
          value: ancestorOrigins,
        });
      }
    } else {
      const parentWin = { postMessage: postMessageSpy };
      if (parentLocationOrigin !== undefined) {
        parentWin.location = { origin: parentLocationOrigin };
      }
      const topWin = nested ? { postMessage: vi.fn() } : parentWin;
      Object.defineProperty(frame, 'parent', { configurable: true, value: parentWin });
      Object.defineProperty(frame, 'top', { configurable: true, value: topWin });
      if (ancestorOrigins !== undefined) {
        Object.defineProperty(frame.location, 'ancestorOrigins', {
          configurable: true,
          value: ancestorOrigins,
        });
      }
    }

    frame.eval(contentScriptSource);
    return { frame, postMessageSpy };
  }

  it('skips postMessage in a standalone top-level provider tab', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      topLevel: true,
      ancestorOrigins: [],
    });

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('skips postMessage when framed inside a standalone provider tab (non-extension ancestorOrigins)', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      ancestorOrigins: ['https://gemini.google.com'],
    });

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('skips postMessage in a nested grandchild iframe inside Multi-Panel', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      nested: true,
      ancestorOrigins: ['https://gemini.google.com', EXTENSION_ORIGIN],
    });

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('skips postMessage when framed by a different extension origin', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      ancestorOrigins: ['chrome-extension://different-extension-id'],
    });

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('skips postMessage when ancestorOrigins is unavailable and parent is same-origin web page', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      parentLocationOrigin: 'https://gemini.google.com',
    });

    expect(postMessageSpy).not.toHaveBeenCalled();
  });

  it('posts to EXTENSION_ORIGIN when directly embedded by the Multi-Panel host', () => {
    const { postMessageSpy } = runInFrame({
      url: 'https://gemini.google.com/u/1/app',
      ancestorOrigins: [EXTENSION_ORIGIN],
    });

    const reports = getLocationReports(postMessageSpy);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      provider: 'gemini',
      url: 'https://gemini.google.com/u/1/app',
    });
    expect(postMessageSpy.mock.calls.every(call => call[1] === EXTENSION_ORIGIN)).toBe(true);
  });
});
