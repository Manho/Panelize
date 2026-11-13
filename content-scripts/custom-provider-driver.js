(function () {
  'use strict';

  // Generic content-script driver for user-configured custom web providers.
  // Must remain a classic script with zero ES module imports. Implements the
  // custom-provider subset of modules/panel-message-contract.js with strict
  // extension-parent origin and framing checks.

  const DRIVER_LOADED_SYMBOL = Symbol.for('panelize.customProviderDriverLoaded');
  if (window[DRIVER_LOADED_SYMBOL]) {
    return;
  }

  const MULTI_PANEL_CONTEXT = 'multi-panel';
  const MULTI_PANEL_ACTION_RESULT_CONTEXT = 'multi-panel-action-result';
  const MULTI_PANEL_PROVIDER_STATUS_CONTEXT = 'multi-panel-provider-status';
  const MULTI_PANEL_SNAPSHOT_CONTEXT = 'multi-panel-snapshot';

  const HOST_TO_FRAME = {
    INJECT_TEXT: 'INJECT_TEXT',
    INJECT_TEXT_WITH_IMAGES: 'INJECT_TEXT_WITH_IMAGES',
    TRIGGER_SEND: 'TRIGGER_SEND',
    ENABLE_TEMP_CHAT: 'ENABLE_TEMP_CHAT',
    DISABLE_TEMP_CHAT: 'DISABLE_TEMP_CHAT',
    CLEAR_INPUT: 'CLEAR_INPUT',
    PANELIZE_RESTORE_USER_FOCUS: 'PANELIZE_RESTORE_USER_FOCUS',
    PANELIZE_CUSTOM_FRAME_PING: 'PANELIZE_CUSTOM_FRAME_PING',
    PANELIZE_SNAPSHOT_PREPARE: 'PANELIZE_SNAPSHOT_PREPARE',
    PANELIZE_SNAPSHOT_SCROLL: 'PANELIZE_SNAPSHOT_SCROLL',
    PANELIZE_SNAPSHOT_RESTORE: 'PANELIZE_SNAPSHOT_RESTORE',
  };

  const FRAME_TO_HOST = {
    PANELIZE_ACTION_RESULT: 'PANELIZE_ACTION_RESULT',
    PANELIZE_PROVIDER_LOCATION: 'PANELIZE_PROVIDER_LOCATION',
    PANELIZE_PROVIDER_USER_INTERACTION: 'PANELIZE_PROVIDER_USER_INTERACTION',
    PANELIZE_TEMP_CHAT_ENABLED: 'PANELIZE_TEMP_CHAT_ENABLED',
    PANELIZE_TEMP_CHAT_DISABLED: 'PANELIZE_TEMP_CHAT_DISABLED',
    PANELIZE_CUSTOM_FRAME_PONG: 'PANELIZE_CUSTOM_FRAME_PONG',
    PANELIZE_CUSTOM_SW_RECOVERED: 'PANELIZE_CUSTOM_SW_RECOVERED',
    PANELIZE_SNAPSHOT_STATE: 'PANELIZE_SNAPSHOT_STATE',
  };

  const SW_RECOVERY_QUERY_PARAM = '__panelize_sw_recover';

  const ACTION_FAILURE_REASONS = {
    UNSUPPORTED: 'unsupported',
    CONTROL_NOT_FOUND: 'control-not-found',
    PREVIEW_TIMEOUT: 'preview-timeout',
    INJECTION_ERROR: 'injection-error',
  };

  const MAX_TEXT_BYTES = 1048576;
  const USER_FOCUS_RESTORE_WINDOW_MS = 2000;
  const USER_INTERACTION_TRACKING_TIMEOUT_MS = 15000;

  const NEGATIVE_BUTTON_RE =
    /\b(stop|cancel|abort|attach|upload|file|image|photo|camera|voice|audio|mic|microphone|record|dictat\w*|clear|reset|delete|remove|copy|regenerate|retry|edit|new[\s_-]*chat|history|sidebar|menu|more|settings|profile|login|sign[\s_-]*in|sign[\s_-]*up|register|logout|model|provider|search|web|think|reason|tool|plus|expand|collapse|close)\b/i;

  const POSITIVE_SEND_RE =
    /\b(send|submit|run|ask|chat[\s_-]*submit|send[\s_-]*message|submit[\s_-]*button|send[\s_-]*button|send[\s_-]*prompt)\b|发送|提交|送信/i;

  const EXTENSION_ORIGIN = getExtensionOrigin();

  function getExtensionOrigin() {
    try {
      const baseUrl =
        typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getURL === 'function'
          ? chrome.runtime.getURL('')
          : '';
      const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
      return /^[a-z][a-z0-9+.-]*:\/\/[^/]+$/.test(origin) ? origin : null;
    } catch {
      return null;
    }
  }

  /**
   * Returns true only when this document is directly framed by our own extension page.
   * When unframed, nested deeper than one frame, or framed by any non-extension parent,
   * the driver stays completely inert.
   */
  function isFramedByExtensionHost() {
    if (EXTENSION_ORIGIN === null) {
      return false;
    }
    if (!window.parent || window.parent === window || window.parent !== window.top) {
      return false;
    }
    const ancestors = window.location && window.location.ancestorOrigins;
    if (ancestors && typeof ancestors.length === 'number' && ancestors.length > 0) {
      return ancestors.length === 1 && ancestors[0] === EXTENSION_ORIGIN;
    }
    return true;
  }

  function isFromMultiPanelHost(event) {
    return (
      isFramedByExtensionHost() &&
      Boolean(event) &&
      event.source === window.parent &&
      event.origin === EXTENSION_ORIGIN
    );
  }

  function postToMultiPanelHost(message) {
    if (!isFramedByExtensionHost()) {
      return;
    }
    // Never post to '*'; target strictly the extension origin.
    window.parent.postMessage(message, EXTENSION_ORIGIN);
  }

  // Bail out completely if unframed or framed by a non-extension parent.
  if (!isFramedByExtensionHost()) {
    return;
  }

  try {
    Object.defineProperty(window, DRIVER_LOADED_SYMBOL, {
      value: true,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    window[DRIVER_LOADED_SYMBOL] = true;
  }

  function getSwRecoveryProbeNonce() {
    try {
      const search = window.location && typeof window.location.search === 'string'
        ? window.location.search
        : '';
      if (!search) {
        return null;
      }
      const params = new URLSearchParams(search);
      if (!params.has(SW_RECOVERY_QUERY_PARAM)) {
        return null;
      }
      return params.get(SW_RECOVERY_QUERY_PARAM) || '';
    } catch {
      return null;
    }
  }

  function hasFramingRefusalHeaders(response) {
    if (!response || !response.headers || typeof response.headers.get !== 'function') {
      return false;
    }
    try {
      const xfo = response.headers.get('x-frame-options');
      if (typeof xfo === 'string' && xfo.trim().length > 0) {
        return true;
      }
      const csp = response.headers.get('content-security-policy') || '';
      if (/\bframe-ancestors\b/i.test(csp)) {
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async function sanitizeFramingServiceWorkerAndCaches() {
    if (!isFramedByExtensionHost()) {
      return { unregisteredCount: 0, deletedCacheEntries: 0 };
    }

    let unregisteredCount = 0;
    let deletedCacheEntries = 0;

    try {
      const swContainer = window.navigator && window.navigator.serviceWorker;
      if (swContainer && typeof swContainer.getRegistrations === 'function') {
        const registrations = await swContainer.getRegistrations();
        if (Array.isArray(registrations)) {
          for (let i = 0; i < registrations.length; i += 1) {
            const reg = registrations[i];
            if (reg && typeof reg.unregister === 'function') {
              try {
                if (await reg.unregister()) {
                  unregisteredCount += 1;
                }
              } catch {
                // Ignore individual unregister errors.
              }
            }
          }
        }
      }
    } catch {
      // Ignore environments where serviceWorker is restricted.
    }

    try {
      const cacheStorage = window.caches;
      if (cacheStorage && typeof cacheStorage.keys === 'function' && typeof cacheStorage.open === 'function') {
        const cacheNames = await cacheStorage.keys();
        if (Array.isArray(cacheNames)) {
          for (let i = 0; i < cacheNames.length; i += 1) {
            try {
              const cache = await cacheStorage.open(cacheNames[i]);
              if (!cache || typeof cache.keys !== 'function' || typeof cache.match !== 'function') {
                continue;
              }
              const requests = await cache.keys();
              if (!Array.isArray(requests)) {
                continue;
              }
              const nonDocumentAssetRe =
                /\.(?:js|mjs|cjs|css|map|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|ico|mp3|mp4|webm|ogg|wav|wasm)(?:$|[?#])/i;
              for (let j = 0; j < requests.length; j += 1) {
                const req = requests[j];
                const reqUrl = typeof req === 'string' ? req : (req && req.url) || '';
                if (reqUrl && nonDocumentAssetRe.test(reqUrl)) {
                  continue;
                }
                const res = await cache.match(req);
                if (hasFramingRefusalHeaders(res) && typeof cache.delete === 'function') {
                  if (await cache.delete(req)) {
                    deletedCacheEntries += 1;
                  }
                }
              }
            } catch {
              // Ignore individual CacheStorage errors.
            }
          }
        }
      }
    } catch {
      // Ignore environments where CacheStorage is unavailable.
    }

    return { unregisteredCount, deletedCacheEntries };
  }

  const swRecoveryNonce = getSwRecoveryProbeNonce();
  if (swRecoveryNonce !== null) {
    void sanitizeFramingServiceWorkerAndCaches().then((summary) => {
      postToMultiPanelHost({
        type: FRAME_TO_HOST.PANELIZE_CUSTOM_SW_RECOVERED,
        nonce: swRecoveryNonce,
        origin: window.location ? window.location.origin : '',
        unregisteredCount: summary.unregisteredCount,
        deletedCacheEntries: summary.deletedCacheEntries,
        context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT,
      });
    });
    return;
  }

  let knownProviderId = null;
  let lastReportedUrl = null;
  let lastUserFocus = null;
  let userInteractionTracking = null;

  function resolveProviderId(eventData) {
    if (eventData && typeof eventData.providerId === 'string' && eventData.providerId.length > 0) {
      knownProviderId = eventData.providerId;
      return eventData.providerId;
    }
    if (eventData && typeof eventData.provider === 'string' && eventData.provider.length > 0) {
      knownProviderId = eventData.provider;
      return eventData.provider;
    }
    return knownProviderId;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===== Location & Focus-Handback Reporting =====

  function reportLocationIfChanged(force = false) {
    if (!knownProviderId) {
      // Wait until we learn the panel's providerId so multi-panel.js's
      // `data.provider === panel.providerId` check matches.
      return;
    }
    const currentUrl = window.location.href;
    if (!force && currentUrl === lastReportedUrl) {
      return;
    }
    lastReportedUrl = currentUrl;
    postToMultiPanelHost({
      type: FRAME_TO_HOST.PANELIZE_PROVIDER_LOCATION,
      provider: knownProviderId,
      url: currentUrl,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT,
    });
  }

  function setupLocationReporting() {
    const wrapHistory = (methodName) => {
      const original = window.history && window.history[methodName];
      if (typeof original !== 'function') return;
      try {
        window.history[methodName] = function (...args) {
          const res = original.apply(this, args);
          setTimeout(() => reportLocationIfChanged(false), 0);
          return res;
        };
      } catch {
        // Ignore non-configurable history properties.
      }
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', () => reportLocationIfChanged(false));
    window.addEventListener('hashchange', () => reportLocationIfChanged(false));
  }

  function rememberUserFocus(triggerEvent) {
    const fallbackTarget =
      normalizeEditingHost(triggerEvent && triggerEvent.target) ||
      (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
    const entry = { element: fallbackTarget, at: Date.now() };
    lastUserFocus = entry;
    const captureFocus = (ev) => {
      if (lastUserFocus === entry && ev && ev.target) {
        entry.element = ev.target;
      }
    };
    document.addEventListener('focusin', captureFocus, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('focusin', captureFocus, true), USER_FOCUS_RESTORE_WINDOW_MS);
  }

  function restoreUserFocus() {
    const entry = lastUserFocus;
    lastUserFocus = null;
    if (!entry || !entry.element || !entry.element.isConnected) {
      return false;
    }
    if (Date.now() - entry.at > USER_FOCUS_RESTORE_WINDOW_MS) {
      return false;
    }
    try {
      entry.element.focus({ preventScroll: true });
    } catch {
      entry.element.focus();
    }
    return true;
  }

  function stopUserInteractionTracking() {
    const tracking = userInteractionTracking;
    if (!tracking) return;
    if (typeof tracking.timeoutId === 'number') {
      clearTimeout(tracking.timeoutId);
    }
    if (tracking.handler) {
      document.removeEventListener('pointerdown', tracking.handler, true);
      document.removeEventListener('keydown', tracking.handler, true);
    }
    userInteractionTracking = null;
  }

  function startUserInteractionTracking(requestId, providerId) {
    if (!requestId || !providerId) return;
    stopUserInteractionTracking();
    const tracking = {
      requestId,
      providerId,
      timeoutId: null,
      handler: null,
    };
    tracking.handler = (ev) => {
      if (userInteractionTracking !== tracking || !ev.isTrusted) {
        return;
      }
      rememberUserFocus(ev);
      postToMultiPanelHost({
        type: FRAME_TO_HOST.PANELIZE_PROVIDER_USER_INTERACTION,
        requestId: tracking.requestId,
        provider: tracking.providerId,
        status: 'user-interaction',
        context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT,
      });
      stopUserInteractionTracking();
    };
    document.addEventListener('pointerdown', tracking.handler, true);
    document.addEventListener('keydown', tracking.handler, true);
    tracking.timeoutId = setTimeout(() => {
      if (userInteractionTracking === tracking) {
        stopUserInteractionTracking();
      }
    }, USER_INTERACTION_TRACKING_TIMEOUT_MS);
    userInteractionTracking = tracking;
  }

  function postActionResult(requestId, providerId, result) {
    if (!requestId || !providerId) return;
    const message = {
      type: FRAME_TO_HOST.PANELIZE_ACTION_RESULT,
      context: MULTI_PANEL_ACTION_RESULT_CONTEXT,
      requestId,
      provider: providerId,
      action: 'fill',
      status: result.ok ? 'succeeded' : 'failed',
    };
    if (Array.isArray(result.succeededImageIds)) {
      message.succeededImageIds = result.succeededImageIds;
    }
    if (!result.ok) {
      message.reason = result.reason || ACTION_FAILURE_REASONS.INJECTION_ERROR;
    }
    postToMultiPanelHost(message);
  }

  // ===== Generic DOM Discovery (Light DOM + Open Shadow DOM) =====

  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    const visited = new Set();
    const walk = (node) => {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (typeof node.querySelectorAll === 'function') {
        const matched = node.querySelectorAll(selector);
        for (let i = 0; i < matched.length; i += 1) {
          results.push(matched[i]);
        }
        const all = node.querySelectorAll('*');
        for (let i = 0; i < all.length; i += 1) {
          if (all[i].shadowRoot) {
            walk(all[i].shadowRoot);
          }
        }
      }
    };
    walk(root);
    return results;
  }

  function getDeepActiveElement() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      parseFloat(style.opacity || '1') === 0 ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width >= 16 && rect.height >= 14 && rect.bottom > 0 && rect.right > 0;
  }

  function isEditableEnabled(el) {
    if (!el || !isVisible(el)) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute('aria-disabled') === 'true' || el.getAttribute('aria-readonly') === 'true') {
      return false;
    }
    return true;
  }

  function normalizeEditingHost(el) {
    if (!el) return null;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el;
    }
    if (el.isContentEditable || el.getAttribute?.('contenteditable') === 'true' || el.getAttribute?.('contenteditable') === '' || el.getAttribute?.('contenteditable') === 'plaintext-only') {
      let host = el;
      while (
        host.parentElement &&
        (host.parentElement.isContentEditable ||
          host.parentElement.getAttribute?.('contenteditable') === 'true' ||
          host.parentElement.getAttribute?.('contenteditable') === '' ||
          host.parentElement.getAttribute?.('contenteditable') === 'plaintext-only')
      ) {
        host = host.parentElement;
      }
      return host;
    }
    return null;
  }

  function isContentEditableElement(el) {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const attr = el.getAttribute?.('contenteditable');
    return attr === 'true' || attr === '' || attr === 'plaintext-only';
  }

  function isNonChatSearchOrAuthField(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password' || type === 'email' || type === 'search' || type === 'file' || type === 'number') {
      return true;
    }
    const attrs = [
      el.id || '',
      el.getAttribute('name') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
    ]
      .join(' ')
      .toLowerCase();
    return /\b(search\s*chats|search\s*conversations|filter|username|password|email)\b/.test(attrs);
  }

  /**
   * Finds the primary chat composer using generic heuristics:
   * 1. Visible, enabled <textarea> or [contenteditable], preferring the focused one;
   * 2. Otherwise preferring full-width composers and then the bottom-most / largest one.
   */
  function findComposerElement() {
    const rawCandidates = querySelectorAllDeep(
      'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"][contenteditable]'
    );

    const seen = new Set();
    const candidates = [];
    for (let i = 0; i < rawCandidates.length; i += 1) {
      const host = normalizeEditingHost(rawCandidates[i]);
      if (!host || seen.has(host)) continue;
      seen.add(host);
      if (host.getAttribute('contenteditable') === 'false') continue;
      if (!isEditableEnabled(host)) continue;
      const rect = host.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 16) continue;
      if (isNonChatSearchOrAuthField(host)) continue;
      candidates.push({ el: host, rect });
    }

    if (candidates.length === 0) {
      // Fallback to text inputs only when no textarea or contenteditable exists.
      const textInputs = querySelectorAllDeep('input[type="text"], input:not([type])');
      for (let i = 0; i < textInputs.length; i += 1) {
        const input = textInputs[i];
        if (!isEditableEnabled(input) || isNonChatSearchOrAuthField(input)) continue;
        const rect = input.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 16) {
          candidates.push({ el: input, rect });
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    const activeHost = normalizeEditingHost(getDeepActiveElement());
    if (activeHost) {
      const focusedCandidate = candidates.find((c) => c.el === activeHost || c.el.contains(activeHost));
      if (focusedCandidate) {
        return focusedCandidate.el;
      }
    }

    const viewportWidth = document.documentElement.clientWidth || window.innerWidth || 800;
    const hasWideCandidate = candidates.some((c) => c.rect.width >= viewportWidth * 0.3);
    const pool = hasWideCandidate
      ? candidates.filter((c) => c.rect.width >= viewportWidth * 0.25)
      : candidates;

    pool.sort((a, b) => {
      // Bucket bottom coordinate by 20px bands so elements on the same bar break ties by area/width.
      const bottomBandA = Math.round(a.rect.bottom / 20);
      const bottomBandB = Math.round(b.rect.bottom / 20);
      if (bottomBandA !== bottomBandB) {
        return bottomBandB - bottomBandA;
      }
      const areaA = a.rect.width * Math.min(a.rect.height, 240);
      const areaB = b.rect.width * Math.min(b.rect.height, 240);
      return areaB - areaA;
    });

    return pool[0].el;
  }

  // ===== Framework-Compatible Text Insertion & Clearing =====

  function getComposerText(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      return el.value || '';
    }
    return (el.innerText ?? el.textContent ?? '').replace(/\u200B/g, '');
  }

  function isComposerEmpty(el) {
    return getComposerText(el).trim().length === 0;
  }

  function setFormControlValue(el, nextValue, insertedChunk = '') {
    const previousValue = el.value || '';
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }

    try {
      el.dispatchEvent(
        new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: nextValue === '' ? 'deleteContentBackward' : 'insertText',
          data: nextValue === '' ? null : insertedChunk || nextValue,
        })
      );
    } catch {
      // Ignore environments without InputEvent constructor options.
    }

    const proto =
      el.tagName === 'INPUT' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
    const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : undefined;
    if (nativeSetter) {
      nativeSetter.call(el, nextValue);
    } else {
      el.value = nextValue;
    }

    // Reset React's internal _valueTracker when present so controlled inputs observe the change.
    if (el._valueTracker && typeof el._valueTracker.setValue === 'function') {
      try {
        el._valueTracker.setValue(previousValue);
      } catch {
        // Ignore tracker errors.
      }
    }

    try {
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          composed: true,
          inputType: nextValue === '' ? 'deleteContentBackward' : 'insertText',
          data: nextValue === '' ? null : insertedChunk || nextValue,
        })
      );
    } catch {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    if (typeof el.setSelectionRange === 'function') {
      try {
        el.setSelectionRange(nextValue.length, nextValue.length);
      } catch {
        // Some input types do not support selection ranges.
      }
    }
  }

  function moveCaretToEnd(el) {
    try {
      const selection = window.getSelection();
      if (!selection) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {
      // Ignore selection errors.
    }
  }

  function selectAllInElement(el) {
    try {
      const selection = window.getSelection();
      if (!selection) return false;
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch {
      return false;
    }
  }

  function collapseComposerWhitespace(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function hasAcceptedInjectedText(beforeRaw, afterRaw, injectedText) {
    if (afterRaw === beforeRaw) {
      return false;
    }
    const trimmedInjected = String(injectedText || '').trim();
    if (trimmedInjected.length === 0) {
      return afterRaw.length > beforeRaw.length;
    }
    const collapsedBefore = collapseComposerWhitespace(beforeRaw);
    const collapsedAfter = collapseComposerWhitespace(afterRaw);
    const collapsedInjected = collapseComposerWhitespace(injectedText);
    const containsInjected =
      afterRaw.includes(trimmedInjected) || collapsedAfter.includes(collapsedInjected);
    if (!containsInjected) {
      return false;
    }
    if (beforeRaw.includes(trimmedInjected) || collapsedBefore.includes(collapsedInjected)) {
      return collapsedAfter.length > collapsedBefore.length || afterRaw.length > beforeRaw.length;
    }
    return true;
  }

  async function waitForAcceptedInjectedText(el, beforeRaw, text) {
    if (hasAcceptedInjectedText(beforeRaw, getComposerText(el), text)) {
      return true;
    }
    await sleep(25);
    if (hasAcceptedInjectedText(beforeRaw, getComposerText(el), text)) {
      return true;
    }
    await sleep(25);
    return hasAcceptedInjectedText(beforeRaw, getComposerText(el), text);
  }

  async function injectIntoContentEditable(el, text) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
    moveCaretToEnd(el);

    const beforeRaw = getComposerText(el);
    let controlledCancelObserved = false;

    // Primary strategy: execCommand('insertText') fires native beforeinput + mutates DOM + fires input,
    // which ProseMirror, TipTap, Lexical, Quill, and Svelte/React contenteditables observe.
    // Note: Lexical/Slate call preventDefault() on beforeinput and reconcile the DOM asynchronously
    // in a microtask, so we observe beforeinput and verify actual text acceptance after reconciliation.
    let execSucceeded = false;
    let beforeInputObserved = false;
    let beforeInputCancelled = false;
    const onBeforeInput = (evt) => {
      if (evt && (evt.target === el || el.contains(evt.target))) {
        beforeInputObserved = true;
        if (evt.defaultPrevented) {
          beforeInputCancelled = true;
        }
      }
    };
    document.addEventListener('beforeinput', onBeforeInput);
    try {
      execSucceeded = document.execCommand('insertText', false, text);
    } catch {
      execSucceeded = false;
    } finally {
      document.removeEventListener('beforeinput', onBeforeInput);
    }

    if (execSucceeded && hasAcceptedInjectedText(beforeRaw, getComposerText(el), text)) {
      moveCaretToEnd(el);
      return true;
    }

    if (beforeInputCancelled || beforeInputObserved || execSucceeded) {
      if (await waitForAcceptedInjectedText(el, beforeRaw, text)) {
        moveCaretToEnd(el);
        return true;
      }
      if (getComposerText(el) !== beforeRaw) {
        moveCaretToEnd(el);
        return true;
      }
      if (beforeInputCancelled) {
        controlledCancelObserved = true;
      }
    } else if (getComposerText(el) !== beforeRaw) {
      moveCaretToEnd(el);
      return true;
    }

    // Fallback 1: synthetic ClipboardEvent('paste') for editors that ignore execCommand.
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        composed: true,
        clipboardData: dataTransfer,
      });
      const notCancelled = el.dispatchEvent(pasteEvent);
      if (!notCancelled) {
        if (await waitForAcceptedInjectedText(el, beforeRaw, text)) {
          moveCaretToEnd(el);
          return true;
        }
        if (getComposerText(el) !== beforeRaw) {
          moveCaretToEnd(el);
          return true;
        }
        controlledCancelObserved = true;
      } else if (
        hasAcceptedInjectedText(beforeRaw, getComposerText(el), text) ||
        getComposerText(el) !== beforeRaw
      ) {
        moveCaretToEnd(el);
        return true;
      }
    } catch {
      // Ignore ClipboardEvent construction errors.
    }

    // Fallback 2: cancelable beforeinput + uncontrolled DOM text node fallback.
    try {
      const beforeInput = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: 'insertText',
        data: text,
      });
      const notCancelled = el.dispatchEvent(beforeInput);
      if (!notCancelled) {
        if (await waitForAcceptedInjectedText(el, beforeRaw, text)) {
          moveCaretToEnd(el);
          return true;
        }
        if (getComposerText(el) !== beforeRaw) {
          moveCaretToEnd(el);
          return true;
        }
        controlledCancelObserved = true;
      } else if (
        hasAcceptedInjectedText(beforeRaw, getComposerText(el), text) ||
        getComposerText(el) !== beforeRaw
      ) {
        moveCaretToEnd(el);
        return true;
      }
    } catch {
      // Ignore.
    }

    // Never force raw DOM text mutation past a controlled editor's explicit preventDefault() rejection.
    if (controlledCancelObserved) {
      return false;
    }

    el.appendChild(document.createTextNode(text));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    moveCaretToEnd(el);
    return hasAcceptedInjectedText(beforeRaw, getComposerText(el), text);
  }

  async function injectTextIntoComposer(composer, text, { skipIfAlreadyPresent = false } = {}) {
    if (!composer || typeof text !== 'string' || text.length === 0) {
      return false;
    }
    const existing = getComposerText(composer);
    if (skipIfAlreadyPresent && existing.trimEnd().endsWith(text.trimEnd())) {
      return true;
    }

    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      const beforeVal = composer.value || '';
      const nextValue = beforeVal + text;
      setFormControlValue(composer, nextValue, text);
      return hasAcceptedInjectedText(beforeVal, composer.value || '', text);
    }

    if (isContentEditableElement(composer)) {
      return injectIntoContentEditable(composer, text);
    }

    return false;
  }

  function dispatchCancelableBeforeInput(el, inputType, data = null) {
    try {
      const ev = new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType,
        data,
      });
      return !el.dispatchEvent(ev);
    } catch {
      return false;
    }
  }

  async function settleControlledContentEditableClear(composer) {
    await sleep(30);
    if (!composer.isConnected || isComposerEmpty(composer)) {
      return;
    }

    // Editors like Lexical sync internal RangeSelection asynchronously on document 'selectionchange'.
    selectAllInElement(composer);
    try {
      document.dispatchEvent(new Event('selectionchange'));
    } catch {
      // Ignore.
    }
    await sleep(35);
    if (!composer.isConnected || isComposerEmpty(composer)) {
      return;
    }

    try {
      document.execCommand('delete', false, null);
    } catch {
      // Ignore.
    }
    await sleep(25);
    if (!composer.isConnected || isComposerEmpty(composer)) {
      return;
    }

    selectAllInElement(composer);
    try {
      document.dispatchEvent(new Event('selectionchange'));
    } catch {
      // Ignore.
    }
    await sleep(20);
    dispatchCancelableBeforeInput(composer, 'deleteContentBackward');
    await sleep(25);

    if (composer.isConnected && !isComposerEmpty(composer)) {
      composer.innerHTML = '';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function clearComposer(composer) {
    if (!composer) return false;

    if (composer.tagName === 'TEXTAREA' || composer.tagName === 'INPUT') {
      setFormControlValue(composer, '');
      return true;
    }

    if (isContentEditableElement(composer)) {
      try {
        composer.focus({ preventScroll: true });
      } catch {
        composer.focus();
      }

      let beforeInputHandled = false;
      const onBeforeInput = (evt) => {
        if (evt && (evt.target === composer || composer.contains(evt.target)) && evt.defaultPrevented) {
          beforeInputHandled = true;
        }
      };
      document.addEventListener('beforeinput', onBeforeInput);

      try {
        selectAllInElement(composer);
        try {
          document.dispatchEvent(new Event('selectionchange'));
        } catch {
          // Ignore.
        }
        try {
          document.execCommand('delete', false, null);
        } catch {
          // Ignore.
        }

        if (!isComposerEmpty(composer) && !beforeInputHandled) {
          selectAllInElement(composer);
          try {
            document.execCommand('insertText', false, '');
          } catch {
            // Ignore.
          }
        }

        if (!isComposerEmpty(composer) && !beforeInputHandled) {
          if (dispatchCancelableBeforeInput(composer, 'deleteContentBackward')) {
            beforeInputHandled = true;
          }
        }
      } finally {
        document.removeEventListener('beforeinput', onBeforeInput);
      }

      if (!isComposerEmpty(composer) && !beforeInputHandled) {
        composer.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Backspace',
            code: 'Backspace',
            keyCode: 8,
            which: 8,
            bubbles: true,
            cancelable: true,
            composed: true,
          })
        );
      }

      if (beforeInputHandled) {
        // Avoid synchronous innerHTML wipe that triggers Lexical/Slate MutationObserver revert;
        // let microtasks + selectionchange settle cleanly instead.
        void settleControlledContentEditableClear(composer);
        return true;
      }

      if (!isComposerEmpty(composer)) {
        composer.innerHTML = '';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        composer.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    }

    return false;
  }

  // ===== Generic Send Button Discovery & Enter Fallback =====

  function isButtonEnabled(btn) {
    if (!btn || !isVisible(btn)) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    if (btn.classList && (btn.classList.contains('disabled') || btn.classList.contains('is-disabled'))) {
      return false;
    }
    return true;
  }

  function getButtonDescriptorText(btn) {
    return [
      btn.id || '',
      btn.getAttribute('name') || '',
      btn.getAttribute('data-testid') || '',
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      btn.getAttribute('mattooltip') || '',
      (btn.textContent || '').trim(),
      typeof btn.className === 'string' ? btn.className : '',
    ]
      .join(' ')
      .trim();
  }

  function isNegativeActionButton(btn) {
    const desc = getButtonDescriptorText(btn);
    if (NEGATIVE_BUTTON_RE.test(desc) && !POSITIVE_SEND_RE.test(desc)) {
      return true;
    }
    // Avoid stop/cancel buttons even if class name still includes "send-button".
    const labelOnly = [
      btn.getAttribute('aria-label') || '',
      btn.getAttribute('title') || '',
      (btn.textContent || '').trim(),
    ].join(' ');
    if (/\b(stop|cancel|abort)\b/i.test(labelOnly)) {
      return true;
    }
    if (btn.getAttribute('aria-haspopup') === 'menu' || btn.getAttribute('aria-haspopup') === 'listbox') {
      return true;
    }
    return false;
  }

  function collectComposerScopes(composer) {
    const scopes = [];
    const form = composer.closest && composer.closest('form');
    if (form) {
      scopes.push({ node: form, rect: form.getBoundingClientRect() });
    }

    const maxContainerHeight = Math.max(360, (window.innerHeight || 800) * 0.6);
    let current = composer;
    let depth = 0;
    while (current && depth < 7) {
      let next = current.parentElement;
      if (!next) {
        const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
        if (root && root.host) {
          const hostRect = root.host.getBoundingClientRect();
          if (hostRect.height <= maxContainerHeight && !scopes.some((s) => s.node === root)) {
            scopes.push({ node: root, rect: hostRect });
          }
          next = root.host;
        }
      }
      if (!next || next === document.body || next === document.documentElement) {
        break;
      }
      const rect = next.getBoundingClientRect();
      if (rect.height <= maxContainerHeight && !scopes.some((s) => s.node === next)) {
        scopes.push({ node: next, rect });
      }
      current = next;
      depth += 1;
    }

    return scopes;
  }

  function findSendButtonNearComposer(composer) {
    if (!composer) return null;

    const scopes = collectComposerScopes(composer);

    // Pass 1: Explicit submit button in form or tight ancestor scope.
    for (let i = 0; i < scopes.length; i += 1) {
      const submitBtns = querySelectorAllDeep('button[type="submit"], input[type="submit"]', scopes[i].node);
      for (let j = 0; j < submitBtns.length; j += 1) {
        const btn = submitBtns[j];
        if (isButtonEnabled(btn) && !isNegativeActionButton(btn)) {
          return btn;
        }
      }
    }

    // Pass 2: Button matching send/submit/run aria-label, title, testid, id, or text.
    for (let i = 0; i < scopes.length; i += 1) {
      const buttons = querySelectorAllDeep('button, [role="button"]', scopes[i].node);
      for (let j = 0; j < buttons.length; j += 1) {
        const btn = buttons[j];
        if (!isButtonEnabled(btn) || isNegativeActionButton(btn)) continue;
        if (POSITIVE_SEND_RE.test(getButtonDescriptorText(btn))) {
          return btn;
        }
      }
    }

    // Pass 3: Last enabled non-negative button in a tight composer container (<= 240px tall).
    for (let i = 0; i < scopes.length; i += 1) {
      if (scopes[i].rect.height > 240) continue;
      const buttons = querySelectorAllDeep('button', scopes[i].node).filter(
        (btn) => isButtonEnabled(btn) && !isNegativeActionButton(btn)
      );
      if (buttons.length > 0) {
        return buttons[buttons.length - 1];
      }
    }

    return null;
  }

  function dispatchEnterKeySequence(composer) {
    if (!composer) return false;
    try {
      composer.focus({ preventScroll: true });
    } catch {
      composer.focus();
    }
    const init = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      charCode: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    const kd = new KeyboardEvent('keydown', init);
    const notCancelled = composer.dispatchEvent(kd);
    if (notCancelled) {
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
    }
    composer.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
  }

  async function triggerSendWithSettle(composer, { waitForEnabledMs = 0 } = {}) {
    const targetComposer = composer || findComposerElement();
    if (!targetComposer) {
      return { ok: false, method: 'none', reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND };
    }

    let sendBtn = findSendButtonNearComposer(targetComposer);
    if (!sendBtn && waitForEnabledMs > 0) {
      const deadline = Date.now() + waitForEnabledMs;
      while (Date.now() < deadline && !sendBtn) {
        await sleep(60);
        const refreshedComposer = targetComposer.isConnected ? targetComposer : findComposerElement();
        sendBtn = findSendButtonNearComposer(refreshedComposer);
      }
    }

    const activeComposer = targetComposer.isConnected ? targetComposer : findComposerElement();
    if (sendBtn && isButtonEnabled(sendBtn)) {
      sendBtn.click();
      return { ok: true, method: 'button' };
    }

    if (activeComposer) {
      dispatchEnterKeySequence(activeComposer);
      return { ok: true, method: 'enter-fallback' };
    }

    return { ok: false, method: 'none', reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND };
  }

  async function findComposerWithRetry(maxWaitMs = 1000) {
    let composer = findComposerElement();
    if (composer || maxWaitMs <= 0) {
      return composer;
    }
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline && !composer) {
      await sleep(100);
      composer = findComposerElement();
    }
    return composer;
  }

  // ===== Temporary Chat / Incognito Toggle Discovery =====

  const TEMP_CHAT_EXIT_RE =
    /\b(exit|leave|disable|turn\s*off|stop|end|deactivate)\s+(temporary(\s*(chat|session|conversation|mode))?|incognito(\s*mode)?|private\s*(chat|mode|session)|ephemeral(\s*chat)?|ghost\s*mode)\b|(退出|关闭|停用|结束)(临时(对话|聊天|会话|模式)?|无痕(模式|对话|聊天)?|隐身(模式|对话|聊天)?|私密(对话|聊天|模式)?)/i;

  const TEMP_CHAT_ENTER_RE =
    /\b(use|enable|turn\s*on|enter|start|activate)\s+(temporary(\s*(chat|session|conversation|mode))?|incognito(\s*mode)?|private\s*(chat|mode|session)|ephemeral(\s*chat)?|ghost\s*mode)\b|(开启|启用|使用|进入)(临时(对话|聊天|会话|模式)?|无痕(模式|对话|聊天)?|隐身(模式|对话|聊天)?|私密(对话|聊天|模式)?)/i;

  const TEMP_CHAT_NEUTRAL_RE =
    /\b(temporary[\s_-]*(chat|session|conversation|mode)|incognito([\s_-]*mode)?|private[\s_-]*(chat|mode|session)|ephemeral[\s_-]*chat|ghost[\s_-]*mode)\b|临时(对话|聊天|会话|模式)|无痕(模式|对话|聊天)|隐身(模式|对话|聊天)|私密(对话|聊天|模式)/i;

  let neutralTempChatClickedOnDocument = false;

  function hasUrlOrCookieTempChatActive() {
    try {
      const search = window.location && typeof window.location.search === 'string'
        ? window.location.search
        : '';
      if (search) {
        const params = new URLSearchParams(search);
        if (
          params.get('temporary-chat') === 'true' ||
          params.get('temporary') === 'true' ||
          params.get('incognito') === 'true'
        ) {
          return true;
        }
      }
    } catch {
      // Ignore URL parsing errors.
    }
    try {
      const cookieStr = typeof document.cookie === 'string' ? document.cookie : '';
      if (/(?:^|;\s*)pplx\.is-incognito=true(?:;|$)/i.test(cookieStr)) {
        return true;
      }
    } catch {
      // Ignore cookie access errors.
    }
    return false;
  }

  function getTempChatCandidateLabel(el) {
    const shortText = ((el.textContent || '').trim().length <= 80 ? (el.textContent || '').trim() : '');
    return [
      el.id || '',
      el.getAttribute('name') || '',
      el.getAttribute('data-testid') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
      el.getAttribute('mattooltip') || '',
      shortText,
    ]
      .join(' ')
      .trim();
  }

  function isEligibleTempChatControl(el) {
    if (!el || el.tagName === 'A') {
      return false;
    }
    if (typeof el.closest === 'function') {
      if (
        el.closest(
          'a[href], [data-composer="true"], [role="article"], article, .prose, .markdown'
        )
      ) {
        return false;
      }
    }
    if (el.tagName === 'INPUT' && el.type === 'checkbox') {
      return !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    }
    return isButtonEnabled(el);
  }

  function inspectTempChatState() {
    const candidates = querySelectorAllDeep(
      'button, [role="button"], [role="switch"], input[type="checkbox"]',
      document
    ).filter(isEligibleTempChatControl);

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      const label = getTempChatCandidateLabel(el);
      if (TEMP_CHAT_EXIT_RE.test(label)) {
        return { status: 'active', control: el, hasExplicitState: true };
      }
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      const label = getTempChatCandidateLabel(el);
      if (TEMP_CHAT_ENTER_RE.test(label)) {
        return { status: 'inactive', control: el, hasExplicitState: true };
      }
    }

    for (let i = 0; i < candidates.length; i += 1) {
      const el = candidates[i];
      const label = getTempChatCandidateLabel(el);
      if (!TEMP_CHAT_NEUTRAL_RE.test(label)) {
        continue;
      }

      if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        return {
          status: el.checked ? 'active' : 'inactive',
          control: el,
          hasExplicitState: true,
        };
      }

      const ariaPressed = el.getAttribute('aria-pressed');
      const ariaChecked = el.getAttribute('aria-checked');
      const dataState = (el.getAttribute('data-state') || '').toLowerCase();
      const dataActive = el.getAttribute('data-active');

      if (
        ariaPressed === 'true' ||
        ariaChecked === 'true' ||
        dataState === 'checked' ||
        dataState === 'on' ||
        dataActive === 'true'
      ) {
        return { status: 'active', control: el, hasExplicitState: true };
      }

      if (
        ariaPressed === 'false' ||
        ariaChecked === 'false' ||
        dataState === 'unchecked' ||
        dataState === 'off' ||
        dataActive === 'false'
      ) {
        return { status: 'inactive', control: el, hasExplicitState: true };
      }

      if (el.classList && (el.classList.contains('active') || el.classList.contains('is-active'))) {
        return { status: 'active', control: el, hasExplicitState: true };
      }

      if (hasUrlOrCookieTempChatActive()) {
        return { status: 'active', control: el, hasExplicitState: true };
      }

      if (neutralTempChatClickedOnDocument) {
        return { status: 'active', control: el, hasExplicitState: false };
      }

      return { status: 'inactive', control: el, hasExplicitState: false };
    }

    return { status: 'missing', control: null, hasExplicitState: false };
  }

  function postTempChatStatus(type, providerId) {
    if (!providerId) {
      return;
    }
    postToMultiPanelHost({
      type,
      provider: providerId,
      context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT,
    });
  }

  async function handleEnableTempChat(providerId) {
    const initial = inspectTempChatState();
    if (initial.status === 'active') {
      postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_ENABLED, providerId);
      return;
    }
    if (initial.status !== 'inactive' || !initial.control) {
      return;
    }

    initial.control.click();

    if (!initial.hasExplicitState) {
      neutralTempChatClickedOnDocument = true;
      await sleep(60);
      postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_ENABLED, providerId);
      return;
    }

    const deadline = Date.now() + 220;
    while (Date.now() < deadline) {
      await sleep(40);
      if (inspectTempChatState().status === 'active') {
        postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_ENABLED, providerId);
        return;
      }
    }
  }

  async function handleDisableTempChat(providerId) {
    const initial = inspectTempChatState();
    if (initial.status === 'inactive') {
      postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_DISABLED, providerId);
      return;
    }
    if (initial.status !== 'active' || !initial.control) {
      return;
    }

    initial.control.click();
    neutralTempChatClickedOnDocument = false;

    if (!initial.hasExplicitState) {
      await sleep(60);
      postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_DISABLED, providerId);
      return;
    }

    const deadline = Date.now() + 220;
    while (Date.now() < deadline) {
      await sleep(40);
      if (inspectTempChatState().status !== 'active') {
        postTempChatStatus(FRAME_TO_HOST.PANELIZE_TEMP_CHAT_DISABLED, providerId);
        return;
      }
    }
  }

  // ===== Generic Image Upload & Attachment Cleanup =====

  const IMAGE_ACCEPT_HINT_RE =
    /image\/|\*\s*\/\s*\*|\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)\b/i;

  const REMOVE_ATTACHMENT_RE =
    /\b(remove|delete|discard)\b.*\b(image|file|attachment|photo|upload|media)\b|^remove\s+\S+|\b(remove|delete)[\s_-]*(attachment|image|file|media|upload)\b|(移除|删除)(图片|附件|文件)/i;

  function createFileFromImagePayload(image) {
    if (!image || typeof image.dataUrl !== 'string') {
      return null;
    }
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(image.dataUrl.trim());
    if (!match) {
      return null;
    }
    try {
      const mimeType = typeof image.type === 'string' && image.type.startsWith('image/')
        ? image.type
        : match[1];
      const cleanBase64 = match[2].replace(/\s+/g, '');
      const binary = atob(cleanBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const fallbackExt = mimeType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
      const safeName =
        typeof image.name === 'string' && image.name.trim().length > 0
          ? image.name.trim()
          : `image.${fallbackExt}`;
      return new File([bytes], safeName, { type: mimeType, lastModified: Date.now() });
    } catch {
      return null;
    }
  }

  function isImageAcceptingFileInput(input) {
    if (!input || input.tagName !== 'INPUT' || (input.type || '').toLowerCase() !== 'file') {
      return false;
    }
    if (input.disabled || input.getAttribute('aria-disabled') === 'true') {
      return false;
    }
    const accept = (input.getAttribute('accept') || '').trim();
    if (!accept) {
      return true;
    }
    return IMAGE_ACCEPT_HINT_RE.test(accept);
  }

  function findImageFileInput(composer) {
    if (composer) {
      const scopes = collectComposerScopes(composer);
      for (let i = 0; i < scopes.length; i += 1) {
        const inputs = querySelectorAllDeep('input[type="file"]', scopes[i].node).filter(
          isImageAcceptingFileInput
        );
        if (inputs.length > 0) {
          const explicitImg = inputs.find((inp) =>
            IMAGE_ACCEPT_HINT_RE.test(inp.getAttribute('accept') || '')
          );
          return explicitImg || inputs[0];
        }
      }
    }

    const docInputs = querySelectorAllDeep('input[type="file"]', document).filter(
      isImageAcceptingFileInput
    );
    if (docInputs.length === 0) {
      return null;
    }
    const explicitDocImg = docInputs.find((inp) =>
      IMAGE_ACCEPT_HINT_RE.test(inp.getAttribute('accept') || '')
    );
    return explicitDocImg || docInputs[0];
  }

  function assignFilesToFileInput(fileInput, files) {
    if (!fileInput || !Array.isArray(files) || files.length === 0) {
      return false;
    }
    let assigned = false;
    try {
      const dt = new DataTransfer();
      for (let i = 0; i < files.length; i += 1) {
        dt.items.add(files[i]);
      }
      fileInput.files = dt.files;
      assigned = Boolean(fileInput.files && fileInput.files.length === files.length);
    } catch {
      assigned = false;
    }

    if (!assigned) {
      try {
        Object.defineProperty(fileInput, 'files', {
          configurable: true,
          value: files,
        });
        assigned = true;
      } catch {
        return false;
      }
    }

    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return true;
  }

  function queryAcrossComposerScopes(composer, selector) {
    if (!composer) {
      const fallbackRoot = document.body || document.documentElement;
      return fallbackRoot ? querySelectorAllDeep(selector, fallbackRoot) : [];
    }
    const scopes = collectComposerScopes(composer);
    if (scopes.length === 0) {
      const fallbackRoot = composer.parentElement || document.body || document.documentElement;
      return fallbackRoot ? querySelectorAllDeep(selector, fallbackRoot) : [];
    }
    const seen = new Set();
    const results = [];
    for (let i = 0; i < scopes.length; i += 1) {
      const matches = querySelectorAllDeep(selector, scopes[i].node);
      for (let j = 0; j < matches.length; j += 1) {
        const el = matches[j];
        if (!seen.has(el)) {
          seen.add(el);
          results.push(el);
        }
      }
    }
    return results;
  }

  function inspectComposerAttachments(composer) {
    const previewImages = queryAcrossComposerScopes(composer, 'img').filter((img) => {
      const src = img.getAttribute('src') || '';
      return src.startsWith('blob:') || src.startsWith('data:image/');
    });

    const buttons = queryAcrossComposerScopes(composer, 'button, [role="button"]');
    let removeCount = 0;
    let disabledPreviewCount = 0;

    for (let i = 0; i < buttons.length; i += 1) {
      const btn = buttons[i];
      const aria = (btn.getAttribute('aria-label') || '').trim();
      const title = (btn.getAttribute('title') || '').trim();
      const desc = `${aria} ${title}`.trim();

      if (/^preview\s+\S+/i.test(aria) && (btn.disabled || btn.getAttribute('aria-disabled') === 'true')) {
        disabledPreviewCount += 1;
      }
      if (REMOVE_ATTACHMENT_RE.test(desc)) {
        removeCount += 1;
      }
    }

    const busyIndicators = queryAcrossComposerScopes(
      composer,
      '[role="progressbar"], [aria-busy="true"], [data-uploading="true"]'
    );

    const count = Math.max(previewImages.length, removeCount);
    const pending = disabledPreviewCount > 0 || busyIndicators.length > 0;
    return { count, pending };
  }

  async function waitForComposerUploadSettle(composer, baselineCount, expectedAdded, timeoutMs = 5500) {
    const targetCount = baselineCount + expectedAdded;
    const deadline = Date.now() + timeoutMs;
    let bestAdded = 0;

    while (Date.now() < deadline) {
      await sleep(45);
      const activeComposer = composer && composer.isConnected ? composer : findComposerElement() || composer;
      const state = inspectComposerAttachments(activeComposer);
      const added = Math.max(0, state.count - baselineCount);
      if (added > bestAdded) {
        bestAdded = added;
      }
      if (added >= expectedAdded && !state.pending) {
        return { ok: true, addedCount: expectedAdded };
      }
      if (state.count >= targetCount && !state.pending) {
        return { ok: true, addedCount: expectedAdded };
      }
    }

    return { ok: false, addedCount: Math.min(expectedAdded, bestAdded) };
  }

  function buildFileDataTransfer(files) {
    try {
      const dt = new DataTransfer();
      for (let i = 0; i < files.length; i += 1) {
        dt.items.add(files[i]);
      }
      if (dt.files && dt.files.length === files.length) {
        return dt;
      }
    } catch {
      // Fallback shim below for test DOM environments.
    }
    return {
      files,
      types: ['Files'],
      items: files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
      getData: () => '',
    };
  }

  async function tryPasteOrDropFiles(composer, files) {
    if (!composer || files.length === 0) {
      return { handled: false, ok: false, addedCount: 0 };
    }

    const baseline = inspectComposerAttachments(composer).count;
    try {
      composer.focus({ preventScroll: true });
    } catch {
      composer.focus();
    }

    const dt = buildFileDataTransfer(files);

    // 1. Try synthetic ClipboardEvent('paste')
    let pasteIntercepted = false;
    try {
      let pasteEvent;
      try {
        pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt instanceof DataTransfer ? dt : undefined,
        });
      } catch {
        pasteEvent = new Event('paste', { bubbles: true, cancelable: true, composed: true });
      }
      if (!pasteEvent.clipboardData || !pasteEvent.clipboardData.files || pasteEvent.clipboardData.files.length === 0) {
        Object.defineProperty(pasteEvent, 'clipboardData', {
          configurable: true,
          value: dt,
        });
      }
      const notCancelled = composer.dispatchEvent(pasteEvent);
      pasteIntercepted = !notCancelled || Boolean(pasteEvent.defaultPrevented);
    } catch {
      pasteIntercepted = false;
    }

    if (pasteIntercepted) {
      const settled = await waitForComposerUploadSettle(composer, baseline, files.length, 4500);
      return { handled: true, ok: settled.ok, addedCount: settled.addedCount };
    }

    await sleep(10);
    if (inspectComposerAttachments(composer).count > baseline) {
      const settled = await waitForComposerUploadSettle(composer, baseline, files.length, 4500);
      return { handled: true, ok: settled.ok, addedCount: settled.addedCount };
    }

    // 2. Try synthetic DragEvent('drop')
    let dropIntercepted = false;
    try {
      let dropEvent;
      try {
        dropEvent = new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: dt instanceof DataTransfer ? dt : undefined,
        });
      } catch {
        dropEvent = new Event('drop', { bubbles: true, cancelable: true, composed: true });
      }
      if (!dropEvent.dataTransfer || !dropEvent.dataTransfer.files || dropEvent.dataTransfer.files.length === 0) {
        Object.defineProperty(dropEvent, 'dataTransfer', {
          configurable: true,
          value: dt,
        });
      }
      const notCancelled = composer.dispatchEvent(dropEvent);
      dropIntercepted = !notCancelled || Boolean(dropEvent.defaultPrevented);
    } catch {
      dropIntercepted = false;
    }

    if (dropIntercepted) {
      const settled = await waitForComposerUploadSettle(composer, baseline, files.length, 4500);
      return { handled: true, ok: settled.ok, addedCount: settled.addedCount };
    }

    await sleep(10);
    if (inspectComposerAttachments(composer).count > baseline) {
      const settled = await waitForComposerUploadSettle(composer, baseline, files.length, 4500);
      return { handled: true, ok: settled.ok, addedCount: settled.addedCount };
    }

    return { handled: false, ok: false, addedCount: 0 };
  }

  async function uploadImagesToComposer(composer, images) {
    const entries = [];
    for (let i = 0; i < images.length; i += 1) {
      const img = images[i];
      const file = createFileFromImagePayload(img);
      if (!file) {
        return {
          ok: false,
          reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
          succeededImageIds: [],
        };
      }
      entries.push({ id: img.id, file });
    }

    const fileInput = findImageFileInput(composer);
    if (fileInput) {
      if (entries.length === 1 || fileInput.multiple) {
        const baseline = inspectComposerAttachments(composer).count;
        const files = entries.map((entry) => entry.file);
        if (!assignFilesToFileInput(fileInput, files)) {
          return {
            ok: false,
            reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
            succeededImageIds: [],
          };
        }
        const settled = await waitForComposerUploadSettle(composer, baseline, entries.length, 5500);
        const succeededImageIds = entries
          .slice(0, settled.addedCount)
          .map((entry) => entry.id)
          .filter((id) => typeof id === 'string');
        return settled.ok
          ? { ok: true, succeededImageIds }
          : {
              ok: false,
              reason: ACTION_FAILURE_REASONS.PREVIEW_TIMEOUT,
              succeededImageIds,
            };
      }

      // Single-file input with multiple images: upload sequentially
      const succeededImageIds = [];
      for (let i = 0; i < entries.length; i += 1) {
        const currentInput = findImageFileInput(composer) || fileInput;
        const baseline = inspectComposerAttachments(composer).count;
        if (!assignFilesToFileInput(currentInput, [entries[i].file])) {
          return {
            ok: false,
            reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
            succeededImageIds,
          };
        }
        const settled = await waitForComposerUploadSettle(composer, baseline, 1, 5500);
        if (!settled.ok) {
          return {
            ok: false,
            reason: ACTION_FAILURE_REASONS.PREVIEW_TIMEOUT,
            succeededImageIds,
          };
        }
        if (typeof entries[i].id === 'string') {
          succeededImageIds.push(entries[i].id);
        }
      }
      return { ok: true, succeededImageIds };
    }

    // No <input type="file"> in DOM: attempt paste/drop on composer
    const fallback = await tryPasteOrDropFiles(composer, entries.map((entry) => entry.file));
    if (!fallback.handled) {
      return {
        ok: false,
        reason: ACTION_FAILURE_REASONS.UNSUPPORTED,
        succeededImageIds: [],
      };
    }

    const succeededImageIds = entries
      .slice(0, fallback.addedCount)
      .map((entry) => entry.id)
      .filter((id) => typeof id === 'string');
    return fallback.ok
      ? { ok: true, succeededImageIds }
      : {
          ok: false,
          reason: ACTION_FAILURE_REASONS.PREVIEW_TIMEOUT,
          succeededImageIds,
        };
  }

  function clearComposerAttachments(composer) {
    const buttons = queryAcrossComposerScopes(composer, 'button, [role="button"]');
    let removed = 0;
    for (let i = 0; i < buttons.length; i += 1) {
      const btn = buttons[i];
      if (!isButtonEnabled(btn)) {
        continue;
      }
      const desc = `${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('title') || ''}`.trim();
      if (REMOVE_ATTACHMENT_RE.test(desc)) {
        btn.click();
        removed += 1;
      }
    }
    return removed;
  }

  // ===== Message Dispatch =====

  async function handleFillWithResult(eventData, providerId) {
    const { text, images, autoSubmit, requestId, retry = false } = eventData;
    const hasImages = Array.isArray(images) && images.length > 0;
    const hasText = typeof text === 'string' && text.length > 0;

    if (requestId && providerId) {
      startUserInteractionTracking(requestId, providerId);
    } else {
      stopUserInteractionTracking();
    }

    if (typeof text === 'string' && text.length > MAX_TEXT_BYTES) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
        succeededImageIds: [],
      });
      return;
    }

    if (!hasImages && !hasText) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
        succeededImageIds: [],
      });
      return;
    }

    const composer = await findComposerWithRetry(hasImages ? 600 : 1000);
    if (!composer) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND,
        succeededImageIds: [],
      });
      return;
    }

    let succeededImageIds = [];
    if (hasImages) {
      const uploadResult = await uploadImagesToComposer(composer, images);
      succeededImageIds = uploadResult.succeededImageIds || [];
      if (!uploadResult.ok) {
        if (hasText) {
          const refreshedComposer = composer.isConnected ? composer : findComposerElement();
          if (refreshedComposer) {
            await injectTextIntoComposer(refreshedComposer, text, {
              skipIfAlreadyPresent: Boolean(retry),
            });
          }
        }
        postActionResult(requestId, providerId, {
          ok: false,
          reason: uploadResult.reason || ACTION_FAILURE_REASONS.INJECTION_ERROR,
          succeededImageIds,
        });
        return;
      }
    }

    if (hasText) {
      const activeComposer = composer.isConnected ? composer : await findComposerWithRetry(500);
      if (!activeComposer) {
        postActionResult(requestId, providerId, {
          ok: false,
          reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND,
          succeededImageIds,
        });
        return;
      }
      const injected = await injectTextIntoComposer(activeComposer, text, {
        skipIfAlreadyPresent: Boolean(retry),
      });
      if (!injected) {
        postActionResult(requestId, providerId, {
          ok: false,
          reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
          succeededImageIds,
        });
        return;
      }
    }

    if (autoSubmit === true) {
      await sleep(80);
      const activeComposer = composer.isConnected ? composer : findComposerElement();
      await triggerSendWithSettle(activeComposer, { waitForEnabledMs: 700 });
    }

    postActionResult(requestId, providerId, {
      ok: true,
      succeededImageIds,
    });
  }

  async function handleInjectText(eventData, providerId) {
    const { text, autoSubmit, context, requestId, action } = eventData;
    if (!text || typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_BYTES) {
      if (action === 'fill' && requestId) {
        postActionResult(requestId, providerId, {
          ok: false,
          reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
          succeededImageIds: [],
        });
      }
      return;
    }

    const shouldAutoSubmit = autoSubmit === true && context === MULTI_PANEL_CONTEXT;

    if (requestId && providerId) {
      startUserInteractionTracking(requestId, providerId);
    } else {
      stopUserInteractionTracking();
    }

    const composer = await findComposerWithRetry(1000);
    if (!composer) {
      if (action === 'fill' && requestId) {
        postActionResult(requestId, providerId, {
          ok: false,
          reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND,
          succeededImageIds: [],
        });
      }
      return;
    }

    const injected = await injectTextIntoComposer(composer, text);
    if (injected && shouldAutoSubmit) {
      // Allow reactive UI state (Svelte/React/ProseMirror) a brief tick to enable the send control.
      await sleep(80);
      await triggerSendWithSettle(composer, { waitForEnabledMs: 700 });
    }

    if (action === 'fill' && requestId) {
      postActionResult(requestId, providerId, {
        ok: injected,
        reason: injected ? undefined : ACTION_FAILURE_REASONS.INJECTION_ERROR,
        succeededImageIds: [],
      });
    }
  }

  // ===== Share Snapshot: Align, Scroll, Stitch & Restore =====

  const SNAPSHOT_MATCH_KEY_LENGTH = 40;
  const SNAPSHOT_MIN_MATCH_KEY_LENGTH = 2;
  const SNAPSHOT_MAX_MATCH_CANDIDATES = 50;
  const SNAPSHOT_ALIGN_MARGIN_PX = 16;
  const SNAPSHOT_PAINT_SETTLE_MS = 100;
  const SNAPSHOT_PAINT_TIMEOUT_MS = 400;
  const SNAPSHOT_MIN_CONTAINER_HEIGHT_RATIO = 0.3;
  const SNAPSHOT_MAX_EDGE_RATIO = 0.4;
  const SNAPSHOT_OVERLAY_MIN_WIDTH_RATIO = 0.5;
  const SNAPSHOT_EDGE_TOLERANCE_PX = 24;
  const SNAPSHOT_MAX_FLOATING_HEIGHT_RATIO = 0.5;
  const SNAPSHOT_MAX_SIDE_RAIL_WIDTH_RATIO = 0.45;
  const SNAPSHOT_HIDDEN_MASK_PROPERTIES = ['mask-image', '-webkit-mask-image'];
  const SNAPSHOT_CLIPPING_OVERFLOW = /^(hidden|clip|auto|scroll|overlay)$/;
  const SNAPSHOT_SKIPPED_TEXT_PARENTS = [
    'script',
    'style',
    'noscript',
    'template',
    'textarea',
    'input',
    'select',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[aria-hidden="true"]',
  ].join(', ');
  const SNAPSHOT_NAVIGATION_PARENTS =
    'nav, aside, [role="navigation"], [role="complementary"], a[href]';
  const SNAPSHOT_USER_TURN_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-testid="user-message"]',
    '[data-testid*="user-message" i]',
    '[data-role="user"]',
    '[data-author="user"]',
    '[data-message-role="user"]',
    '[data-sender="user"]',
    '[data-content="user-message"]',
    '[class*="user-bubble"]',
    '[class*="user-message"]',
    '[class*="items-end"] .message-bubble',
    '.chat-content-item-user',
    '.chat-user-message',
  ].join(', ');
  const SNAPSHOT_ALIGN_TOLERANCE_PX = 2;
  const SNAPSHOT_RESTORE_ATTEMPTS = 10;
  const SNAPSHOT_UNSTICK_PROPERTIES = ['position', 'top', 'right', 'bottom', 'left'];
  const SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE = 'data-panelize-snapshot-hide';
  const SNAPSHOT_HIDE_CURSOR_ATTRIBUTE = 'data-panelize-snapshot-cursor';
  const SNAPSHOT_STYLE_RULES = `
    [${SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE}~="before"]::before,
    [${SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE}~="after"]::after { visibility: hidden !important; }
    [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}], [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *,
    [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *::before, [${SNAPSHOT_HIDE_CURSOR_ATTRIBUTE}] *::after { cursor: none !important; }
  `;
  const SNAPSHOT_STYLE_ELEMENT_ID = 'panelize-snapshot-style';

  let snapshotSession = null;
  let snapshotStyleSheet = null;

  function getParentOrShadowHost(node) {
    if (!node) {
      return null;
    }
    if (node.parentElement) {
      return node.parentElement;
    }
    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  function normalizeSnapshotMatchText(text) {
    return String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\u200b-\u200d\u2060\ufeff*_`]+/g, '');
  }

  function getSnapshotMatchKey(prompt) {
    return Array.from(normalizeSnapshotMatchText(prompt))
      .slice(0, SNAPSHOT_MATCH_KEY_LENGTH)
      .join('');
  }

  function getSnapshotViewport() {
    return {
      width: window.innerWidth || document.documentElement?.clientWidth || 0,
      height: window.innerHeight || document.documentElement?.clientHeight || 0,
    };
  }

  function isSnapshotDocumentScroller(element) {
    return (
      !element ||
      element === document.scrollingElement ||
      element === document.documentElement ||
      element === document.body
    );
  }

  function isSnapshotScrollable(element) {
    if (isSnapshotDocumentScroller(element)) {
      const scroller = document.scrollingElement || document.documentElement;
      return Boolean(scroller) && scroller.scrollHeight > scroller.clientHeight + 1;
    }
    const overflowY = window.getComputedStyle(element).overflowY;
    return /(auto|scroll|overlay)/.test(overflowY) && element.scrollHeight > element.clientHeight + 1;
  }

  function isSnapshotElementRendered(element) {
    if (typeof element.checkVisibility === 'function') {
      return element.checkVisibility();
    }
    return true;
  }

  function getSnapshotContainerRect(container) {
    const viewport = getSnapshotViewport();
    if (isSnapshotDocumentScroller(container)) {
      return { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
    }
    const rect = container.getBoundingClientRect();
    const left = rect.left + container.clientLeft;
    const top = rect.top + container.clientTop;
    const box = {
      left: Math.max(0, left),
      top: Math.max(0, top),
      right: Math.min(viewport.width, left + container.clientWidth),
      bottom: Math.min(viewport.height, top + container.clientHeight),
    };
    for (
      let node = getParentOrShadowHost(container);
      node && !isSnapshotDocumentScroller(node);
      node = getParentOrShadowHost(node)
    ) {
      const style = window.getComputedStyle(node);
      if (
        !SNAPSHOT_CLIPPING_OVERFLOW.test(style.overflowX) &&
        !SNAPSHOT_CLIPPING_OVERFLOW.test(style.overflowY)
      ) {
        continue;
      }
      const nodeRect = node.getBoundingClientRect();
      const nodeLeft = nodeRect.left + node.clientLeft;
      const nodeTop = nodeRect.top + node.clientTop;
      box.left = Math.max(box.left, nodeLeft);
      box.top = Math.max(box.top, nodeTop);
      box.right = Math.min(box.right, nodeLeft + node.clientWidth);
      box.bottom = Math.min(box.bottom, nodeTop + node.clientHeight);
    }
    return box;
  }

  function isLargeSnapshotContainer(element) {
    const viewport = getSnapshotViewport();
    if (isSnapshotDocumentScroller(element)) {
      return true;
    }
    const rect = getSnapshotContainerRect(element);
    return rect.bottom - rect.top >= viewport.height * SNAPSHOT_MIN_CONTAINER_HEIGHT_RATIO;
  }

  function getSnapshotScrollTop(container) {
    return isSnapshotDocumentScroller(container) ? window.scrollY : container.scrollTop;
  }

  function getSnapshotMaxScrollTop(container) {
    const scroller = isSnapshotDocumentScroller(container)
      ? document.scrollingElement || document.documentElement
      : container;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }

  function clampSnapshotScrollTop(container, top) {
    return Math.max(0, Math.min(getSnapshotMaxScrollTop(container), Math.round(top)));
  }

  function scrollSnapshotContainer(container, top) {
    const target = clampSnapshotScrollTop(container, top);
    if (isSnapshotDocumentScroller(container)) {
      window.scrollTo({ top: target, behavior: 'instant' });
    } else if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: target, behavior: 'instant' });
    } else {
      container.scrollTop = target;
    }
  }

  function findSnapshotScrollContainer(element, main) {
    const ancestors = [];
    for (
      let node = element;
      node && !isSnapshotDocumentScroller(node);
      node = getParentOrShadowHost(node)
    ) {
      if (isSnapshotScrollable(node) && isLargeSnapshotContainer(node)) {
        ancestors.push(node);
      }
    }
    if (isSnapshotScrollable(null)) {
      ancestors.push(document.scrollingElement || document.documentElement);
    }
    if (ancestors.includes(main)) {
      return main;
    }
    return ancestors.reduce(
      (best, node) =>
        !best || getSnapshotMaxScrollTop(node) > getSnapshotMaxScrollTop(best) ? node : best,
      null
    );
  }

  function findMainSnapshotScrollContainer() {
    let best = null;
    let bestArea = 0;
    const candidates = document.body ? querySelectorAllDeep('*', document.body) : [];
    for (let i = 0; i < candidates.length; i += 1) {
      const element = candidates[i];
      if (!isSnapshotScrollable(element) || !isLargeSnapshotContainer(element)) {
        continue;
      }
      const rect = getSnapshotContainerRect(element);
      const area = Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
      if (area > bestArea) {
        best = element;
        bestArea = area;
      }
    }
    return best || document.scrollingElement || document.documentElement;
  }

  function isSnapshotConversationElement(element) {
    if (
      !isSnapshotElementRendered(element) ||
      (typeof element.closest === 'function' && element.closest(SNAPSHOT_NAVIGATION_PARENTS))
    ) {
      return false;
    }
    for (let node = element; node && node !== document.body; node = getParentOrShadowHost(node)) {
      if (window.getComputedStyle(node).position === 'fixed') {
        return false;
      }
    }
    return true;
  }

  function collectSnapshotTextIndex() {
    const segments = [];
    let text = '';
    if (!document.body) {
      return { segments, text };
    }
    const visitedRoots = new Set();
    const walkRoot = (root) => {
      if (!root || visitedRoots.has(root)) {
        return;
      }
      visitedRoots.add(root);
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              if (
                typeof node.matches === 'function' &&
                node.matches(SNAPSHOT_SKIPPED_TEXT_PARENTS)
              ) {
                return NodeFilter.FILTER_REJECT;
              }
              return NodeFilter.FILTER_ACCEPT;
            }
            const parent = node.parentElement || getParentOrShadowHost(node);
            if (
              !parent ||
              (typeof parent.closest === 'function' && parent.closest(SNAPSHOT_SKIPPED_TEXT_PARENTS))
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          },
        }
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.shadowRoot) {
            walkRoot(node.shadowRoot);
          }
          continue;
        }
        const normalized = normalizeSnapshotMatchText(node.nodeValue);
        if (normalized) {
          segments.push({ node, start: text.length });
          text += normalized;
        }
      }
    };
    walkRoot(document.body);
    return { segments, text };
  }

  function findSnapshotSegment(segments, offset) {
    let low = 0;
    let high = segments.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (segments[middle].start <= offset) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return segments[low];
  }

  function findSnapshotPromptMatches(prompt, main) {
    const key = getSnapshotMatchKey(prompt);
    if (Array.from(key).length < SNAPSHOT_MIN_MATCH_KEY_LENGTH) {
      return [];
    }
    const { segments, text } = collectSnapshotTextIndex();
    if (segments.length === 0) {
      return [];
    }
    const candidates = [];
    let offset = text.lastIndexOf(key);
    for (
      let checked = 0;
      offset !== -1 && checked < SNAPSHOT_MAX_MATCH_CANDIDATES;
      checked += 1
    ) {
      const segment = findSnapshotSegment(segments, offset);
      const element = segment.node.parentElement || getParentOrShadowHost(segment.node);
      if (element && isSnapshotConversationElement(element)) {
        const container = findSnapshotScrollContainer(element, main);
        if (container) {
          const isUserTurn =
            typeof element.closest === 'function' &&
            Boolean(element.closest(SNAPSHOT_USER_TURN_SELECTORS));
          const rank =
            (isUserTurn ? 0 : 4) +
            (segment.start === offset ? 0 : 2) +
            (container === main ? 0 : 1);
          candidates.push({ element, container, rank });
        }
      }
      offset = offset > 0 ? text.lastIndexOf(key, offset - 1) : -1;
    }
    return candidates.sort((a, b) => a.rank - b.rank);
  }

  function findSnapshotUserTurn(main) {
    const elements = document.body
      ? querySelectorAllDeep(SNAPSHOT_USER_TURN_SELECTORS, document.body)
      : [];
    for (let index = elements.length - 1; index >= 0; index -= 1) {
      const element = elements[index];
      if (!isSnapshotConversationElement(element)) {
        continue;
      }
      const container = findSnapshotScrollContainer(element, main);
      if (container) {
        return { element, container };
      }
    }
    return null;
  }

  function deepContains(ancestor, target) {
    if (!ancestor || !target) {
      return false;
    }
    for (let node = target; node; node = getParentOrShadowHost(node)) {
      if (node === ancestor) {
        return true;
      }
    }
    return false;
  }

  function isSnapshotScrolledContent(element, container) {
    const containingBlock = element.offsetParent;
    if (!containingBlock) {
      return false;
    }
    if (isSnapshotDocumentScroller(container)) {
      return true;
    }
    return containingBlock === container || deepContains(container, containingBlock);
  }

  function getSnapshotClip(container) {
    const rect = getSnapshotContainerRect(container);
    const clip = { ...rect };
    const height = rect.bottom - rect.top;
    const width = rect.right - rect.left;
    if (height <= 0 || width <= 0) {
      return clip;
    }
    const maxEdge = height * SNAPSHOT_MAX_EDGE_RATIO;
    const scope = isSnapshotDocumentScroller(container) ? document.body : container;
    const candidates = scope ? querySelectorAllDeep('*', scope) : [];
    if (!isSnapshotDocumentScroller(container) && document.body) {
      const bodyNodes = querySelectorAllDeep('*', document.body);
      for (let i = 0; i < bodyNodes.length; i += 1) {
        const element = bodyNodes[i];
        if (!deepContains(container, element) && !deepContains(element, container)) {
          candidates.push(element);
        }
      }
    }

    const pinBar = (barRect) => {
      if (barRect.width < width * SNAPSHOT_OVERLAY_MIN_WIDTH_RATIO || barRect.height <= 0) {
        return;
      }
      if (
        barRect.bottom <= rect.top ||
        barRect.top >= rect.bottom ||
        barRect.right <= rect.left ||
        barRect.left >= rect.right
      ) {
        return;
      }
      if (
        barRect.top <= rect.top + SNAPSHOT_EDGE_TOLERANCE_PX &&
        barRect.bottom - rect.top <= maxEdge
      ) {
        clip.top = Math.max(clip.top, barRect.bottom);
      } else if (
        barRect.bottom >= rect.bottom - SNAPSHOT_EDGE_TOLERANCE_PX &&
        rect.bottom - barRect.top <= maxEdge
      ) {
        clip.bottom = Math.min(clip.bottom, barRect.top);
      }
    };

    const overlayingBars = new Set();
    const isInOverlayingBar = (element) => {
      for (let node = getParentOrShadowHost(element); node; node = getParentOrShadowHost(node)) {
        if (overlayingBars.has(node)) {
          return true;
        }
      }
      return false;
    };

    for (let i = 0; i < candidates.length; i += 1) {
      const element = candidates[i];
      const style = window.getComputedStyle(element);
      const position = style.position;
      if (position !== 'sticky' && position !== 'fixed' && position !== 'absolute') {
        continue;
      }
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        continue;
      }
      if (
        position === 'absolute' &&
        deepContains(container, element) &&
        isSnapshotScrolledContent(element, container)
      ) {
        continue;
      }
      if (position === 'absolute' && !deepContains(container, element)) {
        const elemRect = element.getBoundingClientRect();
        const sample = document.elementFromPoint?.(
          Math.round((rect.left + rect.right) / 2),
          Math.round(elemRect.top + 1)
        );
        if (sample && deepContains(element, sample)) {
          overlayingBars.add(element);
        } else if (!isInOverlayingBar(element)) {
          continue;
        }
      }
      pinBar(element.getBoundingClientRect());
    }

    // Exclude the bottom composer dock (skipping `display: contents` wrappers whose rect is 0x0).
    const input = findComposerElement();
    if (input) {
      let box = null;
      for (
        let node = input;
        node && node !== container && !deepContains(node, container);
        node = getParentOrShadowHost(node)
      ) {
        if (window.getComputedStyle(node).display === 'contents') {
          continue;
        }
        const nodeRect = node.getBoundingClientRect();
        if (nodeRect.width <= 0 || nodeRect.height <= 0) {
          continue;
        }
        if (nodeRect.height > maxEdge || nodeRect.width > width + 2) {
          break;
        }
        box = nodeRect;
      }
      if (
        box &&
        box.top < clip.bottom &&
        box.bottom > rect.top + height - maxEdge &&
        box.right > rect.left &&
        box.left < rect.right
      ) {
        clip.bottom = Math.min(clip.bottom, box.top);
      }
    }

    if (clip.bottom - clip.top < height * (1 - SNAPSHOT_MAX_EDGE_RATIO * 2)) {
      return { ...rect };
    }
    return {
      left: Math.round(clip.left),
      top: Math.round(clip.top),
      right: Math.round(clip.right),
      bottom: Math.round(clip.bottom),
    };
  }

  function getSnapshotPinningNode(element, container) {
    const outside = !isSnapshotDocumentScroller(container) && !deepContains(container, element);
    const containerRect = getSnapshotContainerRect(container);
    let pinning = null;
    for (
      let node = element;
      node && node !== container && node !== document.body && !deepContains(node, container);
      node = getParentOrShadowHost(node)
    ) {
      if (outside) {
        pinning = node;
        continue;
      }
      const position = window.getComputedStyle(node).position;
      if (position === 'fixed') {
        pinning = node;
      } else if (position === 'sticky') {
        const rect = node.getBoundingClientRect();
        if (
          Math.abs(rect.top - containerRect.top) <= SNAPSHOT_EDGE_TOLERANCE_PX ||
          Math.abs(rect.bottom - containerRect.bottom) <= SNAPSHOT_EDGE_TOLERANCE_PX
        ) {
          pinning = node;
        }
      } else if (
        position === 'absolute' &&
        !isSnapshotDocumentScroller(container) &&
        !isSnapshotScrolledContent(node, container)
      ) {
        pinning = node;
      }
    }
    return pinning;
  }

  function isSnapshotPinned(element, container) {
    return Boolean(getSnapshotPinningNode(element, container));
  }

  function overlapsSnapshotClip(rect, clip) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > clip.top &&
      rect.top < clip.bottom &&
      rect.right > clip.left &&
      rect.left < clip.right
    );
  }

  function hasSnapshotReadableText(element) {
    return /[\p{L}\p{N}]/u.test(element.textContent || '');
  }

  function saveSnapshotInlineStyle(element, property) {
    return {
      element,
      property,
      value: element.style.getPropertyValue(property),
      priority: element.style.getPropertyPriority(property),
    };
  }

  function restoreSnapshotInlineStyles(savedStyles) {
    for (const { element, property, value, priority } of [...savedStyles].reverse()) {
      if (value) {
        element.style.setProperty(property, value, priority);
      } else {
        element.style.removeProperty(property);
      }
    }
  }

  function installSnapshotStyles() {
    try {
      if (typeof CSSStyleSheet === 'function' && Array.isArray(document.adoptedStyleSheets)) {
        if (!snapshotStyleSheet) {
          snapshotStyleSheet = new CSSStyleSheet();
          snapshotStyleSheet.replaceSync(SNAPSHOT_STYLE_RULES);
        }
        if (!document.adoptedStyleSheets.includes(snapshotStyleSheet)) {
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, snapshotStyleSheet];
        }
        return;
      }
    } catch {
      // Fallback to <style> element below.
    }
    if (!document.getElementById(SNAPSHOT_STYLE_ELEMENT_ID)) {
      const style = document.createElement('style');
      style.id = SNAPSHOT_STYLE_ELEMENT_ID;
      style.textContent = SNAPSHOT_STYLE_RULES;
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function removeSnapshotStyles() {
    if (snapshotStyleSheet && Array.isArray(document.adoptedStyleSheets)) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
        (sheet) => sheet !== snapshotStyleSheet
      );
    }
    document.getElementById(SNAPSHOT_STYLE_ELEMENT_ID)?.remove();
  }

  function isSnapshotFadePseudo(element, pseudo) {
    const style = window.getComputedStyle(element, `::${pseudo}`);
    if (
      !style?.content ||
      style.content === 'none' ||
      style.content === 'normal' ||
      style.display === 'none'
    ) {
      return false;
    }
    if (!/^(absolute|fixed|sticky)$/.test(style.position)) {
      return false;
    }
    return (
      (style.backgroundImage || '').includes('gradient') ||
      (Boolean(style.boxShadow) && style.boxShadow !== 'none')
    );
  }

  function hideSnapshotFadePseudos(session, element) {
    const marked = (element.getAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE) || '')
      .split(/\s+/)
      .filter(Boolean);
    const missing = ['before', 'after'].filter(
      (pseudo) => !marked.includes(pseudo) && isSnapshotFadePseudo(element, pseudo)
    );
    if (missing.length === 0) {
      return false;
    }
    if (!session.hiddenPseudos.has(element)) {
      session.hiddenPseudos.set(element, element.getAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE));
    }
    installSnapshotStyles();
    element.setAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE, [...marked, ...missing].join(' '));
    return true;
  }

  function unstickSnapshotContent(session) {
    const { container } = session;
    const isDocument = isSnapshotDocumentScroller(container);
    const scope = isDocument ? document.body : container;
    const scroller = isDocument ? document.scrollingElement || document.documentElement : container;
    const containerRect = getSnapshotContainerRect(container);
    const containerWidth = Math.max(0, containerRect.right - containerRect.left);
    const contentTop = containerRect.top - getSnapshotScrollTop(container);
    const input = findComposerElement();
    let changed = false;
    const elements = scope ? querySelectorAllDeep('*', scope) : [];
    for (let i = 0; i < elements.length; i += 1) {
      const element = elements[i];
      if (
        session.unstuckElements.has(element) ||
        session.keptStickyElements.has(element) ||
        !element.style
      ) {
        continue;
      }
      const style = window.getComputedStyle(element);
      if (style.position !== 'sticky') {
        continue;
      }
      if (input && deepContains(element, input)) {
        session.keptStickyElements.add(element);
        continue;
      }
      const saved = SNAPSHOT_UNSTICK_PROPERTIES.map((property) =>
        saveSnapshotInlineStyle(element, property)
      );
      element.style.setProperty('position', 'relative', 'important');
      SNAPSHOT_UNSTICK_PROPERTIES.slice(1).forEach((property) =>
        element.style.setProperty(property, 'auto', 'important')
      );
      const rect = element.getBoundingClientRect();
      const top = rect.top - contentTop;
      const isEdgeBarWidth = rect.width >= containerWidth * SNAPSHOT_OVERLAY_MIN_WIDTH_RATIO;
      if (
        isEdgeBarWidth &&
        (top <= SNAPSHOT_EDGE_TOLERANCE_PX ||
          top + rect.height >= scroller.scrollHeight - SNAPSHOT_EDGE_TOLERANCE_PX)
      ) {
        restoreSnapshotInlineStyles(saved);
        session.keptStickyElements.add(element);
        continue;
      }
      session.savedStyles.push(...saved);
      session.unstuckElements.add(element);
      if (style.boxShadow && style.boxShadow !== 'none') {
        session.savedStyles.push(saveSnapshotInlineStyle(element, 'box-shadow'));
        element.style.setProperty('box-shadow', 'none', 'important');
      }
      hideSnapshotFadePseudos(session, element);
      changed = true;
    }
    return changed;
  }

  function subtreeOverlapsSnapshotClip(element, clip) {
    const rect = element.getBoundingClientRect();
    if (overlapsSnapshotClip(rect, clip)) {
      return true;
    }
    const descendants = querySelectorAllDeep('*', element);
    for (let i = 0; i < descendants.length; i += 1) {
      const child = descendants[i];
      const st = window.getComputedStyle(child);
      if (st.display === 'none' || st.visibility === 'hidden') {
        continue;
      }
      if (overlapsSnapshotClip(child.getBoundingClientRect(), clip)) {
        return true;
      }
    }
    return false;
  }

  function hideSnapshotFloatingElements(session) {
    const { container, clip } = session;
    const clipHeight = clip.bottom - clip.top;
    const clipWidth = clip.right - clip.left;
    if (!container || clipHeight <= 0 || clipWidth <= 0) {
      return false;
    }
    const hidden = session.hiddenElements;
    let changed = false;
    const hide = (element) => {
      hidden.add(element);
      session.savedStyles.push(saveSnapshotInlineStyle(element, 'visibility'));
      element.style.setProperty('visibility', 'hidden', 'important');
      changed = true;
    };

    const scroller = isSnapshotDocumentScroller(container)
      ? document.scrollingElement || document.documentElement
      : container;
    if (!session.hidesScrollbar) {
      const style = window.getComputedStyle(scroller);
      const borders =
        (parseFloat(style.borderLeftWidth) || 0) + (parseFloat(style.borderRightWidth) || 0);
      if (scroller.offsetWidth > 0 && scroller.offsetWidth - scroller.clientWidth <= borders) {
        session.hidesScrollbar = true;
        session.savedStyles.push(saveSnapshotInlineStyle(scroller, 'scrollbar-width'));
        scroller.style.setProperty('scrollbar-width', 'none', 'important');
        changed = true;
      }
    }

    const input = findComposerElement();
    const fadeHosts = new Set(session.unstuckElements);
    for (let node = container; node && node.style; node = getParentOrShadowHost(node)) {
      fadeHosts.add(node);
      if (session.unmaskedElements.has(node)) {
        continue;
      }
      const style = window.getComputedStyle(node);
      const masked = SNAPSHOT_HIDDEN_MASK_PROPERTIES.some((property) => {
        const value = style.getPropertyValue(property);
        return value && value !== 'none';
      });
      if (masked) {
        session.unmaskedElements.add(node);
        SNAPSHOT_HIDDEN_MASK_PROPERTIES.forEach((property) => {
          session.savedStyles.push(saveSnapshotInlineStyle(node, property));
          node.style.setProperty(property, 'none', 'important');
        });
        changed = true;
      }
    }
    for (
      let node = getParentOrShadowHost(input);
      node && node !== document.body;
      node = getParentOrShadowHost(node)
    ) {
      fadeHosts.add(node);
    }

    const containerRect = getSnapshotContainerRect(container);
    const nearClip = {
      left: containerRect.left,
      right: containerRect.right,
      top: clip.top - SNAPSHOT_EDGE_TOLERANCE_PX,
      bottom: clip.bottom + SNAPSHOT_EDGE_TOLERANCE_PX,
    };
    const allElements = document.body ? querySelectorAllDeep('*', document.body) : [];
    for (let i = 0; i < allElements.length; i += 1) {
      const element = allElements[i];
      if (
        hidden.has(element) ||
        element === container ||
        deepContains(element, container) ||
        (session.matchElement && deepContains(element, session.matchElement))
      ) {
        continue;
      }
      const style = window.getComputedStyle(element);
      const position = style.position;
      if (position !== 'sticky' && position !== 'fixed' && position !== 'absolute') {
        continue;
      }
      if (style.display === 'none' || !isSnapshotPinned(element, container)) {
        continue;
      }
      fadeHosts.add(element);
      const rect = element.getBoundingClientRect();
      if (
        style.boxShadow &&
        style.boxShadow !== 'none' &&
        !session.quietedElements.has(element) &&
        overlapsSnapshotClip(rect, nearClip)
      ) {
        session.quietedElements.add(element);
        session.savedStyles.push(saveSnapshotInlineStyle(element, 'box-shadow'));
        element.style.setProperty('box-shadow', 'none', 'important');
        changed = true;
      }
      const isScrolledSideRail =
        session.stitch &&
        session.scrolledFrame &&
        rect.width <= clipWidth * SNAPSHOT_MAX_SIDE_RAIL_WIDTH_RATIO;
      if (
        (!isScrolledSideRail && rect.height > clipHeight * SNAPSHOT_MAX_FLOATING_HEIGHT_RATIO) ||
        !overlapsSnapshotClip(rect, clip)
      ) {
        continue;
      }
      if (input && deepContains(element, input)) {
        continue;
      }
      const isButton =
        typeof element.matches === 'function' && element.matches('button, [role="button"]');
      if (!session.stitch && !isButton && hasSnapshotReadableText(element)) {
        continue;
      }
      hide(element);
    }

    for (const element of fadeHosts) {
      if (element.style && hideSnapshotFadePseudos(session, element)) {
        changed = true;
      }
    }

    // Quiet huge spread box-shadows on static/relative wrappers inside a pinned
    // composer dock (e.g. Perplexity's `shadow-[0_36px_24px_64px_var(--bg-base)]`)
    // and hide dock siblings (including `h-0` wrappers holding `-translate-y-full`
    // "Scroll to end" buttons) that overlap the conversation clip.
    const dock = input && getSnapshotPinningNode(input, container);
    if (dock) {
      for (let node = input; node; node = getParentOrShadowHost(node)) {
        if (node !== input && node.style && !session.quietedElements.has(node)) {
          const nodeStyle = window.getComputedStyle(node);
          if (nodeStyle.boxShadow && nodeStyle.boxShadow !== 'none') {
            session.quietedElements.add(node);
            session.savedStyles.push(saveSnapshotInlineStyle(node, 'box-shadow'));
            node.style.setProperty('box-shadow', 'none', 'important');
            changed = true;
          }
        }
        if (node === dock) {
          break;
        }
        const parent = node.parentElement;
        if (!parent) {
          continue;
        }
        for (const sibling of parent.children) {
          if (
            sibling !== node &&
            !hidden.has(sibling) &&
            sibling.style &&
            !(session.matchElement && deepContains(sibling, session.matchElement)) &&
            window.getComputedStyle(sibling).display !== 'none' &&
            subtreeOverlapsSnapshotClip(sibling, clip)
          ) {
            hide(sibling);
          }
        }
      }
    }
    return changed;
  }

  function restoreSnapshotPage(session) {
    if (!session) {
      return;
    }
    restoreSnapshotInlineStyles(session.savedStyles);
    session.savedStyles = [];
    session.hiddenPseudos.forEach((value, element) => {
      if (value === null) {
        element.removeAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE);
      } else {
        element.setAttribute(SNAPSHOT_HIDE_PSEUDO_ATTRIBUTE, value);
      }
    });
    session.hiddenPseudos.clear();
    session.hidesScrollbar = false;
    session.hiddenElements.clear();
    session.unmaskedElements.clear();
    session.unstuckElements.clear();
    session.keptStickyElements.clear();
    session.quietedElements.clear();
    document.documentElement.removeAttribute(SNAPSHOT_HIDE_CURSOR_ATTRIBUTE);
    removeSnapshotStyles();
  }

  function waitForSnapshotPaint() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      setTimeout(finish, SNAPSHOT_PAINT_TIMEOUT_MS);
      if (typeof window.requestAnimationFrame !== 'function') {
        setTimeout(finish, SNAPSHOT_PAINT_SETTLE_MS);
        return;
      }
      window.requestAnimationFrame(() =>
        window.requestAnimationFrame(() => setTimeout(finish, SNAPSHOT_PAINT_SETTLE_MS))
      );
    });
  }

  async function settleSnapshotScreen(session) {
    await waitForSnapshotPaint();
    if (!session.hideFloating) {
      return;
    }
    for (let pass = 0; pass < 2; pass += 1) {
      const unstuck = session.stitch && unstickSnapshotContent(session);
      const hidden = hideSnapshotFloatingElements(session);
      if (!unstuck && !hidden) {
        break;
      }
      await waitForSnapshotPaint();
    }
  }

  function postSnapshotState(requestId, session, providerId, extra = {}) {
    const container = session?.container || null;
    postToMultiPanelHost({
      type: FRAME_TO_HOST.PANELIZE_SNAPSHOT_STATE,
      context: MULTI_PANEL_SNAPSHOT_CONTEXT,
      requestId,
      sessionId: session?.id || null,
      provider: providerId || session?.provider || knownProviderId || null,
      matched: Boolean(session?.matched),
      alignedBy: session?.alignedBy || null,
      scrollTop: container ? getSnapshotScrollTop(container) : 0,
      maxScrollTop: container ? getSnapshotMaxScrollTop(container) : 0,
      originalScrollTop: container ? (session.scrolled.get(container)?.top ?? null) : null,
      clip: session?.clip || null,
      viewport: getSnapshotViewport(),
      ...extra,
    });
  }

  function useSnapshotContainer(session, container) {
    if (session.container === container) {
      return;
    }
    session.container = container;
    if (!session.scrolled.has(container)) {
      const top = getSnapshotScrollTop(container);
      const maxScrollTop = getSnapshotMaxScrollTop(container);
      session.scrolled.set(container, {
        top,
        maxScrollTop,
        atEnd: top >= maxScrollTop - SNAPSHOT_ALIGN_TOLERANCE_PX,
      });
    }
    session.keptStickyElements.clear();
    if (session.stitch) {
      unstickSnapshotContent(session);
    }
    session.clip = getSnapshotClip(container);
  }

  function alignSnapshotElement(session, { element, container }, alignedBy) {
    useSnapshotContainer(session, container);
    const before = getSnapshotScrollTop(container);
    const elementTop = element.getBoundingClientRect().top;
    const target = clampSnapshotScrollTop(
      container,
      before + elementTop - session.clip.top - SNAPSHOT_ALIGN_MARGIN_PX
    );
    scrollSnapshotContainer(container, target);
    const after = getSnapshotScrollTop(container);
    const moved = elementTop - element.getBoundingClientRect().top;
    if (
      Math.abs(after - target) > SNAPSHOT_ALIGN_TOLERANCE_PX ||
      Math.abs(moved - (after - before)) > SNAPSHOT_ALIGN_TOLERANCE_PX
    ) {
      scrollSnapshotContainer(container, before);
      return false;
    }
    session.alignedBy = alignedBy;
    session.alignTarget = target;
    session.matched = alignedBy === 'prompt';
    session.matchElement = element;
    return true;
  }

  async function handleSnapshotPrepare(data, providerId) {
    restoreSnapshotPage(snapshotSession);
    snapshotSession = null;
    const stitch = Boolean(data.stitch);
    const session = {
      id: data.sessionId,
      provider: providerId || knownProviderId || null,
      stitch,
      scrolledFrame: false,
      hideFloating: stitch || Boolean(data.hideFloating),
      container: null,
      clip: null,
      matched: false,
      alignedBy: null,
      alignTarget: null,
      matchElement: null,
      scrolled: new Map(),
      hiddenElements: new Set(),
      unmaskedElements: new Set(),
      unstuckElements: new Set(),
      keptStickyElements: new Set(),
      quietedElements: new Set(),
      hiddenPseudos: new Map(),
      hidesScrollbar: false,
      savedStyles: [],
    };
    snapshotSession = session;
    if (data.hideCursor) {
      installSnapshotStyles();
      document.documentElement.setAttribute(SNAPSHOT_HIDE_CURSOR_ATTRIBUTE, '');
    }

    const main = findMainSnapshotScrollContainer();
    useSnapshotContainer(session, main);
    if (data.align && typeof data.prompt === 'string') {
      const matches = findSnapshotPromptMatches(data.prompt, main);
      for (let i = 0; i < matches.length; i += 1) {
        if (alignSnapshotElement(session, matches[i], 'prompt')) {
          break;
        }
      }
    }
    if (!session.alignedBy && stitch) {
      const turn = findSnapshotUserTurn(main);
      if (turn) {
        alignSnapshotElement(session, turn, 'user-turn');
      }
    }
    if (!session.alignedBy && stitch) {
      useSnapshotContainer(session, main);
      scrollSnapshotContainer(main, 0);
      session.alignedBy = 'top';
      session.alignTarget = 0;
    }

    if (session.alignedBy || session.hideFloating) {
      await settleSnapshotScreen(session);
    }
    const isOffTarget = () =>
      session.alignTarget !== null &&
      Math.abs(getSnapshotScrollTop(session.container) - session.alignTarget) >
        SNAPSHOT_ALIGN_TOLERANCE_PX;
    if (isOffTarget()) {
      scrollSnapshotContainer(session.container, session.alignTarget);
      await settleSnapshotScreen(session);
    }
    if (isOffTarget()) {
      session.alignedBy = null;
      session.alignTarget = null;
      session.matched = false;
      postSnapshotState(data.requestId, session, providerId, stitch ? { error: 'unaligned' } : {});
      return;
    }
    postSnapshotState(data.requestId, session, providerId);
  }

  async function handleSnapshotScroll(data, providerId) {
    const session = snapshotSession;
    if (!session || session.id !== data.sessionId || typeof data.scrollTop !== 'number') {
      postSnapshotState(data.requestId, null, providerId, { error: 'no-session' });
      return;
    }
    session.scrolledFrame = true;
    scrollSnapshotContainer(session.container, data.scrollTop);
    await settleSnapshotScreen(session);
    postSnapshotState(data.requestId, session, providerId);
  }

  function restoreSnapshotScrollPositions(positions, onlyHeldBack) {
    let scrolled = false;
    let heldBack = false;
    for (const [container, position] of positions) {
      const current = getSnapshotScrollTop(container);
      if (
        onlyHeldBack &&
        (position.heldAt === undefined || Math.abs(current - position.heldAt) > 1)
      ) {
        continue;
      }
      const max = getSnapshotMaxScrollTop(container);
      const target = position.atEnd ? max : position.top;
      if (Math.abs(current - target) > 1) {
        scrollSnapshotContainer(container, target);
        scrolled = true;
      }
      const needed = position.atEnd ? position.maxScrollTop : position.top;
      const reached = getSnapshotMaxScrollTop(container);
      position.heldAt = reached < needed - 1 ? getSnapshotScrollTop(container) : undefined;
      heldBack = heldBack || position.heldAt !== undefined;
    }
    return { scrolled, heldBack };
  }

  async function handleSnapshotRestore(data, providerId) {
    const session = snapshotSession;
    if (!session || session.id !== data.sessionId) {
      postSnapshotState(data.requestId, null, providerId, { error: 'no-session' });
      return;
    }
    snapshotSession = null;
    restoreSnapshotPage(session);
    const positions = Array.from(session.scrolled).reverse();
    let { scrolled, heldBack } = restoreSnapshotScrollPositions(positions, false);
    for (
      let attempt = 0;
      heldBack && !snapshotSession && attempt < SNAPSHOT_RESTORE_ATTEMPTS;
      attempt += 1
    ) {
      await waitForSnapshotPaint();
      scrolled = false;
      ({ heldBack } = restoreSnapshotScrollPositions(positions, true));
    }
    if (scrolled) {
      await waitForSnapshotPaint();
    }
    postSnapshotState(data.requestId, session, providerId, { restored: true });
  }

  function handleHostMessage(event) {
    if (!event || !event.data || typeof event.data !== 'object') {
      return;
    }

    if (!isFromMultiPanelHost(event)) {
      return;
    }

    const { type, context } = event.data;
    if (context !== MULTI_PANEL_CONTEXT && type !== HOST_TO_FRAME.INJECT_TEXT) {
      return;
    }

    const hadProviderId = Boolean(knownProviderId);
    const providerId = resolveProviderId(event.data);
    if (!hadProviderId && knownProviderId) {
      reportLocationIfChanged(true);
    }

    if (
      (type === HOST_TO_FRAME.PANELIZE_SNAPSHOT_PREPARE ||
        type === HOST_TO_FRAME.PANELIZE_SNAPSHOT_SCROLL ||
        type === HOST_TO_FRAME.PANELIZE_SNAPSHOT_RESTORE) &&
      context === MULTI_PANEL_CONTEXT
    ) {
      const handler =
        type === HOST_TO_FRAME.PANELIZE_SNAPSHOT_PREPARE
          ? handleSnapshotPrepare
          : type === HOST_TO_FRAME.PANELIZE_SNAPSHOT_SCROLL
            ? handleSnapshotScroll
            : handleSnapshotRestore;
      handler(event.data, providerId).catch(() => {
        postSnapshotState(event.data.requestId, null, providerId, { error: 'failed' });
      });
      return;
    }

    if (type === HOST_TO_FRAME.PANELIZE_CUSTOM_FRAME_PING && context === MULTI_PANEL_CONTEXT) {
      if (providerId && typeof event.data.requestId === 'string' && event.data.requestId.length > 0) {
        postToMultiPanelHost({
          type: FRAME_TO_HOST.PANELIZE_CUSTOM_FRAME_PONG,
          provider: providerId,
          requestId: event.data.requestId,
          context: MULTI_PANEL_PROVIDER_STATUS_CONTEXT,
        });
      }
      return;
    }

    if (type === HOST_TO_FRAME.PANELIZE_RESTORE_USER_FOCUS && context === MULTI_PANEL_CONTEXT) {
      restoreUserFocus();
      return;
    }

    if (type === HOST_TO_FRAME.ENABLE_TEMP_CHAT && context === MULTI_PANEL_CONTEXT) {
      void handleEnableTempChat(providerId);
      return;
    }

    if (type === HOST_TO_FRAME.DISABLE_TEMP_CHAT && context === MULTI_PANEL_CONTEXT) {
      void handleDisableTempChat(providerId);
      return;
    }

    if (type === HOST_TO_FRAME.CLEAR_INPUT && context === MULTI_PANEL_CONTEXT) {
      stopUserInteractionTracking();
      const composer = findComposerElement();
      if (event.data.clearImages === true) {
        clearComposerAttachments(composer);
      }
      if (composer) {
        clearComposer(composer);
      }
      return;
    }

    if (type === HOST_TO_FRAME.TRIGGER_SEND && context === MULTI_PANEL_CONTEXT) {
      if (event.data.requestId && providerId) {
        startUserInteractionTracking(event.data.requestId, providerId);
      } else {
        stopUserInteractionTracking();
      }
      const composer = findComposerElement();
      void triggerSendWithSettle(composer, { waitForEnabledMs: 300 });
      return;
    }

    if (type === HOST_TO_FRAME.INJECT_TEXT_WITH_IMAGES && context === MULTI_PANEL_CONTEXT) {
      void handleFillWithResult(event.data, providerId);
      return;
    }

    if (type === HOST_TO_FRAME.INJECT_TEXT) {
      void handleInjectText(event.data, providerId);
    }
  }

  function setupServiceWorkerFramingHygiene() {
    void sanitizeFramingServiceWorkerAndCaches();
    const resanitize = () => {
      void sanitizeFramingServiceWorkerAndCaches();
      setTimeout(() => {
        void sanitizeFramingServiceWorkerAndCaches();
      }, 800);
      setTimeout(() => {
        void sanitizeFramingServiceWorkerAndCaches();
      }, 3500);
    };
    window.addEventListener('load', resanitize, { once: true });
    try {
      const swContainer = window.navigator && window.navigator.serviceWorker;
      if (swContainer && typeof swContainer.addEventListener === 'function') {
        swContainer.addEventListener('controllerchange', () => {
          void sanitizeFramingServiceWorkerAndCaches();
        });
      }
    } catch {
      // Ignore environments where serviceWorker events are unavailable.
    }
  }

  setupServiceWorkerFramingHygiene();
  setupLocationReporting();
  window.addEventListener('message', handleHostMessage);
})();
