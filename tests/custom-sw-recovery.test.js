import { Window } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_FRAME_PING_MESSAGE,
  CUSTOM_FRAME_PONG_MESSAGE,
  CUSTOM_SW_RECOVERED_MESSAGE,
  CUSTOM_SW_RECOVERY_PARAM,
  createCustomSwRecoveryController,
} from '../modules/custom-sw-recovery.js';

function wait(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

describe('modules/custom-sw-recovery.js', () => {
  let win;
  let doc;
  let sessionRulesState;
  let dnr;

  beforeEach(() => {
    win = new Window({ url: 'chrome-extension://ext123/multi-panel/multi-panel.html' });
    doc = win.document;
    doc.body.innerHTML = '<div id="panel-grid"></div>';
    sessionRulesState = [];
    dnr = {
      updateSessionRules: vi.fn(async ({ removeRuleIds = [], addRules = [] }) => {
        const removeSet = new Set(removeRuleIds);
        sessionRulesState = [
          ...sessionRulesState.filter((rule) => !removeSet.has(rule.id)),
          ...structuredClone(addRules),
        ];
      }),
    };
  });

  afterEach(async () => {
    await win.happyDOM.close();
    vi.restoreAllMocks();
  });

  it('pings custom web frames on load and does NOT trigger recovery when PONG arrives from the panel iframe', async () => {
    const reloadPanel = vi.fn();
    const syncAccess = vi.fn().mockResolvedValue();
    const onLoadSettled = vi.fn();
    const frameWindow = { postMessage: vi.fn() };
    const panel = {
      id: 'panel-1',
      providerId: 'custom-0123456789',
      iframe: { contentWindow: frameWindow },
    };

    const controller = createCustomSwRecoveryController({
      hostWindow: win,
      hostDocument: doc,
      extensionId: 'ext123',
      dnr,
      getPanels: () => [panel],
      isCustomWebProvider: (id) => id === 'custom-0123456789',
      getProviderOrigin: () => 'https://www.perplexity.ai',
      syncAccess,
      reloadPanel,
      pingTimeoutMs: 40,
      probeTimeoutMs: 200,
    });

    frameWindow.postMessage.mockImplementation((payload, targetOrigin) => {
      expect(targetOrigin).toBe('https://www.perplexity.ai');
      expect(payload.type).toBe(CUSTOM_FRAME_PING_MESSAGE);
      win.dispatchEvent(
        new win.MessageEvent('message', {
          data: {
            type: CUSTOM_FRAME_PONG_MESSAGE,
            provider: 'custom-0123456789',
            requestId: payload.requestId,
            context: 'multi-panel-provider-status',
          },
          origin: 'https://www.perplexity.ai',
          source: frameWindow,
        })
      );
    });

    controller.notifyNavigationStart(panel, 'https://www.perplexity.ai/');
    await controller.handleFrameLoad(panel, { onSettled: onLoadSettled });

    expect(onLoadSettled).toHaveBeenCalledTimes(1);
    expect(dnr.updateSessionRules).not.toHaveBeenCalled();
    expect(reloadPanel).not.toHaveBeenCalled();
    expect(doc.querySelectorAll('iframe[data-panelize-sw-probe="true"]').length).toBe(0);
    controller.dispose();
  });

  it('ignores spoofed PONG messages from wrong origin or wrong source and runs 1-shot hidden SW recovery probe', async () => {
    const reloadPanel = vi.fn();
    const syncAccess = vi.fn().mockResolvedValue();
    const onLoadSettled = vi.fn();
    const frameWindow = { postMessage: vi.fn() };
    const panel = {
      id: 'panel-1',
      providerId: 'custom-0123456789',
      iframe: { contentWindow: frameWindow },
    };

    const controller = createCustomSwRecoveryController({
      hostWindow: win,
      hostDocument: doc,
      extensionId: 'ext123',
      dnr,
      getPanels: () => [panel],
      isCustomWebProvider: (id) => id === 'custom-0123456789',
      getProviderOrigin: () => 'https://www.perplexity.ai',
      syncAccess,
      reloadPanel,
      pingTimeoutMs: 30,
      probeTimeoutMs: 300,
    });

    frameWindow.postMessage.mockImplementation((payload) => {
      // Spoofed origin and spoofed source must both be ignored!
      win.dispatchEvent(
        new win.MessageEvent('message', {
          data: {
            type: CUSTOM_FRAME_PONG_MESSAGE,
            provider: 'custom-0123456789',
            requestId: payload.requestId,
            context: 'multi-panel-provider-status',
          },
          origin: 'https://evil.example',
          source: frameWindow,
        })
      );
      win.dispatchEvent(
        new win.MessageEvent('message', {
          data: {
            type: CUSTOM_FRAME_PONG_MESSAGE,
            provider: 'custom-0123456789',
            requestId: payload.requestId,
            context: 'multi-panel-provider-status',
          },
          origin: 'https://www.perplexity.ai',
          source: {},
        })
      );
    });

    // Observe hidden probe iframe insertion and respond with CUSTOM_SW_RECOVERED_MESSAGE
    const observer = new win.MutationObserver(() => {
      const probe = doc.querySelector('iframe[data-panelize-sw-probe="true"]');
      if (!probe || probe.dataset.responded === 'true') {
        return;
      }
      probe.dataset.responded = 'true';
      expect(probe.closest('#panel-grid')).toBeNull();
      const probeUrl = new URL(probe.getAttribute('src'));
      expect(probeUrl.origin).toBe('https://www.perplexity.ai');
      expect(probeUrl.pathname).toBe('/robots.txt');
      expect(probeUrl.searchParams.get('q')).toBe('1');
      const nonce = probeUrl.searchParams.get(CUSTOM_SW_RECOVERY_PARAM);
      expect(nonce).toBeTruthy();

      // Verify scoped session DNR rule is active during probe
      expect(sessionRulesState).toHaveLength(1);
      expect(sessionRulesState[0].condition.topDomains).toEqual(['ext123']);
      expect(sessionRulesState[0].condition.resourceTypes).toEqual(['sub_frame']);

      setTimeout(() => {
        win.dispatchEvent(
          new win.MessageEvent('message', {
            data: {
              type: CUSTOM_SW_RECOVERED_MESSAGE,
              nonce,
              origin: 'https://www.perplexity.ai',
              context: 'multi-panel-provider-status',
            },
            origin: 'https://www.perplexity.ai',
            source: probe.contentWindow,
          })
        );
      }, 10);
    });
    observer.observe(doc.body, { childList: true });

    controller.notifyNavigationStart(panel, 'https://www.perplexity.ai/');
    await controller.handleFrameLoad(panel, { onSettled: onLoadSettled });

    expect(syncAccess).toHaveBeenCalledTimes(1);
    expect(reloadPanel).toHaveBeenCalledTimes(1);
    expect(reloadPanel).toHaveBeenCalledWith(panel, 'https://www.perplexity.ai/', {
      isRecoveryReload: true,
    });
    // Probe iframe and session DNR rule are both cleaned up after recovery
    expect(doc.querySelectorAll('iframe[data-panelize-sw-probe="true"]').length).toBe(0);
    expect(sessionRulesState).toEqual([]);

    // Simulate the post-recovery reload ALSO failing (e.g. server genuinely offline):
    // must NOT trigger a second recovery loop!
    frameWindow.postMessage.mockImplementation(() => {});
    controller.notifyNavigationStart(panel, 'https://www.perplexity.ai/', {
      isRecoveryReload: true,
    });
    await controller.handleFrameLoad(panel, { onSettled: onLoadSettled });
    await wait(20);

    expect(reloadPanel).toHaveBeenCalledTimes(1);
    expect(onLoadSettled).toHaveBeenCalled();

    observer.disconnect();
    controller.dispose();
  });
});
