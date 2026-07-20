import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANEL_ACTION_RESULT_CONTEXT,
  PANELIZE_ACTION_RESULT,
  createPanelActionResultWaiter,
  getFillTargetPanels,
  isMatchingPanelActionResult,
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
    });
  });
});

describe('fill retry state', () => {
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
