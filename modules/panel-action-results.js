export const PANELIZE_ACTION_RESULT = 'PANELIZE_ACTION_RESULT';
export const PANEL_ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
export const PANEL_ACTION_RESULT_TIMEOUT_MS = 8000;

const ALLOWED_FAILURE_REASONS = new Set([
  'control-not-found',
  'unsupported',
  'preview-timeout',
  'injection-error'
]);

function createFailure(panel, reason) {
  return {
    ok: false,
    panelId: panel.id,
    provider: panel.providerId,
    reason: ALLOWED_FAILURE_REASONS.has(reason) ? reason : 'injection-error'
  };
}

/**
 * Checks whether a message is the expected action result for one panel.
 *
 * @param {MessageEvent} event - Candidate window message.
 * @param {object} panel - Panel containing id, providerId, and iframe.
 * @param {string} requestId - Active action request ID.
 * @param {string} action - Expected action name.
 * @returns {boolean} Whether the message matches the pending panel action.
 */
export function isMatchingPanelActionResult(event, panel, requestId, action = 'fill') {
  const data = event?.data;
  return Boolean(
    data &&
    typeof data === 'object' &&
    data.type === PANELIZE_ACTION_RESULT &&
    data.context === PANEL_ACTION_RESULT_CONTEXT &&
    data.requestId === requestId &&
    data.provider === panel.providerId &&
    data.action === action &&
    panel.iframe?.contentWindow === event.source &&
    (data.status === 'succeeded' || data.status === 'failed')
  );
}

/**
 * Creates a cancellable waiter for one panel action result.
 *
 * @param {object} options - Waiter configuration.
 * @param {EventTarget} [options.target=window] - Message event target.
 * @param {object} options.panel - Panel containing id, providerId, and iframe.
 * @param {string} options.requestId - Active action request ID.
 * @param {string} [options.action='fill'] - Expected action name.
 * @param {number} [options.timeoutMs=8000] - Maximum wait time.
 * @returns {{promise: Promise<object>, cancel: (reason?: string) => void}} Waiter controls.
 */
export function createPanelActionResultWaiter({
  target = window,
  panel,
  requestId,
  action = 'fill',
  timeoutMs = PANEL_ACTION_RESULT_TIMEOUT_MS
}) {
  let settled = false;
  let timeoutId;
  let resolvePromise;

  const cleanup = () => {
    target.removeEventListener('message', handleMessage);
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  };

  const settle = (result) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolvePromise(result);
  };

  const handleMessage = (event) => {
    if (!isMatchingPanelActionResult(event, panel, requestId, action)) {
      return;
    }

    if (event.data.status === 'succeeded') {
      settle({
        ok: true,
        panelId: panel.id,
        provider: panel.providerId
      });
      return;
    }

    settle(createFailure(panel, event.data.reason));
  };

  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    target.addEventListener('message', handleMessage);
    timeoutId = setTimeout(() => {
      settle(createFailure(panel, 'preview-timeout'));
    }, timeoutMs);
  });

  return {
    promise,
    cancel(reason = 'injection-error') {
      settle(createFailure(panel, reason));
    }
  };
}

/**
 * Returns only panels that still need an image fill attempt.
 *
 * @param {Array<object>} panels - Current panel list.
 * @param {Set<string>} failedPanelIds - Failed panel IDs from the previous fill.
 * @returns {Array<object>} Panels targeted by the next fill.
 */
export function getFillTargetPanels(panels, failedPanelIds) {
  if (!failedPanelIds || failedPanelIds.size === 0) {
    return panels;
  }
  return panels.filter(panel => failedPanelIds.has(panel.id));
}

/**
 * Summarizes the current overall fill state after targeted panel results.
 *
 * @param {Array<object>} panels - Current panel list.
 * @param {Array<object>} results - Results from panels targeted in this attempt.
 * @param {Set<string>} previousFailedPanelIds - Failures before this attempt.
 * @returns {{successfulCount: number, failedCount: number, failedPanelIds: Set<string>, allSucceeded: boolean}}
 * Overall fill state.
 */
export function summarizeFillResults(panels, results, previousFailedPanelIds = new Set()) {
  const currentPanelIds = new Set(panels.map(panel => panel.id));
  const failedPanelIds = new Set(
    [...previousFailedPanelIds].filter(panelId => currentPanelIds.has(panelId))
  );

  results.forEach(result => {
    if (!result?.panelId || !currentPanelIds.has(result.panelId)) {
      return;
    }
    if (result.ok) {
      failedPanelIds.delete(result.panelId);
    } else {
      failedPanelIds.add(result.panelId);
    }
  });

  const failedCount = failedPanelIds.size;
  return {
    successfulCount: Math.max(0, panels.length - failedCount),
    failedCount,
    failedPanelIds,
    allSucceeded: panels.length > 0 && failedCount === 0
  };
}

/**
 * Returns whether unified text and attachments may be cleared after a fill.
 *
 * @param {object} summary - Fill summary from summarizeFillResults.
 * @returns {boolean} True only when every current panel succeeded.
 */
export function shouldClearFillPayload(summary) {
  return Boolean(summary?.allSucceeded);
}
