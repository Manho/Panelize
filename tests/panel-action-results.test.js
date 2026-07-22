import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_ACTION_RESULT_CONTEXT,
  PANELIZE_ACTION_RESULT,
  calculatePendingImageIds,
  cleanStalePanelRetryState,
  createBroadcastGate,
  createPanelActionResultWaiter,
  determinePanelMessageType,
  getFillTargetPanels,
  getPanelActionResultTimeoutMs,
  getPanelBroadcastActionParams,
  isMatchingPanelActionResult,
  normalizeSucceededImageIds,
  shouldClearFillPayload,
  summarizeFillResults,
} from '../modules/panel-action-results.js';

function createPanel(id = 'panel-1', providerId = 'grok') {
  const contentWindow = {};
  return {
    panel: {
      id,
      providerId,
      iframe: { contentWindow },
    },
    contentWindow,
  };
}

function createActionMessage(source, overrides = {}) {
  return new MessageEvent('message', {
    source,
    data: {
      type: PANELIZE_ACTION_RESULT,
      context: PANEL_ACTION_RESULT_CONTEXT,
      requestId: 'request-current',
      provider: 'grok',
      action: 'fill',
      status: 'succeeded',
      ...overrides,
    },
  });
}

describe('panel action result protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts only results from the expected iframe source and provider', () => {
    const { panel, contentWindow } = createPanel();

    expect(isMatchingPanelActionResult(
      createActionMessage(contentWindow),
      panel,
      'request-current'
    )).toBe(true);
    expect(isMatchingPanelActionResult(
      createActionMessage({}),
      panel,
      'request-current'
    )).toBe(false);
    expect(isMatchingPanelActionResult(
      createActionMessage(contentWindow, { provider: 'deepseek' }),
      panel,
      'request-current'
    )).toBe(false);
  });

  it('ignores stale request IDs until the active result arrives', async () => {
    const target = new EventTarget();
    const { panel, contentWindow } = createPanel();
    const waiter = createPanelActionResultWaiter({
      target,
      panel,
      requestId: 'request-current',
      timeoutMs: 1000,
    });
    const settled = vi.fn();
    waiter.promise.then(settled);

    target.dispatchEvent(createActionMessage(contentWindow, { requestId: 'request-stale' }));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).not.toHaveBeenCalled();

    target.dispatchEvent(createActionMessage(contentWindow));
    await expect(waiter.promise).resolves.toEqual({
      ok: true,
      panelId: 'panel-1',
      provider: 'grok',
      succeededImageIds: [],
    });
  });

  it('fails a panel after the eight-second result timeout', async () => {
    const target = new EventTarget();
    const { panel } = createPanel();
    const waiter = createPanelActionResultWaiter({
      target,
      panel,
      requestId: 'request-current',
    });

    await vi.advanceTimersByTimeAsync(8000);

    await expect(waiter.promise).resolves.toEqual({
      ok: false,
      panelId: 'panel-1',
      provider: 'grok',
      reason: 'preview-timeout',
      succeededImageIds: [],
    });
  });

  it('preserves a supported failure reason from the content script', async () => {
    const target = new EventTarget();
    const { panel, contentWindow } = createPanel('panel-kimi', 'kimi');
    const waiter = createPanelActionResultWaiter({
      target,
      panel,
      requestId: 'request-current',
    });

    target.dispatchEvent(createActionMessage(contentWindow, {
      provider: 'kimi',
      status: 'failed',
      reason: 'unsupported',
    }));

    await expect(waiter.promise).resolves.toEqual({
      ok: false,
      panelId: 'panel-kimi',
      provider: 'kimi',
      reason: 'unsupported',
      succeededImageIds: [],
    });
  });
});

describe('image fill ACK normalization and timeout budget', () => {
  it('calculates timeout budget for 0, 1, 2, 10 images correctly', () => {
    expect(getPanelActionResultTimeoutMs(0)).toBe(8000);
    expect(getPanelActionResultTimeoutMs(1)).toBe(8000);
    expect(getPanelActionResultTimeoutMs(2)).toBe(14500);
    expect(getPanelActionResultTimeoutMs(10)).toBe(66500);
  });

  it('normalizes success ACK missing image list to all expected IDs', () => {
    const expected = ['img-1', 'img-2'];
    expect(normalizeSucceededImageIds(undefined, expected, true)).toEqual(['img-1', 'img-2']);
  });

  it('normalizes failure ACK missing image list to empty array', () => {
    const expected = ['img-1', 'img-2'];
    expect(normalizeSucceededImageIds(undefined, expected, false)).toEqual([]);
  });

  it('filters unknown, duplicate, and non-string image IDs in ACK', () => {
    const expected = ['img-1', 'img-2', 'img-3'];
    const received = ['img-1', 'img-1', 123, 'img-unknown', null, 'img-2'];
    expect(normalizeSucceededImageIds(received, expected, false)).toEqual(['img-1', 'img-2']);
  });

  it('calculates pending image IDs when failed ACK carries partial succeededImageIds', () => {
    const expected = ['img-1', 'img-2'];
    const succeeded = ['img-1'];
    const pending = calculatePendingImageIds(expected, succeeded);
    expect(pending).toEqual(['img-2']);
  });

  it('returns empty pending array when all images succeeded but text failed', () => {
    const expected = ['img-1', 'img-2'];
    const succeeded = ['img-1', 'img-2'];
    const pending = calculatePendingImageIds(expected, succeeded);
    expect(pending).toEqual([]);
  });
});

describe('fill retry state & stale ID cleanup', () => {
  const panels = [
    { id: 'panel-grok', providerId: 'grok' },
    { id: 'panel-deepseek', providerId: 'deepseek' },
    { id: 'panel-kimi', providerId: 'kimi' },
  ];

  it('retains the payload and records failed panels after a partial fill', () => {
    const summary = summarizeFillResults(panels, [
      { ok: true, panelId: 'panel-grok' },
      { ok: false, panelId: 'panel-deepseek', reason: 'preview-timeout' },
      { ok: false, panelId: 'panel-kimi', reason: 'unsupported' },
    ]);

    expect(summary.successfulCount).toBe(1);
    expect(summary.failedCount).toBe(2);
    expect([...summary.failedPanelIds]).toEqual(['panel-deepseek', 'panel-kimi']);
    expect(shouldClearFillPayload(summary)).toBe(false);
  });

  it('targets only failed panels on the next fill attempt', () => {
    const failedPanelIds = new Set(['panel-deepseek', 'panel-kimi']);

    expect(getFillTargetPanels(panels, failedPanelIds).map(panel => panel.id)).toEqual([
      'panel-deepseek',
      'panel-kimi',
    ]);
  });

  it('cleans up stale panel IDs when a panel is deleted or provider switched', () => {
    const failedPanelIds = new Set(['panel-deepseek', 'panel-stale']);
    const pendingMap = new Map([
      ['panel-deepseek', ['img-2']],
      ['panel-stale', ['img-1', 'img-2']],
    ]);

    cleanStalePanelRetryState(panels, pendingMap, failedPanelIds);

    expect([...failedPanelIds]).toEqual(['panel-deepseek']);
    expect(pendingMap.has('panel-stale')).toBe(false);
    expect(pendingMap.get('panel-deepseek')).toEqual(['img-2']);
  });

  it('clears the payload only after every failed panel succeeds on retry', () => {
    const previousFailures = new Set(['panel-deepseek', 'panel-kimi']);
    const partialRetry = summarizeFillResults(panels, [
      { ok: true, panelId: 'panel-deepseek' },
      { ok: false, panelId: 'panel-kimi', reason: 'unsupported' },
    ], previousFailures);
    expect(shouldClearFillPayload(partialRetry)).toBe(false);
    expect([...partialRetry.failedPanelIds]).toEqual(['panel-kimi']);

    const completedRetry = summarizeFillResults(panels, [
      { ok: true, panelId: 'panel-kimi' },
    ], partialRetry.failedPanelIds);
    expect(completedRetry.successfulCount).toBe(3);
    expect(shouldClearFillPayload(completedRetry)).toBe(true);
  });

  it('resets retry targeting when no failed IDs remain', () => {
    expect(getFillTargetPanels(panels, new Set())).toBe(panels);
  });
});

describe('broadcast gate', () => {
  it('prevents concurrent acquire and allows acquire after release', () => {
    const gate = createBroadcastGate();
    expect(gate.isActive()).toBe(false);

    expect(gate.tryAcquire()).toBe(true);
    expect(gate.isActive()).toBe(true);
    expect(gate.tryAcquire()).toBe(false);

    gate.release();
    expect(gate.isActive()).toBe(false);
    expect(gate.tryAcquire()).toBe(true);
  });
});

describe('getPanelBroadcastActionParams & determinePanelMessageType', () => {
  it('returns plain text parameters for plain text Send All', () => {
    const params = getPanelBroadcastActionParams({
      hasImages: false,
      hasFailedPanels: false,
      autoSubmit: true,
    });
    expect(params).toEqual({
      isFillAction: false,
      shouldAutoSubmit: true,
      messageType: 'INJECT_TEXT',
      waitForActionResult: false,
    });
    expect(determinePanelMessageType({ isFillAction: params.isFillAction })).toBe('INJECT_TEXT');
  });

  it('returns plain text parameters for plain text Fill Input Boxes', () => {
    const params = getPanelBroadcastActionParams({
      hasImages: false,
      hasFailedPanels: false,
      autoSubmit: false,
    });
    expect(params).toEqual({
      isFillAction: false,
      shouldAutoSubmit: false,
      messageType: 'INJECT_TEXT',
      waitForActionResult: false,
    });
    expect(determinePanelMessageType({ isFillAction: params.isFillAction })).toBe('INJECT_TEXT');
  });

  it('returns image fill parameters for image fill operations', () => {
    const params = getPanelBroadcastActionParams({
      hasImages: true,
      hasFailedPanels: false,
      autoSubmit: true,
    });
    expect(params).toEqual({
      isFillAction: true,
      shouldAutoSubmit: false,
      messageType: 'INJECT_TEXT_WITH_IMAGES',
      waitForActionResult: true,
    });
    expect(determinePanelMessageType({ isFillAction: params.isFillAction })).toBe('INJECT_TEXT_WITH_IMAGES');
  });

  it('returns fill action parameters during text-only retry when hasFailedPanels is true', () => {
    const params = getPanelBroadcastActionParams({
      hasImages: false,
      hasFailedPanels: true,
      autoSubmit: false,
    });
    expect(params).toEqual({
      isFillAction: true,
      shouldAutoSubmit: false,
      messageType: 'INJECT_TEXT_WITH_IMAGES',
      waitForActionResult: true,
    });
    expect(determinePanelMessageType({ isFillAction: params.isFillAction })).toBe('INJECT_TEXT_WITH_IMAGES');
  });
});
