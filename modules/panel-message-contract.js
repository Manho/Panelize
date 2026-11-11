/**
 * Host <-> provider iframe `window.postMessage` contract for Multi-Panel.
 *
 * Origin and window-identity security rules enforced across all messages:
 * 1. Host -> frame: the host posts only to `getProviderFrameOrigins(providerId)`
 *    (never to `'*'`), so a frame that navigated off the provider's allowed
 *    origins receives nothing.
 * 2. Frame -> host acceptance in the content script: the provider frame accepts
 *    incoming commands only when `event.origin === chrome-extension://<id>` and
 *    `event.source === window.parent`.
 * 3. Frame -> host acceptance in the Multi-Panel host: the host accepts a frame
 *    message only when `event.source` is that panel's `iframe.contentWindow`
 *    and `event.origin` is an allowed frame origin for that panel's provider.
 *
 * Documentation-only contract in M1: shipped senders and receivers keep their
 * existing string literals and classic-script structure without importing this
 * module at runtime.
 */

function freezeContractEntry(entry) {
  return Object.freeze({
    type: entry.type,
    action: entry.action ?? null,
    direction: entry.direction,
    payloadFields: Object.freeze([...entry.payloadFields]),
    senderFiles: Object.freeze([...entry.senderFiles]),
    receiverFiles: Object.freeze([...entry.receiverFiles])
  });
}

export const HOST_TO_FRAME_MESSAGES = Object.freeze([
  freezeContractEntry({
    type: 'INJECT_TEXT',
    action: null,
    direction: 'host-to-frame',
    payloadFields: [
      'type',
      'text',
      'images',
      'autoSubmit',
      'requestId',
      'action',
      'retry',
      'providerMode',
      'context'
    ],
    senderFiles: ['multi-panel/multi-panel.js', 'modules/panel-action-results.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'INJECT_TEXT_WITH_IMAGES',
    action: 'fill',
    direction: 'host-to-frame',
    payloadFields: [
      'type',
      'text',
      'images',
      'autoSubmit',
      'requestId',
      'action',
      'retry',
      'providerMode',
      'context'
    ],
    senderFiles: ['multi-panel/multi-panel.js', 'modules/panel-action-results.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'TRIGGER_SEND',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'requestId', 'providerMode', 'context'],
    senderFiles: ['multi-panel/multi-panel.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'NEW_CHAT',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'providerMode', 'temporaryChat', 'context'],
    senderFiles: ['multi-panel/multi-panel.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'ENABLE_TEMP_CHAT',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'providerMode', 'context'],
    senderFiles: ['multi-panel/multi-panel.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'CLEAR_INPUT',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'clearImages', 'providerMode', 'context'],
    senderFiles: ['multi-panel/multi-panel.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_RESTORE_USER_FOCUS',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'context'],
    senderFiles: ['multi-panel/multi-panel.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_SNAPSHOT_PREPARE',
    action: null,
    direction: 'host-to-frame',
    payloadFields: [
      'type',
      'context',
      'requestId',
      'sessionId',
      'align',
      'prompt',
      'stitch',
      'hideFloating',
      'hideCursor'
    ],
    senderFiles: ['modules/snapshot-capture.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_SNAPSHOT_SCROLL',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'context', 'requestId', 'sessionId', 'scrollTop'],
    senderFiles: ['modules/snapshot-capture.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_SNAPSHOT_RESTORE',
    action: null,
    direction: 'host-to-frame',
    payloadFields: ['type', 'context', 'requestId', 'sessionId'],
    senderFiles: ['modules/snapshot-capture.js'],
    receiverFiles: ['content-scripts/text-injection-all-providers.js']
  })
]);

export const FRAME_TO_HOST_MESSAGES = Object.freeze([
  freezeContractEntry({
    type: 'PANELIZE_ACTION_RESULT',
    action: 'fill',
    direction: 'frame-to-host',
    payloadFields: [
      'type',
      'context',
      'requestId',
      'provider',
      'action',
      'status',
      'succeededImageIds',
      'reason'
    ],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['modules/panel-action-results.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_PROVIDER_LOCATION',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'provider', 'url', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_PAGE_WIDTH',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'provider', 'neededWidth', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_PROVIDER_BUSY',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'requestId', 'provider', 'phase', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_PROVIDER_IDLE',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'requestId', 'provider', 'phase', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_PROVIDER_USER_INTERACTION',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'requestId', 'provider', 'phase', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_TEMP_CHAT_ENABLED',
    action: null,
    direction: 'frame-to-host',
    payloadFields: ['type', 'provider', 'context'],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['multi-panel/multi-panel.js']
  }),
  freezeContractEntry({
    type: 'PANELIZE_SNAPSHOT_STATE',
    action: null,
    direction: 'frame-to-host',
    payloadFields: [
      'type',
      'context',
      'requestId',
      'sessionId',
      'provider',
      'matched',
      'alignedBy',
      'scrollTop',
      'maxScrollTop',
      'originalScrollTop',
      'clip',
      'viewport',
      'error',
      'restored'
    ],
    senderFiles: ['content-scripts/text-injection-all-providers.js'],
    receiverFiles: ['modules/snapshot-capture.js']
  })
]);
