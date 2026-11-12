import { getCustomApiKey } from './custom-api-secrets.js';
import { hasOptionalProviderPermission } from './optional-provider-access.js';
import { streamChatCompletion } from './openai-chat-client.js';
import { findMessageSourcePanel } from './provider-open-url.js';
import { getProviderDescriptor } from './provider-registry.js';

export const API_PANEL_CONTEXT = 'panelize-api-panel';

export const API_PANEL_MESSAGES = Object.freeze({
  READY: 'PANELIZE_API_PANEL_READY',
  INIT: 'PANELIZE_API_PANEL_INIT',
  THEME_UPDATE: 'PANELIZE_API_THEME_UPDATE',
  CHAT_REQUEST: 'PANELIZE_API_CHAT_REQUEST',
  CHAT_ABORT: 'PANELIZE_API_CHAT_ABORT',
  CHAT_DELTA: 'PANELIZE_API_CHAT_DELTA',
  CHAT_DONE: 'PANELIZE_API_CHAT_DONE',
  CHAT_ERROR: 'PANELIZE_API_CHAT_ERROR'
});

function isCustomApiDescriptor(descriptor) {
  return Boolean(descriptor && descriptor.access === 'custom' && descriptor.customKind === 'api');
}

function postToApiPanelFrame(panel, descriptor, payload) {
  const targetWindow = panel?.iframe?.contentWindow;
  const targetOrigin = descriptor?.frameOrigins?.[0];
  if (!targetWindow || typeof targetOrigin !== 'string' || targetOrigin === 'null') {
    return;
  }
  targetWindow.postMessage(
    {
      ...payload,
      context: API_PANEL_CONTEXT,
      providerId: panel.providerId
    },
    targetOrigin
  );
}

/**
 * Mediates privileged OpenAI-compatible API streaming on the top-level Multi-Panel
 * host page so embedded `api-panel` frames never read IndexedDB secrets directly
 * or touch `chrome.*` extension APIs.
 *
 * @param {{
 *   getPanels: () => Array<{ id: string, providerId: string, iframe?: HTMLIFrameElement }>,
 *   getTheme: () => 'light' | 'dark',
 *   hostWindow?: Window,
 *   getApiKey?: (providerId: string) => Promise<string | null>,
 *   checkPermission?: (providerId: string) => Promise<boolean>,
 *   streamCompletion?: typeof streamChatCompletion
 * }} options
 */
export function createCustomApiHostBridge({
  getPanels,
  getTheme,
  hostWindow = window,
  getApiKey = getCustomApiKey,
  checkPermission = hasOptionalProviderPermission,
  streamCompletion = streamChatCompletion
}) {
  const activeStreams = new Map();

  function abortPanelStream(panelId) {
    const existing = activeStreams.get(panelId);
    if (!existing) {
      return false;
    }
    activeStreams.delete(panelId);
    existing.controller.abort();
    return true;
  }

  async function handleChatRequest(panel, descriptor, data) {
    const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
    if (!requestId || !Array.isArray(data.messages) || data.messages.length === 0) {
      return;
    }

    abortPanelStream(panel.id);
    const controller = new AbortController();
    activeStreams.set(panel.id, { requestId, controller });

    const isCurrentRequest = () => activeStreams.get(panel.id)?.requestId === requestId;

    try {
      const permitted = await checkPermission(panel.providerId);
      if (!isCurrentRequest() || controller.signal.aborted) {
        return;
      }
      if (!permitted) {
        activeStreams.delete(panel.id);
        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.CHAT_ERROR,
          requestId,
          status: null,
          code: 'permission_missing',
          message:
            'Host permission for this API endpoint is not granted on this device. Re-authorize or re-add it in Settings.'
        });
        return;
      }

      const storedKey = await getApiKey(panel.providerId);
      if (!isCurrentRequest() || controller.signal.aborted) {
        return;
      }
      const apiKey = typeof storedKey === 'string' ? storedKey : '';
      if (descriptor.apiConfig.hasApiKey && apiKey.length === 0) {
        activeStreams.delete(panel.id);
        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.CHAT_ERROR,
          requestId,
          status: null,
          code: 'missing_api_key',
          message:
            'API key is missing on this device. Edit this API provider in Settings to enter the key locally.'
        });
        return;
      }

      const result = await streamCompletion({
        endpointUrl: descriptor.apiConfig.endpointUrl,
        model: descriptor.apiConfig.model,
        apiKey,
        messages: data.messages,
        signal: controller.signal,
        onDelta({ contentDelta, reasoningDelta }) {
          if (!isCurrentRequest() || controller.signal.aborted) {
            return;
          }
          postToApiPanelFrame(panel, descriptor, {
            type: API_PANEL_MESSAGES.CHAT_DELTA,
            requestId,
            contentDelta,
            reasoningDelta
          });
        }
      });

      if (!isCurrentRequest()) {
        return;
      }
      activeStreams.delete(panel.id);
      postToApiPanelFrame(panel, descriptor, {
        type: API_PANEL_MESSAGES.CHAT_DONE,
        requestId,
        aborted: false,
        content: result.content,
        reasoning: result.reasoning,
        finishReason: result.finishReason
      });
    } catch (error) {
      const wasCurrent = isCurrentRequest();
      if (wasCurrent) {
        activeStreams.delete(panel.id);
      }
      if (controller.signal.aborted || error?.name === 'AbortError') {
        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.CHAT_DONE,
          requestId,
          aborted: true
        });
        return;
      }
      if (!wasCurrent) {
        return;
      }
      postToApiPanelFrame(panel, descriptor, {
        type: API_PANEL_MESSAGES.CHAT_ERROR,
        requestId,
        status: typeof error?.status === 'number' ? error.status : null,
        code: typeof error?.code === 'string' ? error.code : 'request_error',
        message: error?.message || 'API request failed.'
      });
    }
  }

  function onMessage(event) {
    // Refuse to mediate secrets or network requests if Multi-Panel itself was framed.
    if (hostWindow.top !== hostWindow) {
      return;
    }
    if (typeof event?.origin !== 'string' || event.origin === 'null') {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object' || data.context !== API_PANEL_CONTEXT) {
      return;
    }

    const panel = findMessageSourcePanel(getPanels(), event);
    if (!panel || data.providerId !== panel.providerId) {
      return;
    }

    const descriptor = getProviderDescriptor(panel.providerId);
    if (!isCustomApiDescriptor(descriptor)) {
      return;
    }

    switch (data.type) {
      case API_PANEL_MESSAGES.READY:
        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.INIT,
          name: descriptor.name,
          model: descriptor.apiConfig.model,
          apiOrigin: descriptor.apiConfig.apiOrigin,
          endpointUrl: descriptor.apiConfig.endpointUrl,
          hasApiKey: descriptor.apiConfig.hasApiKey,
          theme: getTheme()
        });
        break;
      case API_PANEL_MESSAGES.CHAT_REQUEST:
        handleChatRequest(panel, descriptor, data);
        break;
      case API_PANEL_MESSAGES.CHAT_ABORT:
        if (!data.requestId || activeStreams.get(panel.id)?.requestId === data.requestId) {
          abortPanelStream(panel.id);
          postToApiPanelFrame(panel, descriptor, {
            type: API_PANEL_MESSAGES.CHAT_DONE,
            requestId: data.requestId || null,
            aborted: true
          });
        }
        break;
      default:
        break;
    }
  }

  hostWindow.addEventListener('message', onMessage);

  return {
    abortPanelStream,
    broadcastTheme(theme) {
      if (hostWindow.top !== hostWindow) {
        return;
      }
      for (const panel of getPanels()) {
        const descriptor = getProviderDescriptor(panel.providerId);
        if (isCustomApiDescriptor(descriptor)) {
          postToApiPanelFrame(panel, descriptor, {
            type: API_PANEL_MESSAGES.THEME_UPDATE,
            theme
          });
        }
      }
    },
    syncPanelsMetadata() {
      if (hostWindow.top !== hostWindow) {
        return;
      }
      for (const panel of getPanels()) {
        const descriptor = getProviderDescriptor(panel.providerId);
        if (isCustomApiDescriptor(descriptor)) {
          postToApiPanelFrame(panel, descriptor, {
            type: API_PANEL_MESSAGES.INIT,
            name: descriptor.name,
            model: descriptor.apiConfig.model,
            apiOrigin: descriptor.apiConfig.apiOrigin,
            endpointUrl: descriptor.apiConfig.endpointUrl,
            hasApiKey: descriptor.apiConfig.hasApiKey,
            theme: getTheme()
          });
        }
      }
    },
    dispose() {
      hostWindow.removeEventListener('message', onMessage);
      for (const panelId of [...activeStreams.keys()]) {
        abortPanelStream(panelId);
      }
    }
  };
}
