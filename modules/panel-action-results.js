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
 * Calculates the action result timeout based on image count.
 * Formula: 8000ms for 0-1 images, plus 6500ms for each additional image.
 *
 * @param {number} imageCount - Number of pending images for this panel attempt.
 * @returns {number} Timeout in milliseconds.
 */
export function getPanelActionResultTimeoutMs(imageCount) {
  const count = Math.max(0, Number(imageCount) || 0);
  if (count <= 1) {
    return PANEL_ACTION_RESULT_TIMEOUT_MS;
  }
  return PANEL_ACTION_RESULT_TIMEOUT_MS + (count - 1) * 6500;
}

/**
 * Normalizes succeeded image IDs from an ACK message against expected IDs.
 *
 * @param {Array<string>} [succeededImageIds] - Image IDs reported in ACK.
 * @param {Array<string>} [expectedImageIds=[]] - Image IDs expected in request payload.
 * @param {boolean} [isSuccess=true] - Whether the overall status was succeeded.
 * @returns {Array<string>} Filtered, unique, valid image IDs.
 */
export function normalizeSucceededImageIds(succeededImageIds, expectedImageIds = [], isSuccess = true) {
  const expectedSet = new Set((expectedImageIds || []).filter(id => typeof id === 'string'));
  if (!Array.isArray(succeededImageIds)) {
    return isSuccess ? Array.from(expectedSet) : [];
  }
  const result = [];
  const seen = new Set();
  for (const id of succeededImageIds) {
    if (typeof id === 'string' && expectedSet.has(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

/**
 * Calculates pending image IDs remaining to be uploaded.
 *
 * @param {Array<string>} [expectedImageIds=[]] - IDs attempted in this request.
 * @param {Array<string>} [succeededImageIds=[]] - IDs verified as succeeded.
 * @returns {Array<string>} Remaining image IDs that still need upload.
 */
export function calculatePendingImageIds(expectedImageIds = [], succeededImageIds = []) {
  const succeededSet = new Set(succeededImageIds || []);
  return (expectedImageIds || []).filter(id => !succeededSet.has(id));
}

/**
 * Cleans up stale panel IDs from retry tracking structures.
 *
 * @param {Array<object>} panels - Current active panels.
 * @param {Map<string, Array<string>>} pendingFillImageIdsByPanel - Pending image IDs by panel.
 * @param {Set<string>} failedPanelIds - Failed panel IDs.
 */
export function cleanStalePanelRetryState(panels, pendingFillImageIdsByPanel, failedPanelIds) {
  const activeIds = new Set((panels || []).map(p => p.id));
  if (failedPanelIds) {
    for (const id of Array.from(failedPanelIds)) {
      if (!activeIds.has(id)) {
        failedPanelIds.delete(id);
      }
    }
  }
  if (pendingFillImageIdsByPanel && pendingFillImageIdsByPanel instanceof Map) {
    for (const key of Array.from(pendingFillImageIdsByPanel.keys())) {
      if (!activeIds.has(key)) {
        pendingFillImageIdsByPanel.delete(key);
      }
    }
  }
}

/**
 * Creates a single-instance broadcast gate to prevent concurrent operations.
 *
 * @returns {{tryAcquire: () => boolean, release: () => void, isActive: () => boolean}}
 */
export function createBroadcastGate() {
  let active = false;
  return {
    tryAcquire() {
      if (active) return false;
      active = true;
      return true;
    },
    release() {
      active = false;
    },
    isActive() {
      return active;
    }
  };
}

/**
 * Creates a cancellable waiter for one panel action result.
 *
 * @param {object} options - Waiter configuration.
 * @param {EventTarget} [options.target=window] - Message event target.
 * @param {object} options.panel - Panel containing id, providerId, and iframe.
 * @param {string} options.requestId - Active action request ID.
 * @param {Array<string>} [options.expectedImageIds=[]] - Expected image IDs for this panel attempt.
 * @param {string} [options.action='fill'] - Expected action name.
 * @param {number} [options.timeoutMs=8000] - Maximum wait time.
 * @returns {{promise: Promise<object>, cancel: (reason?: string) => void}} Waiter controls.
 */
export function createPanelActionResultWaiter({
  target = window,
  panel,
  requestId,
  expectedImageIds = [],
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
        provider: panel.providerId,
        succeededImageIds: normalizeSucceededImageIds(event.data.succeededImageIds, expectedImageIds, true)
      });
      return;
    }

    settle({
      ...createFailure(panel, event.data.reason),
      succeededImageIds: normalizeSucceededImageIds(event.data.succeededImageIds, expectedImageIds, false)
    });
  };

  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    target.addEventListener('message', handleMessage);
    timeoutId = setTimeout(() => {
      settle({
        ...createFailure(panel, 'preview-timeout'),
        succeededImageIds: normalizeSucceededImageIds(undefined, expectedImageIds, false)
      });
    }, timeoutMs);
  });

  return {
    promise,
    cancel(reason = 'injection-error') {
      settle({
        ...createFailure(panel, reason),
        succeededImageIds: normalizeSucceededImageIds(undefined, expectedImageIds, false)
      });
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

/**
 * Normalizes Promise.allSettled panel results into an array of result objects.
 *
 * @param {Array<object>} settledResults - Promise.allSettled results.
 * @param {Array<object>} targetPanels - Array of panel objects corresponding to settledResults.
 * @returns {Array<object>} Normalized result objects.
 */
export function normalizePanelResults(settledResults, targetPanels) {
  return (settledResults || []).map((res, i) => {
    const panel = targetPanels[i];
    if (res.status === 'fulfilled') {
      return res.value;
    }
    return {
      ok: false,
      panelId: panel?.id,
      provider: panel?.providerId,
      reason: 'injection-error',
      succeededImageIds: []
    };
  });
}

/**
 * Determines action parameters for a panel broadcast operation.
 *
 * @param {object} options
 * @param {boolean} options.hasImages - Whether uploaded images are present.
 * @param {boolean} options.hasFailedPanels - Whether any panel has a pending failed fill.
 * @param {boolean} [options.autoSubmit=true] - Requested autoSubmit behavior.
 * @returns {{isFillAction: boolean, shouldAutoSubmit: boolean, messageType: string, waitForActionResult: boolean}}
 */
export function getPanelBroadcastActionParams({ hasImages = false, hasFailedPanels = false, autoSubmit = true } = {}) {
  const isFillAction = Boolean(hasImages || hasFailedPanels);
  return {
    isFillAction,
    shouldAutoSubmit: isFillAction ? false : autoSubmit,
    messageType: isFillAction ? 'INJECT_TEXT_WITH_IMAGES' : 'INJECT_TEXT',
    waitForActionResult: isFillAction
  };
}

/**
 * Returns the message type string based on fill action status.
 *
 * @param {object} options
 * @param {boolean} options.isFillAction - Whether the operation is a fill action.
 * @returns {string} Message type ('INJECT_TEXT_WITH_IMAGES' or 'INJECT_TEXT').
 */
export function determinePanelMessageType({ isFillAction = false } = {}) {
  return isFillAction ? 'INJECT_TEXT_WITH_IMAGES' : 'INJECT_TEXT';
}
