import { API_PANEL_CONTEXT, API_PANEL_MESSAGES } from '../modules/custom-api-bridge.js';
import { renderMarkdownToFragment } from '../modules/markdown-dom.js';
import { buildOpenAiChatMessages } from '../modules/openai-chat-client.js';
import { CUSTOM_PROVIDER_ID_PATTERN } from '../modules/provider-registry.js';

const HOST_CONTEXT = 'multi-panel';
const ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
const SNAPSHOT_STATE_CONTEXT = 'multi-panel-snapshot';
const EXTENSION_ORIGIN_URL_PREFIX = /^(chrome-extension:\/\/[a-z0-9_-]+)(?:\/|$)/i;

function resolveOwnExtensionOrigin(win = window) {
  const href = win?.location?.href || '';
  const match = EXTENSION_ORIGIN_URL_PREFIX.exec(href);
  return match ? match[1] : null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(reader.error || new Error('Failed to read image')));
    reader.readAsDataURL(file);
  });
}

function normalizePromptCompareText(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

export function initApiPanel({ rootWindow = window, rootDocument = document } = {}) {
  const searchParams = new URLSearchParams(rootWindow.location?.search || '');
  const rawProviderId = searchParams.get('providerId') || '';
  const providerId = CUSTOM_PROVIDER_ID_PATTERN.test(rawProviderId) ? rawProviderId : '';
  const initialTheme = searchParams.get('theme');
  const expectedExtensionOrigin = resolveOwnExtensionOrigin(rootWindow);

  if (initialTheme === 'dark' || initialTheme === 'light') {
    rootDocument.documentElement.setAttribute('data-theme', initialTheme);
  }

  const modelBadgeEl = rootDocument.getElementById('api-model-badge');
  const originBadgeEl = rootDocument.getElementById('api-origin-badge');
  const newChatBtnEl = rootDocument.getElementById('local-new-chat-btn');
  const messagesScrollEl = rootDocument.getElementById('messages-scroll');
  const emptyStateEl = rootDocument.getElementById('empty-state');
  const emptyStateTitleEl = rootDocument.getElementById('empty-state-title');
  const messagesListEl = rootDocument.getElementById('messages-list');
  const composerFormEl = rootDocument.getElementById('composer-form');
  const stagedImagesEl = rootDocument.getElementById('staged-images');
  const imageFileInputEl = rootDocument.getElementById('image-file-input');
  const attachImageBtnEl = rootDocument.getElementById('attach-image-btn');
  const composerInputEl = rootDocument.getElementById('composer-input');
  const stopStreamBtnEl = rootDocument.getElementById('stop-stream-btn');
  const sendMsgBtnEl = rootDocument.getElementById('send-msg-btn');

  let turns = [];
  let stagedImages = [];
  let requestCounter = 0;
  let activeRequestId = null;
  let pendingRenderFrameId = null;
  let snapshotOriginalScrollTop = null;
  const supportsCssFieldSizing = Boolean(
    rootWindow.CSS?.supports?.('field-sizing', 'content')
  );

  function isTrustedHostMessage(event) {
    if (!expectedExtensionOrigin) {
      return false;
    }
    if (
      !event ||
      typeof event.origin !== 'string' ||
      event.origin === 'null' ||
      event.origin !== expectedExtensionOrigin
    ) {
      return false;
    }
    if (!rootWindow.parent || rootWindow.parent === rootWindow || event.source !== rootWindow.parent) {
      return false;
    }
    return true;
  }

  function postToHost(payload) {
    if (!expectedExtensionOrigin || !rootWindow.parent || rootWindow.parent === rootWindow) {
      return;
    }
    rootWindow.parent.postMessage(payload, expectedExtensionOrigin);
  }

  function postBridgeMessage(payload) {
    if (!providerId) {
      return;
    }
    postToHost({
      ...payload,
      context: API_PANEL_CONTEXT,
      providerId
    });
  }

  function applyThemeFromHost(theme) {
    if (theme === 'dark' || theme === 'light') {
      rootDocument.documentElement.setAttribute('data-theme', theme);
    }
  }

  function syncComposerControls() {
    const isStreaming = Boolean(activeRequestId);
    stopStreamBtnEl.hidden = !isStreaming;
    sendMsgBtnEl.hidden = isStreaming;
    const hasPayload = composerInputEl.value.trim().length > 0 || stagedImages.length > 0;
    sendMsgBtnEl.disabled = !hasPayload;

    if (!supportsCssFieldSizing) {
      composerInputEl.style.height = 'auto';
      const nextHeight = Math.min(140, Math.max(34, composerInputEl.scrollHeight || 34));
      composerInputEl.style.height = `${nextHeight}px`;
    }
  }

  function renderStagedImages() {
    stagedImagesEl.replaceChildren();
    if (stagedImages.length === 0) {
      stagedImagesEl.hidden = true;
      syncComposerControls();
      return;
    }

    stagedImagesEl.hidden = false;
    for (const img of stagedImages) {
      const itemEl = rootDocument.createElement('div');
      itemEl.className = 'staged-image-item';

      const thumbEl = rootDocument.createElement('img');
      thumbEl.src = img.dataUrl;
      thumbEl.alt = img.name || 'Attached image';

      const removeBtn = rootDocument.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'staged-image-remove-btn';
      removeBtn.setAttribute('aria-label', 'Remove image');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        stagedImages = stagedImages.filter((candidate) => candidate.id !== img.id);
        renderStagedImages();
      });

      itemEl.append(thumbEl, removeBtn);
      stagedImagesEl.appendChild(itemEl);
    }
    syncComposerControls();
  }

  function copyTextToClipboard(text, buttonEl = null, copiedLabel = 'Copied') {
    if (!rootWindow.navigator?.clipboard?.writeText) {
      return;
    }
    const originalLabel = buttonEl ? buttonEl.textContent : '';
    rootWindow.navigator.clipboard.writeText(text).then(() => {
      if (buttonEl) {
        buttonEl.textContent = copiedLabel;
        setTimeout(() => {
          buttonEl.textContent = originalLabel;
        }, 1400);
      }
    }).catch(() => {});
  }

  function scrollToBottomIfNearEnd(force = false) {
    const distanceFromBottom =
      messagesScrollEl.scrollHeight - messagesScrollEl.scrollTop - messagesScrollEl.clientHeight;
    if (force || distanceFromBottom < 96) {
      messagesScrollEl.scrollTop = messagesScrollEl.scrollHeight;
    }
  }

  function createAssistantTurnDom(turn) {
    const wrapperEl = rootDocument.createElement('div');
    wrapperEl.className = 'turn-item turn-assistant';
    wrapperEl.dataset.turnId = turn.id;
    wrapperEl.dataset.turnRole = 'assistant';

    const thinkingEl = rootDocument.createElement('details');
    thinkingEl.className = 'thinking-block';
    thinkingEl.hidden = true;
    const summaryEl = rootDocument.createElement('summary');
    summaryEl.className = 'thinking-summary';
    summaryEl.textContent = 'Reasoning';
    const thinkingPreEl = rootDocument.createElement('pre');
    thinkingPreEl.className = 'thinking-content';
    thinkingEl.append(summaryEl, thinkingPreEl);

    const streamingEl = rootDocument.createElement('div');
    streamingEl.className = 'streaming-indicator';
    const dotEl = rootDocument.createElement('span');
    dotEl.className = 'streaming-dot';
    const streamingLabelEl = rootDocument.createElement('span');
    streamingLabelEl.textContent = 'Generating...';
    streamingEl.append(dotEl, streamingLabelEl);

    const markdownEl = rootDocument.createElement('div');
    markdownEl.className = 'turn-markdown';

    const errorEl = rootDocument.createElement('div');
    errorEl.className = 'turn-error';
    errorEl.hidden = true;
    const errorTextEl = rootDocument.createElement('span');
    errorTextEl.className = 'turn-error-text';
    const retryBtnEl = rootDocument.createElement('button');
    retryBtnEl.type = 'button';
    retryBtnEl.className = 'retry-turn-btn';
    retryBtnEl.textContent = 'Retry';
    retryBtnEl.addEventListener('click', () => {
      retryAssistantTurn(turn.id);
    });
    errorEl.append(errorTextEl, retryBtnEl);

    const actionsEl = rootDocument.createElement('div');
    actionsEl.className = 'turn-actions';
    actionsEl.hidden = true;
    const copyBtnEl = rootDocument.createElement('button');
    copyBtnEl.type = 'button';
    copyBtnEl.className = 'copy-turn-btn';
    copyBtnEl.textContent = 'Copy';
    copyBtnEl.addEventListener('click', () => {
      copyTextToClipboard(turn.content, copyBtnEl);
    });
    actionsEl.appendChild(copyBtnEl);

    wrapperEl.append(thinkingEl, streamingEl, markdownEl, errorEl, actionsEl);
    turn.elements = {
      wrapperEl,
      thinkingEl,
      thinkingPreEl,
      streamingEl,
      markdownEl,
      errorEl,
      errorTextEl,
      actionsEl
    };
    updateAssistantTurnDom(turn);
    return wrapperEl;
  }

  function updateAssistantTurnDom(turn) {
    if (!turn?.elements) {
      return;
    }
    const {
      thinkingEl,
      thinkingPreEl,
      streamingEl,
      markdownEl,
      errorEl,
      errorTextEl,
      actionsEl
    } = turn.elements;

    if (turn.reasoning) {
      thinkingEl.hidden = false;
      thinkingPreEl.textContent = turn.reasoning;
    } else {
      thinkingEl.hidden = true;
      thinkingPreEl.textContent = '';
    }

    streamingEl.hidden = !(turn.streaming && !turn.content && !turn.reasoning);

    if (turn.content) {
      const fragment = renderMarkdownToFragment(turn.content, {
        document: rootDocument,
        onCopyCode(code, buttonEl) {
          copyTextToClipboard(code, buttonEl);
        }
      });
      markdownEl.replaceChildren(fragment);
    } else {
      markdownEl.replaceChildren();
    }

    if (turn.error) {
      errorEl.hidden = false;
      errorTextEl.textContent = turn.error;
    } else {
      errorEl.hidden = true;
      errorTextEl.textContent = '';
    }

    actionsEl.hidden = Boolean(turn.streaming || !turn.content);
  }

  function createUserTurnDom(turn) {
    const wrapperEl = rootDocument.createElement('div');
    wrapperEl.className = 'turn-item turn-user';
    wrapperEl.dataset.turnId = turn.id;
    wrapperEl.dataset.turnRole = 'user';
    wrapperEl.dataset.promptText = normalizePromptCompareText(turn.text);

    const bubbleEl = rootDocument.createElement('div');
    bubbleEl.className = 'turn-user-bubble';

    if (Array.isArray(turn.images) && turn.images.length > 0) {
      const imagesRowEl = rootDocument.createElement('div');
      imagesRowEl.className = 'turn-images';
      for (const img of turn.images) {
        const thumbEl = rootDocument.createElement('img');
        thumbEl.className = 'turn-image-thumb';
        thumbEl.src = img.dataUrl;
        thumbEl.alt = img.name || 'Uploaded image';
        imagesRowEl.appendChild(thumbEl);
      }
      bubbleEl.appendChild(imagesRowEl);
    }

    if (turn.text) {
      const textEl = rootDocument.createElement('p');
      textEl.className = 'turn-user-text';
      textEl.textContent = turn.text;
      bubbleEl.appendChild(textEl);
    }

    wrapperEl.appendChild(bubbleEl);
    turn.elements = { wrapperEl };
    return wrapperEl;
  }

  function syncEmptyStateVisibility() {
    const isEmpty = turns.length === 0;
    emptyStateEl.hidden = !isEmpty;
    messagesListEl.hidden = isEmpty;
  }

  function scheduleStreamingTurnUpdate(turn) {
    if (pendingRenderFrameId !== null) {
      return;
    }
    pendingRenderFrameId = rootWindow.requestAnimationFrame(() => {
      pendingRenderFrameId = null;
      updateAssistantTurnDom(turn);
      scrollToBottomIfNearEnd(false);
    });
  }

  function cancelScheduledStreamingRender() {
    if (pendingRenderFrameId !== null) {
      rootWindow.cancelAnimationFrame(pendingRenderFrameId);
      pendingRenderFrameId = null;
    }
  }

  function buildHistoryUpToAssistantTurn(assistantTurnIndex) {
    const historySlice = turns
      .slice(0, assistantTurnIndex)
      .filter((item) => item.role === 'user' || (item.role === 'assistant' && item.content));
    return buildOpenAiChatMessages(historySlice);
  }

  function startAssistantStream(assistantTurn, assistantTurnIndex) {
    requestCounter += 1;
    const requestId = `api-req-${Date.now()}-${requestCounter}`;
    activeRequestId = requestId;
    assistantTurn.requestId = requestId;
    assistantTurn.streaming = true;
    assistantTurn.error = null;
    updateAssistantTurnDom(assistantTurn);
    syncComposerControls();

    const apiMessages = buildHistoryUpToAssistantTurn(assistantTurnIndex);
    postBridgeMessage({
      type: API_PANEL_MESSAGES.CHAT_REQUEST,
      requestId,
      messages: apiMessages
    });
  }

  function submitCurrentPayload() {
    const text = composerInputEl.value.trim();
    const images = [...stagedImages];
    if (!text && images.length === 0) {
      return false;
    }

    if (activeRequestId) {
      postBridgeMessage({
        type: API_PANEL_MESSAGES.CHAT_ABORT,
        requestId: activeRequestId
      });
      const prevStreaming = turns.find((item) => item.requestId === activeRequestId);
      if (prevStreaming) {
        prevStreaming.streaming = false;
        updateAssistantTurnDom(prevStreaming);
      }
      activeRequestId = null;
    }

    composerInputEl.value = '';
    stagedImages = [];
    renderStagedImages();

    const userTurn = {
      id: `turn-user-${Date.now()}-${turns.length}`,
      role: 'user',
      text,
      images
    };
    const assistantTurn = {
      id: `turn-assistant-${Date.now()}-${turns.length + 1}`,
      role: 'assistant',
      content: '',
      reasoning: '',
      error: null,
      streaming: true,
      requestId: null
    };

    turns.push(userTurn, assistantTurn);
    syncEmptyStateVisibility();
    messagesListEl.append(createUserTurnDom(userTurn), createAssistantTurnDom(assistantTurn));
    scrollToBottomIfNearEnd(true);

    startAssistantStream(assistantTurn, turns.length - 1);
    return true;
  }

  function retryAssistantTurn(turnId) {
    const idx = turns.findIndex((item) => item.id === turnId && item.role === 'assistant');
    if (idx === -1) {
      return;
    }
    const turn = turns[idx];
    turn.content = '';
    turn.reasoning = '';
    turn.error = null;
    startAssistantStream(turn, idx);
  }

  function resetConversation() {
    cancelScheduledStreamingRender();
    if (activeRequestId) {
      postBridgeMessage({
        type: API_PANEL_MESSAGES.CHAT_ABORT,
        requestId: activeRequestId
      });
      activeRequestId = null;
    }
    turns = [];
    stagedImages = [];
    composerInputEl.value = '';
    messagesListEl.replaceChildren();
    renderStagedImages();
    syncEmptyStateVisibility();
    messagesScrollEl.scrollTop = 0;
  }

  function mergeIncomingImages(rawImages) {
    if (!Array.isArray(rawImages)) {
      return [];
    }
    const succeededIds = [];
    const existingById = new Map(stagedImages.map((img) => [img.id, img]));

    for (const raw of rawImages) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        typeof raw.dataUrl !== 'string' ||
        !raw.dataUrl.startsWith('data:image/')
      ) {
        continue;
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : `img-${Date.now()}-${Math.random()}`;
      if (!existingById.has(id)) {
        const normalized = {
          id,
          dataUrl: raw.dataUrl,
          name: typeof raw.name === 'string' ? raw.name : 'image',
          type: typeof raw.type === 'string' ? raw.type : 'image/png'
        };
        stagedImages.push(normalized);
        existingById.set(id, normalized);
      }
      succeededIds.push(id);
    }

    renderStagedImages();
    return succeededIds;
  }

  function postFillActionResult(requestId, expectedCount, succeededImageIds) {
    if (!requestId || !providerId) {
      return;
    }
    const allSucceeded = succeededImageIds.length === expectedCount;
    postToHost({
      context: ACTION_RESULT_CONTEXT,
      type: 'PANELIZE_ACTION_RESULT',
      requestId,
      provider: providerId,
      action: 'fill',
      status: allSucceeded ? 'succeeded' : 'failed',
      reason: allSucceeded ? null : 'image-upload-failed',
      succeededImageIds
    });
  }

  function buildSnapshotStatePayload(data, alignedBy = null) {
    const rect = messagesScrollEl.getBoundingClientRect();
    const scrollHeight = messagesScrollEl.scrollHeight;
    const clientHeight = messagesScrollEl.clientHeight;
    const scrollTop = messagesScrollEl.scrollTop;
    const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
    return {
      context: SNAPSHOT_STATE_CONTEXT,
      type: 'PANELIZE_SNAPSHOT_STATE',
      requestId: data.requestId,
      sessionId: data.sessionId,
      provider: providerId,
      viewport: {
        width: rootWindow.innerWidth,
        height: rootWindow.innerHeight
      },
      clip: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      },
      scrollTop,
      scrollHeight,
      clientHeight,
      maxScrollTop,
      originalScrollTop: snapshotOriginalScrollTop,
      alignedBy
    };
  }

  function handleSnapshotMessage(data) {
    if (!data.requestId) {
      return;
    }

    if (data.type === 'PANELIZE_SNAPSHOT_PREPARE') {
      if (snapshotOriginalScrollTop === null) {
        snapshotOriginalScrollTop = messagesScrollEl.scrollTop;
      }
      rootDocument.documentElement.classList.add('snapshot-capture-active');
      if (data.hideCursor) {
        rootDocument.documentElement.classList.add('snapshot-hide-cursor');
      }

      let alignedBy = null;
      const targetPrompt = normalizePromptCompareText(data.prompt);
      const userEls = [...messagesListEl.querySelectorAll('[data-turn-role="user"]')];
      let targetEl = null;

      if (data.align && targetPrompt) {
        for (let i = userEls.length - 1; i >= 0; i -= 1) {
          if (userEls[i].dataset.promptText === targetPrompt) {
            targetEl = userEls[i];
            alignedBy = 'prompt';
            break;
          }
        }
      }
      if (!targetEl && data.stitch && userEls.length > 0) {
        targetEl = userEls[userEls.length - 1];
        alignedBy = 'user-turn';
      }

      if (targetEl) {
        const scrollRect = messagesScrollEl.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        messagesScrollEl.scrollTop = Math.max(
          0,
          messagesScrollEl.scrollTop + (targetRect.top - scrollRect.top) - 8
        );
      }

      rootWindow.requestAnimationFrame(() => {
        postToHost(buildSnapshotStatePayload(data, alignedBy));
      });
      return;
    }

    if (data.type === 'PANELIZE_SNAPSHOT_SCROLL') {
      if (Number.isFinite(data.scrollTop)) {
        messagesScrollEl.scrollTop = Math.max(0, data.scrollTop);
      }
      rootWindow.requestAnimationFrame(() => {
        postToHost(buildSnapshotStatePayload(data, null));
      });
      return;
    }

    if (data.type === 'PANELIZE_SNAPSHOT_RESTORE') {
      if (snapshotOriginalScrollTop !== null) {
        messagesScrollEl.scrollTop = snapshotOriginalScrollTop;
        snapshotOriginalScrollTop = null;
      }
      rootDocument.documentElement.classList.remove(
        'snapshot-capture-active',
        'snapshot-hide-cursor'
      );
      rootWindow.requestAnimationFrame(() => {
        postToHost(buildSnapshotStatePayload(data, null));
      });
    }
  }

  function handleHostContractMessage(data) {
    if (data.providerId !== undefined && data.providerId !== providerId) {
      return;
    }

    switch (data.type) {
      case 'INJECT_TEXT': {
        composerInputEl.value = typeof data.text === 'string' ? data.text : '';
        syncComposerControls();
        if (data.action === 'fill') {
          postFillActionResult(data.requestId, 0, []);
        }
        if (data.autoSubmit) {
          submitCurrentPayload();
        }
        break;
      }
      case 'INJECT_TEXT_WITH_IMAGES': {
        if (typeof data.text === 'string') {
          composerInputEl.value = data.text;
        }
        const incomingImages = Array.isArray(data.images) ? data.images : [];
        const succeededIds = mergeIncomingImages(incomingImages);
        syncComposerControls();
        if (data.action === 'fill') {
          postFillActionResult(data.requestId, incomingImages.length, succeededIds);
        }
        if (data.autoSubmit && succeededIds.length === incomingImages.length) {
          submitCurrentPayload();
        }
        break;
      }
      case 'TRIGGER_SEND': {
        submitCurrentPayload();
        break;
      }
      case 'CLEAR_INPUT': {
        composerInputEl.value = '';
        if (data.clearImages !== false) {
          stagedImages = [];
          renderStagedImages();
        } else {
          syncComposerControls();
        }
        break;
      }
      case 'NEW_CHAT': {
        resetConversation();
        break;
      }
      case 'PANELIZE_SNAPSHOT_PREPARE':
      case 'PANELIZE_SNAPSHOT_SCROLL':
      case 'PANELIZE_SNAPSHOT_RESTORE': {
        handleSnapshotMessage(data);
        break;
      }
      default:
        break;
    }
  }

  function handleBridgeResponseMessage(data) {
    if (data.providerId !== providerId) {
      return;
    }

    switch (data.type) {
      case API_PANEL_MESSAGES.INIT: {
        if (typeof data.model === 'string' && data.model) {
          modelBadgeEl.textContent = data.model;
          modelBadgeEl.title = data.model;
        }
        if (typeof data.apiOrigin === 'string') {
          originBadgeEl.textContent = data.apiOrigin;
          originBadgeEl.title = data.endpointUrl || data.apiOrigin;
        }
        if (typeof data.name === 'string' && data.name) {
          emptyStateTitleEl.textContent = `${data.name} · ${data.model || ''}`.replace(/\s*·\s*$/, '');
        }
        applyThemeFromHost(data.theme);
        break;
      }
      case API_PANEL_MESSAGES.THEME_UPDATE: {
        applyThemeFromHost(data.theme);
        break;
      }
      case API_PANEL_MESSAGES.CHAT_DELTA: {
        const turn = turns.find((item) => item.requestId === data.requestId);
        if (!turn) {
          return;
        }
        if (typeof data.contentDelta === 'string' && data.contentDelta) {
          turn.content += data.contentDelta;
        }
        if (typeof data.reasoningDelta === 'string' && data.reasoningDelta) {
          turn.reasoning += data.reasoningDelta;
        }
        scheduleStreamingTurnUpdate(turn);
        break;
      }
      case API_PANEL_MESSAGES.CHAT_DONE: {
        cancelScheduledStreamingRender();
        const turn = turns.find((item) => item.requestId === data.requestId);
        if (activeRequestId === data.requestId) {
          activeRequestId = null;
        }
        if (turn) {
          turn.streaming = false;
          if (!data.aborted && typeof data.content === 'string' && !turn.content) {
            turn.content = data.content;
          }
          if (!data.aborted && typeof data.reasoning === 'string' && !turn.reasoning) {
            turn.reasoning = data.reasoning;
          }
          updateAssistantTurnDom(turn);
          scrollToBottomIfNearEnd(false);
        }
        syncComposerControls();
        break;
      }
      case API_PANEL_MESSAGES.CHAT_ERROR: {
        cancelScheduledStreamingRender();
        const turn = turns.find((item) => item.requestId === data.requestId);
        if (activeRequestId === data.requestId) {
          activeRequestId = null;
        }
        if (turn) {
          turn.streaming = false;
          turn.error = typeof data.message === 'string' && data.message
            ? data.message
            : 'API request failed.';
          updateAssistantTurnDom(turn);
          scrollToBottomIfNearEnd(false);
        }
        syncComposerControls();
        break;
      }
      default:
        break;
    }
  }

  function onWindowMessage(event) {
    if (!isTrustedHostMessage(event)) {
      return;
    }
    const data = event.data;
    if (!data || typeof data !== 'object') {
      return;
    }
    if (data.context === HOST_CONTEXT) {
      handleHostContractMessage(data);
      return;
    }
    if (data.context === API_PANEL_CONTEXT) {
      handleBridgeResponseMessage(data);
    }
  }

  rootWindow.addEventListener('message', onWindowMessage);

  composerInputEl.addEventListener('input', () => {
    syncComposerControls();
  });

  composerInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      event.preventDefault();
      composerFormEl.requestSubmit();
    }
  });

  composerFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    submitCurrentPayload();
  });

  stopStreamBtnEl.addEventListener('click', () => {
    if (!activeRequestId) {
      return;
    }
    const requestIdToAbort = activeRequestId;
    postBridgeMessage({
      type: API_PANEL_MESSAGES.CHAT_ABORT,
      requestId: requestIdToAbort
    });
  });

  newChatBtnEl.addEventListener('click', () => {
    resetConversation();
  });

  attachImageBtnEl.addEventListener('click', () => {
    imageFileInputEl.click();
  });

  imageFileInputEl.addEventListener('change', async () => {
    const files = [...(imageFileInputEl.files || [])];
    imageFileInputEl.value = '';
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        mergeIncomingImages([
          {
            id: `local-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            name: file.name,
            type: file.type
          }
        ]);
      } catch {
        // Ignore unreadable local file
      }
    }
  });

  syncComposerControls();
  postBridgeMessage({ type: API_PANEL_MESSAGES.READY });

  return {
    destroy() {
      cancelScheduledStreamingRender();
      rootWindow.removeEventListener('message', onWindowMessage);
    }
  };
}

if (typeof document !== 'undefined' && document.getElementById('composer-form')) {
  initApiPanel();
}
