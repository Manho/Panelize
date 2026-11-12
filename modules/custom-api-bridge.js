import {
  CUSTOM_API_SECRETS_CHANNEL,
  CUSTOM_API_SECRETS_SOURCE_ID,
  getCustomApiKey,
  getCustomApiKeyRecord,
  onCustomApiSecretChanged
} from './custom-api-secrets.js';
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

function captureDescriptorConfig(descriptor) {
  return Object.freeze({
    providerId: descriptor.id,
    endpointUrl: descriptor.apiConfig.endpointUrl,
    model: descriptor.apiConfig.model,
    hasApiKey: Boolean(descriptor.apiConfig.hasApiKey)
  });
}

function isSameConfig(left, right) {
  return Boolean(
    left &&
      right &&
      left.providerId === right.providerId &&
      left.endpointUrl === right.endpointUrl &&
      left.model === right.model &&
      left.hasApiKey === right.hasApiKey
  );
}

function didEndpointOrModelChange(left, right) {
  return Boolean(
    left &&
      right &&
      (left.providerId !== right.providerId ||
        left.endpointUrl !== right.endpointUrl ||
        left.model !== right.model)
  );
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
 *   getApiKey?: (providerId: string, context?: { endpointUrl: string }) => Promise<string | null>,
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
  const panelSnapshots = new Map();
  const providerGenerations = new Map();
  const usesDefaultSecretStore = getApiKey === getCustomApiKey;

  function getProviderGeneration(providerId) {
    return providerGenerations.get(providerId) || 0;
  }

  function bumpProviderGeneration(providerId) {
    const next = getProviderGeneration(providerId) + 1;
    providerGenerations.set(providerId, next);
    return next;
  }

  function finalizeStreamAbort(entry) {
    if (!entry || entry.finalized) {
      return false;
    }
    entry.finalized = true;
    if (activeStreams.get(entry.panel.id) === entry) {
      activeStreams.delete(entry.panel.id);
    }
    entry.controller.abort();
    const targetDescriptor = getProviderDescriptor(entry.panel.providerId) || entry.descriptor;
    postToApiPanelFrame(entry.panel, targetDescriptor, {
      type: API_PANEL_MESSAGES.CHAT_DONE,
      requestId: entry.requestId,
      aborted: true
    });
    return true;
  }

  function abortPanelStream(panelId) {
    const existing = activeStreams.get(panelId);
    if (!existing) {
      return false;
    }
    return finalizeStreamAbort(existing);
  }

  function invalidateProviderCredentials(providerId) {
    if (providerId === '*') {
      const knownIds = new Set([
        ...providerGenerations.keys(),
        ...[...activeStreams.values()].map((entry) => entry.panel.providerId)
      ]);
      for (const id of knownIds) {
        bumpProviderGeneration(id);
      }
      for (const entry of [...activeStreams.values()]) {
        finalizeStreamAbort(entry);
      }
      return;
    }

    if (typeof providerId !== 'string' || !providerId) {
      return;
    }
    bumpProviderGeneration(providerId);
    for (const entry of [...activeStreams.values()]) {
      if (entry.panel.providerId === providerId) {
        finalizeStreamAbort(entry);
      }
    }
  }

  async function handleChatRequest(panel, descriptor, data) {
    const requestId = typeof data.requestId === 'string' ? data.requestId.trim() : '';
    if (!requestId || !Array.isArray(data.messages) || data.messages.length === 0) {
      return;
    }

    abortPanelStream(panel.id);

    const capturedConfig = captureDescriptorConfig(descriptor);
    if (!panelSnapshots.has(panel.id)) {
      panelSnapshots.set(panel.id, capturedConfig);
    }
    const capturedGeneration = getProviderGeneration(panel.providerId);
    const controller = new AbortController();
    const streamEntry = {
      requestId,
      controller,
      panel,
      descriptor,
      capturedConfig,
      capturedGeneration,
      finalized: false
    };
    activeStreams.set(panel.id, streamEntry);

    const isCurrentRequest = () => activeStreams.get(panel.id) === streamEntry && !streamEntry.finalized;

    const isSnapshotStillValid = () => {
      if (!isCurrentRequest() || controller.signal.aborted) {
        return false;
      }
      if (getProviderGeneration(panel.providerId) !== capturedGeneration) {
        return false;
      }
      const liveDescriptor = getProviderDescriptor(panel.providerId);
      if (!isCustomApiDescriptor(liveDescriptor)) {
        return false;
      }
      return isSameConfig(captureDescriptorConfig(liveDescriptor), capturedConfig);
    };

    try {
      const permitted = await checkPermission(panel.providerId);
      if (!isSnapshotStillValid()) {
        finalizeStreamAbort(streamEntry);
        return;
      }
      if (!permitted) {
        streamEntry.finalized = true;
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

      let storedKey = null;
      if (usesDefaultSecretStore) {
        const keyRecord = await getCustomApiKeyRecord(panel.providerId);
        if (!isSnapshotStillValid()) {
          finalizeStreamAbort(streamEntry);
          return;
        }
        if (keyRecord?.endpointUrl && keyRecord.endpointUrl !== capturedConfig.endpointUrl) {
          // Stored credential is bound to a different endpoint; refuse to send it and surface error.
          streamEntry.finalized = true;
          activeStreams.delete(panel.id);
          postToApiPanelFrame(panel, descriptor, {
            type: API_PANEL_MESSAGES.CHAT_ERROR,
            requestId,
            status: null,
            code: 'endpoint_mismatch',
            message:
              'Stored API key does not match this endpoint URL. Edit this API provider in Settings to re-enter the key.'
          });
          return;
        }
        storedKey = keyRecord ? keyRecord.apiKey : null;
      } else {
        storedKey = await getApiKey(panel.providerId, {
          endpointUrl: capturedConfig.endpointUrl
        });
        if (!isSnapshotStillValid()) {
          finalizeStreamAbort(streamEntry);
          return;
        }
      }

      const apiKey = typeof storedKey === 'string' ? storedKey : '';
      if (capturedConfig.hasApiKey && apiKey.length === 0) {
        streamEntry.finalized = true;
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
        endpointUrl: capturedConfig.endpointUrl,
        model: capturedConfig.model,
        apiKey,
        messages: data.messages,
        signal: controller.signal,
        onDelta({ contentDelta, reasoningDelta }) {
          if (!isSnapshotStillValid()) {
            finalizeStreamAbort(streamEntry);
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

      if (!isSnapshotStillValid()) {
        finalizeStreamAbort(streamEntry);
        return;
      }
      streamEntry.finalized = true;
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
      if (controller.signal.aborted || error?.name === 'AbortError' || !isSnapshotStillValid()) {
        finalizeStreamAbort(streamEntry);
        return;
      }
      const wasCurrent = isCurrentRequest();
      streamEntry.finalized = true;
      if (wasCurrent) {
        activeStreams.delete(panel.id);
      } else {
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
        panelSnapshots.set(panel.id, captureDescriptorConfig(descriptor));
        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.INIT,
          name: descriptor.name,
          model: descriptor.apiConfig.model,
          apiOrigin: descriptor.apiConfig.apiOrigin,
          endpointUrl: descriptor.apiConfig.endpointUrl,
          hasApiKey: descriptor.apiConfig.hasApiKey,
          theme: getTheme(),
          resetConversation: false
        });
        break;
      case API_PANEL_MESSAGES.CHAT_REQUEST:
        handleChatRequest(panel, descriptor, data);
        break;
      case API_PANEL_MESSAGES.CHAT_ABORT:
        if (!data.requestId || activeStreams.get(panel.id)?.requestId === data.requestId) {
          if (!abortPanelStream(panel.id)) {
            postToApiPanelFrame(panel, descriptor, {
              type: API_PANEL_MESSAGES.CHAT_DONE,
              requestId: data.requestId || null,
              aborted: true
            });
          }
        }
        break;
      default:
        break;
    }
  }

  const unsubscribeLocalSecrets = onCustomApiSecretChanged(({ providerId }) => {
    invalidateProviderCredentials(providerId);
  });

  let secretChannel = null;
  if (typeof BroadcastChannel === 'function') {
    try {
      secretChannel = new BroadcastChannel(CUSTOM_API_SECRETS_CHANNEL);
      secretChannel.onmessage = (event) => {
        const msg = event?.data;
        if (
          msg?.type === 'SECRET_CHANGED' &&
          typeof msg.providerId === 'string' &&
          msg.sourceId !== CUSTOM_API_SECRETS_SOURCE_ID
        ) {
          invalidateProviderCredentials(msg.providerId);
        }
      };
      secretChannel.unref?.();
    } catch {
      secretChannel = null;
    }
  }

  hostWindow.addEventListener('message', onMessage);

  return {
    abortPanelStream,
    invalidateProviderCredentials,
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
      const currentPanels = getPanels();
      const livePanelIds = new Set(currentPanels.map((panel) => panel.id));
      for (const trackedPanelId of [...panelSnapshots.keys()]) {
        if (!livePanelIds.has(trackedPanelId)) {
          panelSnapshots.delete(trackedPanelId);
        }
      }

      for (const panel of currentPanels) {
        const descriptor = getProviderDescriptor(panel.providerId);
        if (!isCustomApiDescriptor(descriptor)) {
          panelSnapshots.delete(panel.id);
          abortPanelStream(panel.id);
          continue;
        }
        const nextConfig = captureDescriptorConfig(descriptor);
        const prevConfig = panelSnapshots.get(panel.id);
        const activeEntry = activeStreams.get(panel.id);
        const activeEntryStale =
          activeEntry !== undefined && !isSameConfig(activeEntry.capturedConfig, nextConfig);
        const configChanged =
          (prevConfig !== undefined && !isSameConfig(prevConfig, nextConfig)) || activeEntryStale;
        const resetConversation =
          (prevConfig !== undefined && didEndpointOrModelChange(prevConfig, nextConfig)) ||
          (activeEntryStale && didEndpointOrModelChange(activeEntry.capturedConfig, nextConfig));
        panelSnapshots.set(panel.id, nextConfig);

        if (configChanged) {
          bumpProviderGeneration(panel.providerId);
          abortPanelStream(panel.id);
        }

        postToApiPanelFrame(panel, descriptor, {
          type: API_PANEL_MESSAGES.INIT,
          name: descriptor.name,
          model: descriptor.apiConfig.model,
          apiOrigin: descriptor.apiConfig.apiOrigin,
          endpointUrl: descriptor.apiConfig.endpointUrl,
          hasApiKey: descriptor.apiConfig.hasApiKey,
          theme: getTheme(),
          resetConversation
        });
      }
    },
    dispose() {
      hostWindow.removeEventListener('message', onMessage);
      unsubscribeLocalSecrets();
      try {
        secretChannel?.close?.();
      } catch {
        // Ignore BroadcastChannel close errors.
      }
      secretChannel = null;
      for (const panelId of [...activeStreams.keys()]) {
        abortPanelStream(panelId);
      }
      panelSnapshots.clear();
    }
  };
}
