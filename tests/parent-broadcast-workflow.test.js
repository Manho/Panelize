import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { broadcastMessage, sendToPanel } from '../multi-panel/multi-panel.js';
import { getPanelBroadcastActionParams } from '../modules/panel-action-results.js';

describe('parent page sendToPanel & broadcastMessage production implementation workflow', () => {
  let panel;
  let iframe;

  beforeEach(() => {
    document.body.innerHTML = `
      <textarea id="unified-input"></textarea>
      <button id="send-all-btn"></button>
      <button id="fill-input-btn"></button>
      <div id="send-status"></div>
    `;

    iframe = { contentWindow: { postMessage: vi.fn() } };
    panel = { id: 'panel-1', providerId: 'grok', iframe };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendToPanel production export', () => {
    it('posts INJECT_TEXT and resolves immediately without waiting for ACK for plain text Send All', async () => {
      const broadcastParams = getPanelBroadcastActionParams({
        hasImages: false,
        hasFailedPanels: false,
        autoSubmit: true,
      });

      const sendFocusRequestId = 'send-focus-123';

      const result = await sendToPanel(
        panel,
        'Plain text prompt',
        [],
        broadcastParams.shouldAutoSubmit,
        sendFocusRequestId,
        false,
        8000,
        {
          isFillAction: broadcastParams.isFillAction,
          waitForActionResult: broadcastParams.waitForActionResult,
        }
      );

      expect(result).toEqual({
        ok: true,
        panelId: 'panel-1',
        provider: 'grok',
        succeededImageIds: [],
      });

      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          type: 'INJECT_TEXT',
          text: 'Plain text prompt',
          images: [],
          autoSubmit: true,
          requestId: 'send-focus-123',
          action: undefined,
          retry: undefined,
          providerMode: null,
          context: 'multi-panel',
        },
        '*'
      );
    });

    it('posts INJECT_TEXT for plain text Enter trigger', async () => {
      const broadcastParams = getPanelBroadcastActionParams({
        hasImages: false,
        hasFailedPanels: false,
        autoSubmit: true,
      });

      const result = await sendToPanel(
        panel,
        'Enter prompt',
        [],
        broadcastParams.shouldAutoSubmit,
        'send-focus-456',
        false,
        8000,
        {
          isFillAction: broadcastParams.isFillAction,
          waitForActionResult: broadcastParams.waitForActionResult,
        }
      );

      expect(result.ok).toBe(true);
      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'INJECT_TEXT',
          text: 'Enter prompt',
          images: [],
          autoSubmit: true,
        }),
        '*'
      );
    });

    it('posts INJECT_TEXT_WITH_IMAGES and waits for ACK completion during text-only retry after image fill', async () => {
      const broadcastParams = getPanelBroadcastActionParams({
        hasImages: false,
        hasFailedPanels: true,
        autoSubmit: false,
      });

      const fillActionRequestId = 'fill-action-789';

      const sendPromise = sendToPanel(
        panel,
        'Text retry content',
        [],
        broadcastParams.shouldAutoSubmit,
        fillActionRequestId,
        true,
        8000,
        {
          isFillAction: broadcastParams.isFillAction,
          waitForActionResult: broadcastParams.waitForActionResult,
        }
      );

      expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          type: 'INJECT_TEXT_WITH_IMAGES',
          text: 'Text retry content',
          images: [],
          autoSubmit: false,
          requestId: 'fill-action-789',
          action: 'fill',
          retry: true,
          providerMode: null,
          context: 'multi-panel',
        },
        '*'
      );

      // Simulate content script sending matching ACK back to window
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'PANELIZE_ACTION_RESULT',
            context: 'multi-panel-action-result',
            requestId: 'fill-action-789',
            provider: 'grok',
            action: 'fill',
            status: 'succeeded',
            succeededImageIds: [],
          },
          source: iframe.contentWindow,
        })
      );

      const result = await sendPromise;

      expect(result).toEqual({
        ok: true,
        panelId: 'panel-1',
        provider: 'grok',
        succeededImageIds: [],
      });
    });
  });

  describe('broadcastMessage production export smoke tests', () => {
    it('executes broadcastMessage for plain text prompt without ReferenceError or error status', async () => {
      const statusEl = document.getElementById('send-status');

      await broadcastMessage('Test plain text broadcast', true);

      // Verify buttons are re-enabled in finally block
      expect(document.getElementById('send-all-btn').disabled).toBe(false);
      expect(document.getElementById('fill-input-btn').disabled).toBe(false);
      // Status should be Sent to... or Filled..., not "Error occurred"
      expect(statusEl.textContent).not.toBe('Error occurred');
    });

    it('handles empty input gracefully without throwing ReferenceError', async () => {
      const statusEl = document.getElementById('send-status');

      await broadcastMessage('', true);

      expect(document.getElementById('send-all-btn').disabled).toBe(false);
      expect(statusEl.textContent).not.toBe('Error occurred');
    });
  });
});
