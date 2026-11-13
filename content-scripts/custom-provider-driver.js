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

  const HOST_TO_FRAME = {
    INJECT_TEXT: 'INJECT_TEXT',
    INJECT_TEXT_WITH_IMAGES: 'INJECT_TEXT_WITH_IMAGES',
    TRIGGER_SEND: 'TRIGGER_SEND',
    CLEAR_INPUT: 'CLEAR_INPUT',
    PANELIZE_RESTORE_USER_FOCUS: 'PANELIZE_RESTORE_USER_FOCUS',
    PANELIZE_CUSTOM_FRAME_PING: 'PANELIZE_CUSTOM_FRAME_PING',
  };

  const FRAME_TO_HOST = {
    PANELIZE_ACTION_RESULT: 'PANELIZE_ACTION_RESULT',
    PANELIZE_PROVIDER_LOCATION: 'PANELIZE_PROVIDER_LOCATION',
    PANELIZE_PROVIDER_USER_INTERACTION: 'PANELIZE_PROVIDER_USER_INTERACTION',
    PANELIZE_CUSTOM_FRAME_PONG: 'PANELIZE_CUSTOM_FRAME_PONG',
    PANELIZE_CUSTOM_SW_RECOVERED: 'PANELIZE_CUSTOM_SW_RECOVERED',
  };

  const SW_RECOVERY_QUERY_PARAM = '__panelize_sw_recover';

  const ACTION_FAILURE_REASONS = {
    UNSUPPORTED: 'unsupported',
    CONTROL_NOT_FOUND: 'control-not-found',
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
              for (let j = 0; j < requests.length; j += 1) {
                const req = requests[j];
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

  // ===== Message Dispatch =====

  async function handleFillWithResult(eventData, providerId) {
    const { text, images, autoSubmit, requestId, retry = false } = eventData;

    if (requestId && providerId) {
      startUserInteractionTracking(requestId, providerId);
    } else {
      stopUserInteractionTracking();
    }

    // Custom generic driver does not upload images; inject text if provided and
    // return 'unsupported' immediately so the host never stalls on its preview timer.
    if (Array.isArray(images) && images.length > 0) {
      if (typeof text === 'string' && text.length > 0 && text.length <= MAX_TEXT_BYTES) {
        const composer = await findComposerWithRetry(500);
        if (composer) {
          await injectTextIntoComposer(composer, text, { skipIfAlreadyPresent: Boolean(retry) });
        }
      }
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.UNSUPPORTED,
        succeededImageIds: [],
      });
      return;
    }

    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_TEXT_BYTES) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
        succeededImageIds: [],
      });
      return;
    }

    const composer = await findComposerWithRetry(1000);
    if (!composer) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.CONTROL_NOT_FOUND,
        succeededImageIds: [],
      });
      return;
    }

    const injected = await injectTextIntoComposer(composer, text, {
      skipIfAlreadyPresent: Boolean(retry),
    });
    if (!injected) {
      postActionResult(requestId, providerId, {
        ok: false,
        reason: ACTION_FAILURE_REASONS.INJECTION_ERROR,
        succeededImageIds: [],
      });
      return;
    }

    if (autoSubmit === true) {
      await sleep(80);
      await triggerSendWithSettle(composer, { waitForEnabledMs: 700 });
    }

    postActionResult(requestId, providerId, {
      ok: true,
      succeededImageIds: [],
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

  function handleHostMessage(event) {
    if (!event || !event.data || typeof event.data !== 'object') {
      return;
    }

    if (!isFromMultiPanelHost(event)) {
      return;
    }

    const hadProviderId = Boolean(knownProviderId);
    const providerId = resolveProviderId(event.data);
    if (!hadProviderId && knownProviderId) {
      reportLocationIfChanged(true);
    }

    const { type, context } = event.data;

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

    if (type === HOST_TO_FRAME.CLEAR_INPUT && context === MULTI_PANEL_CONTEXT) {
      stopUserInteractionTracking();
      const composer = findComposerElement();
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
