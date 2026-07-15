(function initializeClaudeModelRequestUtils(globalScope) {
  'use strict';

  const CLAUDE_ORIGIN = 'https://claude.ai';
  const CLAUDE_COMPLETION_PATH_SUFFIX = '/completion';
  const ALLOWED_MODEL_IDS = new Set([
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5-20251001'
  ]);

  function isAllowedModelId(modelId) {
    return typeof modelId === 'string' && ALLOWED_MODEL_IDS.has(modelId);
  }

  function isClaudeCompletionUrl(value, baseUrl = `${CLAUDE_ORIGIN}/`) {
    try {
      const url = new URL(value, baseUrl);
      return url.origin === CLAUDE_ORIGIN &&
        url.pathname.endsWith(CLAUDE_COMPLETION_PATH_SUFFIX);
    } catch (_error) {
      return false;
    }
  }

  function rewriteCompletionBody(body, targetModel) {
    if (!isAllowedModelId(targetModel)) {
      return {
        body,
        overridden: false,
        reason: 'unsupported-model'
      };
    }

    if (typeof body !== 'string') {
      return {
        body,
        overridden: false,
        reason: 'unsupported-body'
      };
    }

    let value;
    try {
      value = JSON.parse(body);
    } catch (_error) {
      return {
        body,
        overridden: false,
        reason: 'invalid-json'
      };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {
        body,
        overridden: false,
        reason: 'unsupported-shape'
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(value, 'model') &&
      typeof value.model !== 'string'
    ) {
      return {
        body,
        overridden: false,
        reason: 'unsupported-model-field'
      };
    }

    if (value.model === targetModel) {
      return {
        body,
        overridden: true,
        changed: false,
        reason: 'already-selected'
      };
    }

    const inserted = !Object.prototype.hasOwnProperty.call(value, 'model');
    value.model = targetModel;

    return {
      body: JSON.stringify(value),
      overridden: true,
      changed: true,
      inserted,
      reason: inserted ? 'model-injected' : 'model-replaced'
    };
  }

  function classifyResponseStatus(status) {
    if (!Number.isInteger(status)) {
      return 'unknown';
    }
    if (status >= 200 && status < 300) {
      return 'accepted';
    }
    if (status >= 400 && status < 500) {
      return 'rejected';
    }
    if (status >= 500) {
      return 'server-error';
    }
    return 'unknown';
  }

  globalScope.PanelizeClaudeModelRequestUtils = {
    classifyResponseStatus,
    isAllowedModelId,
    isClaudeCompletionUrl,
    rewriteCompletionBody
  };
})(globalThis);
