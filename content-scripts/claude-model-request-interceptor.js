(function initializeClaudeModelRequestInterceptor() {
  'use strict';

  if (window.self === window.top) {
    return;
  }

  const utils = globalThis.PanelizeClaudeModelRequestUtils;
  if (!utils) {
    return;
  }

  const MESSAGE_OVERRIDE = 'PANELIZE_CLAUDE_MODEL_OVERRIDE';
  const MESSAGE_PROBE = 'PANELIZE_CLAUDE_MODEL_PROBE';
  const DEFAULT_MODE = 'default';
  const MODELS_BY_MODE = Object.freeze({
    'sonnet-5': 'claude-sonnet-5',
    'opus-4-8': 'claude-opus-4-8',
    'haiku-4-5': 'claude-haiku-4-5-20251001'
  });
  const overrideState = {
    mode: DEFAULT_MODE,
    model: ''
  };

  function reportProbe(event, details = {}) {
    window.parent.postMessage({
      type: MESSAGE_PROBE,
      event,
      ...details
    }, '*');
  }

  function isPanelizeParentMessage(event) {
    return event.source === window.parent &&
      typeof event.origin === 'string' &&
      event.origin.startsWith('chrome-extension://');
  }

  function disableOverride(event, details = {}) {
    overrideState.mode = DEFAULT_MODE;
    overrideState.model = '';
    reportProbe(event, details);
  }

  window.addEventListener('message', event => {
    if (!isPanelizeParentMessage(event) || event.data?.type !== MESSAGE_OVERRIDE) {
      return;
    }

    const mode = typeof event.data.mode === 'string' ? event.data.mode : DEFAULT_MODE;
    const expectedModel = MODELS_BY_MODE[mode] || '';
    const requestedModel = typeof event.data.model === 'string' ? event.data.model : '';

    if (mode === DEFAULT_MODE && !requestedModel) {
      overrideState.mode = DEFAULT_MODE;
      overrideState.model = '';
      reportProbe('override-configured', { mode: DEFAULT_MODE });
      return;
    }

    if (!expectedModel || requestedModel !== expectedModel || !utils.isAllowedModelId(requestedModel)) {
      disableOverride('override-config-rejected');
      return;
    }

    overrideState.mode = mode;
    overrideState.model = requestedModel;
    reportProbe('override-configured', { mode });
  });

  function rewriteBodyIfNeeded(url, body) {
    if (!overrideState.model || !utils.isClaudeCompletionUrl(url, window.location.href)) {
      return {
        body,
        overridden: false
      };
    }

    const result = utils.rewriteCompletionBody(body, overrideState.model);
    if (!result.overridden) {
      disableOverride('override-schema-unsupported', { reason: result.reason });
      return {
        body,
        overridden: false
      };
    }

    reportProbe('request-overridden', {
      mode: overrideState.mode,
      changed: result.changed !== false,
      inserted: result.inserted === true
    });
    return {
      body: result.body,
      overridden: true,
      mode: overrideState.mode
    };
  }

  function handleResponseStatus(status, requestMode) {
    const classification = utils.classifyResponseStatus(status);
    if (classification === 'accepted' && overrideState.mode === requestMode) {
      reportProbe('override-request-accepted', {
        mode: requestMode,
        status
      });
      return;
    }

    if (classification === 'rejected' && overrideState.mode === requestMode) {
      disableOverride('override-request-rejected', { status });
    }
  }

  const nativeFetch = window.fetch;
  window.fetch = async function panelizeClaudeModelFetch(input, init) {
    const inputUrl = input instanceof Request ? input.url : input;
    if (!overrideState.model || !utils.isClaudeCompletionUrl(inputUrl, window.location.href)) {
      return nativeFetch.call(this, input, init);
    }

    let requestMode = DEFAULT_MODE;
    let response;

    if (init && typeof init.body === 'string') {
      const result = rewriteBodyIfNeeded(inputUrl, init.body);
      requestMode = result.mode || DEFAULT_MODE;
      response = await nativeFetch.call(this, input, {
        ...init,
        body: result.body
      });
    } else {
      try {
        const request = input instanceof Request && !init
          ? input
          : new Request(input, init);

        if (request.bodyUsed || ['GET', 'HEAD'].includes(request.method)) {
          disableOverride('override-schema-unsupported', { reason: 'unreadable-body' });
          return nativeFetch.call(this, input, init);
        }

        const originalBody = await request.clone().text();
        const result = rewriteBodyIfNeeded(request.url, originalBody);
        requestMode = result.mode || DEFAULT_MODE;
        response = result.overridden
          ? await nativeFetch.call(this, new Request(request, { body: result.body }))
          : await nativeFetch.call(this, input, init);
      } catch (_error) {
        disableOverride('override-schema-unsupported', { reason: 'request-inspection-failed' });
        return nativeFetch.call(this, input, init);
      }
    }

    if (requestMode !== DEFAULT_MODE) {
      handleResponseStatus(response.status, requestMode);
    }
    return response;
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  const nativeXhrSend = XMLHttpRequest.prototype.send;
  const xhrMetadata = new WeakMap();

  XMLHttpRequest.prototype.open = function panelizeClaudeModelXhrOpen(method, url, ...rest) {
    xhrMetadata.set(this, {
      url: new URL(url, window.location.href).href
    });
    return nativeXhrOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function panelizeClaudeModelXhrSend(body) {
    const metadata = xhrMetadata.get(this);
    if (!metadata || !overrideState.model || !utils.isClaudeCompletionUrl(metadata.url)) {
      return nativeXhrSend.call(this, body);
    }

    const result = rewriteBodyIfNeeded(metadata.url, body);
    if (result.overridden) {
      const requestMode = result.mode;
      this.addEventListener('loadend', () => {
        handleResponseStatus(this.status, requestMode);
      }, { once: true });
    }
    return nativeXhrSend.call(this, result.body);
  };

  reportProbe('probe-ready');
})();
