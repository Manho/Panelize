import { isProviderFrameOrigin } from './provider-open-url.js';

export const PANELIZE_ACTION_RESULT = 'PANELIZE_ACTION_RESULT';
export const PANEL_ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
export const PANEL_ACTION_RESULT_TIMEOUT_MS = 8000;
export const PANEL_IMAGE_ACTION_RESULT_STEP_MS = 6500;
export const PANEL_DOCUMENT_ACTION_RESULT_BASE_TIMEOUT_MS = 12000;
export const PANEL_DOCUMENT_ACTION_RESULT_STEP_MS = 10000;

const ALLOWED_FAILURE_REASONS = new Set([
  'control-not-found',
  'unsupported',
  'type-not-accepted',
  'preview-timeout',
  'injection-error'
]);

const ALLOWED_SKIP_REASONS = new Set([
  'unsupported',
  'type-not-accepted',
  'too-large'
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
 * Normalizes a skippedAttachments array reported by a panel frame.
 *
 * @param {Array<object>} [skippedAttachments]
 * @returns {Array<{id?: string, name: string, reason: string}>}
 */
export function normalizeSkippedAttachments(skippedAttachments) {
  if (!Array.isArray(skippedAttachments)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const item of skippedAttachments) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = typeof item.id === 'string' && item.id ? item.id : undefined;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '';
    const reason = ALLOWED_SKIP_REASONS.has(item.reason) ? item.reason : 'unsupported';
    const dedupeKey = id || `${name}:${reason}`;
    if (!dedupeKey || seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      ...(id ? { id } : {}),
      name: name || id || 'attachment',
      reason
    });
  }
  return normalized;
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
    isProviderFrameOrigin(panel.providerId, event.origin) &&
    (data.status === 'succeeded' || data.status === 'skipped' || data.status === 'failed')
  );
}

/**
 * Calculates the action result timeout weighted by image and document counts.
 *
 * - Images only: 8000ms for 0-1 images, +6500ms per additional image.
 * - Documents present: 12000ms base for the first document, +10000ms per additional document,
 *   plus +6500ms per image when mixed with images.
 *
 * Accepts:
 * - `getPanelActionResultTimeoutMs(imageCount)`
 * - `getPanelActionResultTimeoutMs(imageCount, documentCount)`
 * - `getPanelActionResultTimeoutMs({ imageCount, documentCount })`
 *
 * @param {number | { imageCount?: number, documentCount?: number }} imageCountOrCounts
 * @param {number} [documentCountArg=0]
 * @returns {number} Timeout in milliseconds.
 */
export function getPanelActionResultTimeoutMs(imageCountOrCounts, documentCountArg = 0) {
  let imageCount = 0;
  let documentCount = 0;

  if (imageCountOrCounts && typeof imageCountOrCounts === 'object') {
    imageCount = Math.max(0, Number(imageCountOrCounts.imageCount) || 0);
    documentCount = Math.max(0, Number(imageCountOrCounts.documentCount) || 0);
  } else {
    imageCount = Math.max(0, Number(imageCountOrCounts) || 0);
    documentCount = Math.max(0, Number(documentCountArg) || 0);
  }

  if (documentCount > 0) {
    const docTimeout = PANEL_DOCUMENT_ACTION_RESULT_BASE_TIMEOUT_MS
      + (documentCount - 1) * PANEL_DOCUMENT_ACTION_RESULT_STEP_MS;
    const imageExtra = imageCount * PANEL_IMAGE_ACTION_RESULT_STEP_MS;
    return docTimeout + imageExtra;
  }

  if (imageCount <= 1) {
    return PANEL_ACTION_RESULT_TIMEOUT_MS;
  }
  return PANEL_ACTION_RESULT_TIMEOUT_MS + (imageCount - 1) * PANEL_IMAGE_ACTION_RESULT_STEP_MS;
}

/**
 * Normalizes succeeded image/attachment IDs from an ACK message against expected IDs.
 *
 * @param {Array<string>} [succeededImageIds] - IDs reported in ACK.
 * @param {Array<string>} [expectedImageIds=[]] - IDs expected in request payload.
 * @param {boolean} [isSuccess=true] - Whether the overall status was succeeded.
 * @returns {Array<string>} Filtered, unique, valid IDs.
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

export const normalizeSucceededAttachmentIds = normalizeSucceededImageIds;

/**
 * Calculates pending image/attachment IDs remaining to be uploaded.
 *
 * @param {Array<string>} [expectedImageIds=[]] - IDs attempted in this request.
 * @param {Array<string>} [succeededImageIds=[]] - IDs verified as succeeded.
 * @returns {Array<string>} Remaining IDs that still need upload.
 */
export function calculatePendingImageIds(expectedImageIds = [], succeededImageIds = []) {
  const succeededSet = new Set(succeededImageIds || []);
  return (expectedImageIds || []).filter(id => !succeededSet.has(id));
}

export const calculatePendingAttachmentIds = calculatePendingImageIds;

/**
 * Cleans up stale panel IDs from retry tracking structures.
 *
 * @param {Array<object>} panels - Current active panels.
 * @param {Map<string, Array<string>>} pendingFillImageIdsByPanel - Pending attachment IDs by panel.
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
 * @param {Array<string>} [options.expectedImageIds=[]] - Legacy expected image IDs.
 * @param {Array<string>} [options.expectedAttachmentIds] - Generalized expected attachment IDs.
 * @param {string} [options.action='fill'] - Expected action name.
 * @param {number} [options.timeoutMs=8000] - Maximum wait time.
 * @returns {{promise: Promise<object>, cancel: (reason?: string) => void}} Waiter controls.
 */
export function createPanelActionResultWaiter({
  target = window,
  panel,
  requestId,
  expectedImageIds = [],
  expectedAttachmentIds,
  action = 'fill',
  timeoutMs = PANEL_ACTION_RESULT_TIMEOUT_MS
}) {
  const expectedIds = Array.isArray(expectedAttachmentIds) ? expectedAttachmentIds : expectedImageIds;
  const includeAttachmentFieldsByDefault = Array.isArray(expectedAttachmentIds);
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

    const data = event.data;
    const rawSucceededIds = Array.isArray(data.succeededAttachmentIds)
      ? data.succeededAttachmentIds
      : data.succeededImageIds;
    const rawAttemptedIds = Array.isArray(data.attemptedAttachmentIds)
      ? data.attemptedAttachmentIds
      : data.attemptedImageIds;
    const skippedAttachments = normalizeSkippedAttachments(data.skippedAttachments);
    const hasAttachmentMetadata =
      includeAttachmentFieldsByDefault ||
      Array.isArray(data.succeededAttachmentIds) ||
      Array.isArray(data.attemptedAttachmentIds) ||
      skippedAttachments.length > 0;

    if (data.status === 'skipped') {
      const succeededIds = normalizeSucceededAttachmentIds(rawSucceededIds, expectedIds, false);
      settle({
        ok: true,
        skipped: true,
        panelId: panel.id,
        provider: panel.providerId,
        reason: ALLOWED_SKIP_REASONS.has(data.reason) ? data.reason : 'unsupported',
        succeededImageIds: succeededIds,
        succeededAttachmentIds: succeededIds,
        ...(skippedAttachments.length > 0 ? { skippedAttachments } : {})
      });
      return;
    }

    if (data.status === 'succeeded') {
      // If some attachments were explicitly skipped, omit skipped IDs from fallback full-success inference.
      const skippedIdSet = new Set(skippedAttachments.map(item => item.id).filter(Boolean));
      const nonSkippedExpectedIds = expectedIds.filter(id => !skippedIdSet.has(id));
      const succeededIds = normalizeSucceededAttachmentIds(
        rawSucceededIds,
        Array.isArray(rawSucceededIds) ? expectedIds : nonSkippedExpectedIds,
        true
      );
      settle({
        ok: true,
        panelId: panel.id,
        provider: panel.providerId,
        succeededImageIds: succeededIds,
        ...(hasAttachmentMetadata ? { succeededAttachmentIds: succeededIds } : {}),
        ...(skippedAttachments.length > 0 ? { skippedAttachments } : {})
      });
      return;
    }

    const succeededIds = normalizeSucceededAttachmentIds(rawSucceededIds, expectedIds, false);
    const attemptedIds = Array.isArray(rawAttemptedIds)
      ? normalizeSucceededAttachmentIds(rawAttemptedIds, expectedIds, false)
      : undefined;

    settle({
      ...createFailure(panel, data.reason),
      succeededImageIds: succeededIds,
      ...(hasAttachmentMetadata ? { succeededAttachmentIds: succeededIds } : {}),
      ...(attemptedIds !== undefined
        ? {
          attemptedImageIds: attemptedIds,
          ...(hasAttachmentMetadata ? { attemptedAttachmentIds: attemptedIds } : {})
        }
        : {}),
      ...(skippedAttachments.length > 0 ? { skippedAttachments } : {})
    });
  };

  const promise = new Promise(resolve => {
    resolvePromise = resolve;
    target.addEventListener('message', handleMessage);
    timeoutId = setTimeout(() => {
      const empty = normalizeSucceededAttachmentIds(undefined, expectedIds, false);
      settle({
        ...createFailure(panel, 'preview-timeout'),
        succeededImageIds: empty,
        ...(includeAttachmentFieldsByDefault ? { succeededAttachmentIds: empty } : {})
      });
    }, timeoutMs);
  });

  return {
    promise,
    cancel(reason = 'injection-error') {
      const empty = normalizeSucceededAttachmentIds(undefined, expectedIds, false);
      settle({
        ...createFailure(panel, reason),
        succeededImageIds: empty,
        ...(includeAttachmentFieldsByDefault ? { succeededAttachmentIds: empty } : {})
      });
    }
  };
}

/**
 * Returns only panels that still need an attachment fill retry.
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

function getPanelSetKey(panels) {
  return (panels || [])
    .map(panel => panel?.id)
    .filter(id => typeof id === 'string')
    .sort()
    .join('\u0000');
}

/**
 * Retains each panel's latest fill outcome for one payload revision so that
 * `Retry Failed` (which only re-targets failed panels) still summarizes and
 * decides draft clearing from the complete set of panel outcomes.
 *
 * The retained map is discarded whenever the payload revision or the panel
 * set differs from the previous state.
 *
 * @param {{revision: number, panelKey: string, outcomes: Map<string, object>} | null} previousState
 * @param {{revision: number, panels: Array<object>, results: Array<object>}} update
 * @returns {{revision: number, panelKey: string, outcomes: Map<string, object>}}
 */
export function mergePanelFillOutcomes(previousState, { revision, panels = [], results = [] } = {}) {
  const panelKey = getPanelSetKey(panels);
  const outcomes = previousState &&
    previousState.revision === revision &&
    previousState.panelKey === panelKey &&
    previousState.outcomes instanceof Map
    ? new Map(previousState.outcomes)
    : new Map();
  const currentPanelIds = new Set(panels.map(panel => panel?.id));
  (results || []).forEach(result => {
    if (result?.panelId && currentPanelIds.has(result.panelId)) {
      outcomes.set(result.panelId, result);
    }
  });
  return { revision, panelKey, outcomes };
}

/**
 * Summarizes the current overall tri-state fill state (`succeeded`, `skipped`, `failed`).
 *
 * `skipped` panels never enter `failedPanelIds` and never trigger `Retry Failed`.
 *
 * @param {Array<object>} panels - Current panel list.
 * @param {Array<object>} results - Results from panels targeted in this attempt.
 * @param {Set<string>} [previousFailedPanelIds=new Set()] - Failures before this attempt.
 * @returns {{
 *   successfulCount: number,
 *   skippedCount: number,
 *   failedCount: number,
 *   failedPanelIds: Set<string>,
 *   skippedPanelIds: Set<string>,
 *   partialSkippedPanelIds: Set<string>,
 *   allSucceeded: boolean,
 *   allSkipped: boolean
 * }}
 */
export function summarizeFillResults(panels, results, previousFailedPanelIds = new Set()) {
  const currentPanelIds = new Set(panels.map(panel => panel.id));
  const failedPanelIds = new Set(
    [...previousFailedPanelIds].filter(panelId => currentPanelIds.has(panelId))
  );
  const skippedPanelIds = new Set();
  const partialSkippedPanelIds = new Set();

  results.forEach(result => {
    if (!result?.panelId || !currentPanelIds.has(result.panelId)) {
      return;
    }
    if (result.skipped === true) {
      failedPanelIds.delete(result.panelId);
      skippedPanelIds.add(result.panelId);
    } else if (result.ok) {
      failedPanelIds.delete(result.panelId);
      if (Array.isArray(result.skippedAttachments) && result.skippedAttachments.length > 0) {
        partialSkippedPanelIds.add(result.panelId);
      }
    } else {
      failedPanelIds.add(result.panelId);
    }
  });

  const failedCount = failedPanelIds.size;
  const skippedCount = skippedPanelIds.size;
  const successfulCount = Math.max(0, panels.length - failedCount - skippedCount);
  const allSkipped = panels.length > 0 && failedCount === 0 && skippedCount === panels.length;

  return {
    successfulCount,
    skippedCount,
    failedCount,
    failedPanelIds,
    skippedPanelIds,
    partialSkippedPanelIds,
    allSucceeded: panels.length > 0 && failedCount === 0,
    allSkipped
  };
}

/**
 * Returns whether unified text and attachments may be cleared after a fill.
 *
 * Preserves attachments when any panel failed OR when every panel skipped a
 * document-only send (no text was delivered anywhere).
 *
 * @param {object} summary - Fill summary from summarizeFillResults.
 * @param {{ hasText?: boolean }} [options={}]
 * @returns {boolean}
 */
export function shouldClearFillPayload(summary, { hasText = false } = {}) {
  if (!summary?.allSucceeded) {
    return false;
  }
  if (summary.allSkipped && !hasText) {
    return false;
  }
  return true;
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
      succeededImageIds: [],
      succeededAttachmentIds: []
    };
  });
}

/**
 * Determines action parameters for a panel broadcast operation.
 *
 * @param {object} options
 * @param {boolean} [options.hasImages=false] - Legacy alias for whether images are attached.
 * @param {boolean} [options.hasAttachments=false] - Whether images or documents are attached.
 * @param {boolean} [options.hasFailedPanels=false] - Whether any panel has a pending failed fill.
 * @param {boolean} [options.autoSubmit=true] - Requested autoSubmit behavior.
 * @returns {{isFillAction: boolean, shouldAutoSubmit: boolean, messageType: string, waitForActionResult: boolean}}
 */
export function getPanelBroadcastActionParams({
  hasImages = false,
  hasAttachments = false,
  hasFailedPanels = false,
  autoSubmit = true
} = {}) {
  const isFillAction = Boolean(hasImages || hasAttachments || hasFailedPanels);
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
