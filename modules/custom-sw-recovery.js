/**
 * Automatic recovery for custom web AI panels whose Service Worker serves
 * cached HTML responses with framing-refusal headers (X-Frame-Options /
 * CSP frame-ancestors) from CacheStorage, or intercepts subframe navigations
 * via `event.respondWith(fetch(event.request))`, bypassing `sub_frame`
 * declarativeNetRequest response-header rules.
 *
 * Security invariants:
 * 1. Each recovery probe generates a fresh 128-bit CSPRNG nonce (`crypto.getRandomValues`)
 *    and anchors the temporary session DNR rule strictly to the exact one-time probe URL
 *    (`|${origin}/robots.txt?__panelize_sw_recover=${nonce}`), removing the rule immediately
 *    in `finally`. No third-party origin can know or guess the in-flight nonce.
 * 2. Across all DNR resourceTypes (covering both direct browser `sub_frame` loads and
 *    Service-Worker-internal `other`/`xmlhttprequest` passthrough `fetch()` calls where
 *    `tabId === -1`), the probe response receives
 *    `Content-Security-Policy: default-src 'none'; script-src 'none'; object-src 'none'`
 *    and runs inside `<iframe sandbox="allow-same-origin allow-scripts">`, so zero remote
 *    page scripts or subresources can execute while our ISOLATED-world content script
 *    unregisters blocking Service Workers and purges poisoned CacheStorage entries.
 * 3. Bounded to at most one recovery attempt per host-initiated panel navigation,
 *    so genuinely unreachable servers never loop.
 */

export const CUSTOM_FRAME_PING_MESSAGE = 'PANELIZE_CUSTOM_FRAME_PING';
export const CUSTOM_FRAME_PONG_MESSAGE = 'PANELIZE_CUSTOM_FRAME_PONG';
export const CUSTOM_SW_RECOVERED_MESSAGE = 'PANELIZE_CUSTOM_SW_RECOVERED';
export const CUSTOM_SW_RECOVERY_PARAM = '__panelize_sw_recover';

const MULTI_PANEL_CONTEXT = 'multi-panel';
const MULTI_PANEL_PROVIDER_STATUS_CONTEXT = 'multi-panel-provider-status';
const RECOVERY_RULE_ID_BASE = 29900;
const RECOVERY_RULE_POOL_SIZE = 40;
const DEFAULT_PING_TIMEOUT_MS = 250;
const DEFAULT_PROBE_TIMEOUT_MS = 4000;
const PROBE_POST_LOAD_SETTLE_MS = 1500;
const FALLBACK_DNR_RESOURCE_TYPES = Object.freeze([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other',
]);

let recoveryRuleCounter = 0;
let recoveryPingCounter = 0;
let recoveryNonceCounter = 0;

function allocateRecoverySessionRuleId() {
  const id = RECOVERY_RULE_ID_BASE + (recoveryRuleCounter % RECOVERY_RULE_POOL_SIZE);
  recoveryRuleCounter += 1;
  return id;
}

function nextPingRequestId() {
  recoveryPingCounter += 1;
  return `sw-ping-${Date.now()}-${recoveryPingCounter}`;
}

function nextRecoveryNonce() {
  recoveryNonceCounter += 1;
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      return `${hex}-${recoveryNonceCounter}`;
    }
  } catch {
    // Fallback for test environments without Web Crypto.
  }
  return `${Date.now()}-${recoveryNonceCounter}-${Math.random().toString(36).slice(2, 12)}`;
}

function getAllDnrResourceTypes(dnr) {
  const values =
    dnr?.ResourceType && typeof dnr.ResourceType === 'object'
      ? Object.values(dnr.ResourceType).filter((item) => typeof item === 'string' && item.length > 0)
      : [];
  return values.length > 0 ? values : [...FALLBACK_DNR_RESOURCE_TYPES];
}

export function createCustomSwRecoveryController({
  hostWindow = typeof window !== 'undefined' ? window : null,
  hostDocument = typeof document !== 'undefined' ? document : null,
  extensionId = typeof chrome !== 'undefined' ? chrome?.runtime?.id || '' : '',
  dnr = typeof chrome !== 'undefined' ? chrome?.declarativeNetRequest || null : null,
  getPanels = () => [],
  isCustomWebProvider = () => false,
  getProviderOrigin = () => null,
  syncAccess = () => Promise.resolve(),
  reloadPanel = () => {},
  pingTimeoutMs = DEFAULT_PING_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  const navStateByPanelId = new Map();
  const inFlightByOrigin = new Map();
  let navSeqCounter = 0;
  let disposed = false;

  function isPanelStillOnSeq(panelId, expectedSeq) {
    if (disposed) {
      return false;
    }
    const state = navStateByPanelId.get(panelId);
    if (!state || state.seq !== expectedSeq) {
      return false;
    }
    const livePanels = getPanels();
    return Array.isArray(livePanels) && livePanels.some((candidate) => candidate.id === panelId);
  }

  function pingPanelFrame(panel, origin) {
    const targetWindow = panel?.iframe?.contentWindow;
    if (!hostWindow || !targetWindow || !origin) {
      return Promise.resolve(false);
    }

    const requestId = nextPingRequestId();

    return new Promise((resolve) => {
      let settled = false;
      let timerId = null;

      const finish = (alive) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timerId !== null) {
          clearTimeout(timerId);
        }
        hostWindow.removeEventListener('message', onMessage);
        resolve(alive);
      };

      const onMessage = (event) => {
        if (!event || event.origin !== origin || event.source !== targetWindow) {
          return;
        }
        const data = event.data;
        if (
          !data ||
          typeof data !== 'object' ||
          data.context !== MULTI_PANEL_PROVIDER_STATUS_CONTEXT ||
          data.type !== CUSTOM_FRAME_PONG_MESSAGE ||
          data.requestId !== requestId ||
          data.provider !== panel.providerId
        ) {
          return;
        }
        finish(true);
      };

      hostWindow.addEventListener('message', onMessage);
      timerId = setTimeout(() => finish(false), pingTimeoutMs);

      try {
        targetWindow.postMessage(
          {
            type: CUSTOM_FRAME_PING_MESSAGE,
            providerId: panel.providerId,
            requestId,
            context: MULTI_PANEL_CONTEXT,
          },
          origin
        );
      } catch {
        finish(false);
      }
    });
  }

  async function runOriginRecoveryProbeOnce(origin) {
    if (!hostWindow || !hostDocument?.body || !origin || disposed) {
      return false;
    }

    const nonce = nextRecoveryNonce();
    const probeUrl = `${origin}/robots.txt?${CUSTOM_SW_RECOVERY_PARAM}=${encodeURIComponent(nonce)}`;
    const ruleId = allocateRecoverySessionRuleId();
    let ruleInstalled = false;

    if (typeof dnr?.updateSessionRules === 'function' && extensionId) {
      try {
        await dnr.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [
            {
              id: ruleId,
              priority: 100,
              action: {
                type: 'modifyHeaders',
                responseHeaders: [
                  { header: 'X-Frame-Options', operation: 'remove' },
                  {
                    header: 'Content-Security-Policy',
                    operation: 'set',
                    value: "default-src 'none'; script-src 'none'; object-src 'none'",
                  },
                ],
              },
              condition: {
                urlFilter: `|${probeUrl}`,
                resourceTypes: getAllDnrResourceTypes(dnr),
              },
            },
          ],
        });
        ruleInstalled = true;
      } catch {
        ruleInstalled = false;
      }
    }

    const probeIframe = hostDocument.createElement('iframe');
    probeIframe.dataset.panelizeSwProbe = 'true';
    probeIframe.setAttribute('aria-hidden', 'true');
    probeIframe.setAttribute('sandbox', 'allow-same-origin allow-scripts');
    probeIframe.tabIndex = -1;
    probeIframe.style.cssText =
      'width:0!important;height:0!important;border:0!important;position:fixed!important;left:-9999px!important;top:-9999px!important;visibility:hidden!important;pointer-events:none!important;';

    try {
      const recovered = await new Promise((resolve) => {
        let settled = false;
        let hardTimerId = null;
        let postLoadTimerId = null;

        const finish = (ok) => {
          if (settled) {
            return;
          }
          settled = true;
          if (hardTimerId !== null) {
            clearTimeout(hardTimerId);
          }
          if (postLoadTimerId !== null) {
            clearTimeout(postLoadTimerId);
          }
          hostWindow.removeEventListener('message', onMessage);
          resolve(ok);
        };

        const onMessage = (event) => {
          if (!event || event.origin !== origin || event.source !== probeIframe.contentWindow) {
            return;
          }
          const data = event.data;
          if (
            !data ||
            typeof data !== 'object' ||
            data.context !== MULTI_PANEL_PROVIDER_STATUS_CONTEXT ||
            data.type !== CUSTOM_SW_RECOVERED_MESSAGE ||
            data.nonce !== nonce
          ) {
            return;
          }
          finish(true);
        };

        probeIframe.addEventListener(
          'load',
          () => {
            if (!settled && postLoadTimerId === null) {
              postLoadTimerId = setTimeout(() => finish(false), PROBE_POST_LOAD_SETTLE_MS);
            }
          },
          { once: true }
        );

        hostWindow.addEventListener('message', onMessage);
        hardTimerId = setTimeout(() => finish(false), probeTimeoutMs);
        probeIframe.setAttribute('src', probeUrl);
        hostDocument.body.appendChild(probeIframe);
      });

      return recovered;
    } finally {
      probeIframe.remove();
      if (ruleInstalled && typeof dnr?.updateSessionRules === 'function') {
        await dnr.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});
      }
    }
  }

  function runOriginRecoveryProbe(origin) {
    const existing = inFlightByOrigin.get(origin);
    if (existing) {
      return existing;
    }
    const promise = runOriginRecoveryProbeOnce(origin).finally(() => {
      if (inFlightByOrigin.get(origin) === promise) {
        inFlightByOrigin.delete(origin);
      }
    });
    inFlightByOrigin.set(origin, promise);
    return promise;
  }

  function notifyNavigationStart(panel, targetUrl, { isRecoveryReload = false } = {}) {
    if (!panel?.id) {
      return;
    }
    if (!isCustomWebProvider(panel.providerId)) {
      navStateByPanelId.delete(panel.id);
      return;
    }

    const origin = getProviderOrigin(panel.providerId);
    if (!origin) {
      navStateByPanelId.delete(panel.id);
      return;
    }

    navSeqCounter += 1;
    navStateByPanelId.set(panel.id, {
      seq: navSeqCounter,
      providerId: panel.providerId,
      origin,
      targetUrl: targetUrl || '',
      initialLoadChecked: false,
      recoveryAttempted: Boolean(isRecoveryReload),
    });
  }

  function notifyPanelRemoved(panelId) {
    navStateByPanelId.delete(panelId);
  }

  async function handleFrameLoad(panel, { onSettled } = {}) {
    if (!panel?.id || !isCustomWebProvider(panel.providerId)) {
      onSettled?.();
      return;
    }

    const state = navStateByPanelId.get(panel.id);
    if (!state || state.providerId !== panel.providerId || state.initialLoadChecked) {
      onSettled?.();
      return;
    }

    state.initialLoadChecked = true;
    const currentSeq = state.seq;

    const frameAlive = await pingPanelFrame(panel, state.origin);
    if (frameAlive || !isPanelStillOnSeq(panel.id, currentSeq)) {
      onSettled?.();
      return;
    }

    if (state.recoveryAttempted) {
      onSettled?.();
      return;
    }

    state.recoveryAttempted = true;

    try {
      await syncAccess();
    } catch {
      // Ignore sync errors and continue with recovery probe
    }

    if (!isPanelStillOnSeq(panel.id, currentSeq)) {
      onSettled?.();
      return;
    }

    const recovered = await runOriginRecoveryProbe(state.origin);
    if (recovered && isPanelStillOnSeq(panel.id, currentSeq)) {
      reloadPanel(panel, state.targetUrl, { isRecoveryReload: true });
      return;
    }

    onSettled?.();
  }

  function dispose() {
    disposed = true;
    navStateByPanelId.clear();
    inFlightByOrigin.clear();
  }

  return {
    notifyNavigationStart,
    notifyPanelRemoved,
    handleFrameLoad,
    dispose,
  };
}
