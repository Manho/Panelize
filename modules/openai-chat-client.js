export class ChatApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number | null, code?: string }} [options]
   */
  constructor(message, { status = null, code = 'api_error' } = {}) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.code = code;
  }
}

const MAX_ERROR_BODY_CHARS = 16384;

/**
 * Resolves a user-entered OpenAI-compatible base URL or full endpoint URL into
 * the concrete Chat Completions POST endpoint URL.
 *
 * Examples:
 * - `http://localhost:11434` -> `http://localhost:11434/v1/chat/completions`
 * - `http://localhost:11434/v1/` -> `http://localhost:11434/v1/chat/completions`
 * - `https://openrouter.ai/api/v1` -> `https://openrouter.ai/api/v1/chat/completions`
 * - `https://open.bigmodel.cn/api/paas/v4` -> `https://open.bigmodel.cn/api/paas/v4/chat/completions`
 * - `https://api.openai.com/v1/chat/completions` -> `https://api.openai.com/v1/chat/completions`
 * - `https://res.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21` -> unchanged
 *
 * @param {string} normalizedOrRawUrl
 * @returns {string}
 */
export function resolveChatCompletionsUrl(normalizedOrRawUrl) {
  if (typeof normalizedOrRawUrl !== 'string' || normalizedOrRawUrl.trim().length === 0) {
    throw new ChatApiError('Invalid API endpoint URL', { code: 'invalid_endpoint' });
  }

  let parsed;
  try {
    parsed = new URL(normalizedOrRawUrl.trim());
  } catch {
    throw new ChatApiError('Invalid API endpoint URL', { code: 'invalid_endpoint' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ChatApiError('API endpoint URL must use http:// or https://', {
      code: 'invalid_endpoint'
    });
  }

  if (parsed.username || parsed.password) {
    throw new ChatApiError('API endpoint URL must not include embedded credentials', {
      code: 'invalid_endpoint'
    });
  }

  parsed.hash = '';

  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  if (trimmedPath === '') {
    parsed.pathname = '/v1/chat/completions';
  } else if (trimmedPath.endsWith('/chat/completions')) {
    parsed.pathname = trimmedPath;
  } else {
    parsed.pathname = `${trimmedPath}/chat/completions`;
  }

  return parsed.toString();
}

const MAX_MODEL_ID_CHARS = 200;

/**
 * Resolves a user-entered OpenAI-compatible base URL or full endpoint URL into
 * the concrete `GET .../models` discovery endpoint URL.
 *
 * Examples:
 * - `http://localhost:11434` -> `http://localhost:11434/v1/models`
 * - `https://openrouter.ai/api/v1` -> `https://openrouter.ai/api/v1/models`
 * - `https://openrouter.ai/api/v1/chat/completions` -> `https://openrouter.ai/api/v1/models`
 * - `https://api.openai.com/v1/models` -> `https://api.openai.com/v1/models`
 *
 * @param {string} normalizedOrRawUrl
 * @returns {string}
 */
export function resolveModelsUrl(normalizedOrRawUrl) {
  if (typeof normalizedOrRawUrl !== 'string' || normalizedOrRawUrl.trim().length === 0) {
    throw new ChatApiError('Invalid API endpoint URL', { code: 'invalid_endpoint' });
  }

  let parsed;
  try {
    parsed = new URL(normalizedOrRawUrl.trim());
  } catch {
    throw new ChatApiError('Invalid API endpoint URL', { code: 'invalid_endpoint' });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ChatApiError('API endpoint URL must use http:// or https://', {
      code: 'invalid_endpoint'
    });
  }

  if (parsed.username || parsed.password) {
    throw new ChatApiError('API endpoint URL must not include embedded credentials', {
      code: 'invalid_endpoint'
    });
  }

  parsed.hash = '';

  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  if (trimmedPath === '') {
    parsed.pathname = '/v1/models';
  } else if (trimmedPath.endsWith('/chat/completions')) {
    const prefix = trimmedPath.slice(0, -'/chat/completions'.length);
    parsed.pathname = `${prefix || '/v1'}/models`;
  } else if (trimmedPath.endsWith('/models')) {
    parsed.pathname = trimmedPath;
  } else {
    parsed.pathname = `${trimmedPath}/models`;
  }

  return parsed.toString();
}

function normalizeModelCatalogEntries(parsedBody) {
  const rawList = Array.isArray(parsedBody?.data)
    ? parsedBody.data
    : Array.isArray(parsedBody?.models)
      ? parsedBody.models
      : Array.isArray(parsedBody)
        ? parsedBody
        : null;

  if (!rawList) {
    throw new ChatApiError('Endpoint response did not contain a models array', {
      code: 'invalid_models_payload'
    });
  }

  const seenIds = new Set();
  const models = [];

  for (const item of rawList) {
    let rawId = '';
    let rawName = '';

    if (typeof item === 'string') {
      rawId = item.trim();
    } else if (item && typeof item === 'object') {
      if (typeof item.id === 'string' && item.id.trim().length > 0) {
        rawId = item.id.trim();
        rawName =
          typeof item.name === 'string'
            ? item.name.trim()
            : typeof item.display_name === 'string'
              ? item.display_name.trim()
              : typeof item.displayName === 'string'
                ? item.displayName.trim()
                : '';
      } else if (typeof item.model === 'string' && item.model.trim().length > 0) {
        rawId = item.model.trim();
        rawName = typeof item.name === 'string' ? item.name.trim() : '';
      } else if (typeof item.name === 'string' && item.name.trim().length > 0) {
        rawId = item.name.trim();
        rawName =
          typeof item.displayName === 'string'
            ? item.displayName.trim()
            : typeof item.display_name === 'string'
              ? item.display_name.trim()
              : '';
      }
    }

    if (
      rawId.length === 0 ||
      rawId.length > MAX_MODEL_ID_CHARS ||
      seenIds.has(rawId)
    ) {
      continue;
    }

    seenIds.add(rawId);
    models.push({
      id: rawId,
      name: rawName && rawName !== rawId ? rawName : null
    });
  }

  return models;
}

/**
 * Fetches available models from an OpenAI-compatible `GET .../models` endpoint.
 *
 * @param {{
 *   endpointUrl: string,
 *   apiKey?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch
 * }} params
 * @returns {Promise<{ modelsUrl: string, models: Array<{ id: string, name: string | null }> }>}
 */
export async function fetchOpenAiModels({
  endpointUrl,
  apiKey = '',
  signal,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch
}) {
  if (typeof endpointUrl !== 'string' || endpointUrl.trim().length === 0) {
    throw new ChatApiError('Endpoint URL is required', { code: 'invalid_endpoint' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ChatApiError('Fetch API is unavailable', { code: 'network_error' });
  }

  const modelsUrl = resolveModelsUrl(endpointUrl.trim());
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';

  const headers = {
    Accept: 'application/json'
  };
  if (trimmedKey.length > 0) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  const controller = new AbortController();
  let timedOut = false;
  let timeoutId = null;
  const originLabel = new URL(modelsUrl).origin;

  const makeAbortError = () => {
    const abortErr = new Error('Request aborted');
    abortErr.name = 'AbortError';
    return abortErr;
  };

  const makeTimeoutError = () =>
    new ChatApiError(`Timed out loading models from ${originLabel}`, {
      code: 'timeout_error'
    });

  const throwIfTerminated = () => {
    if (timedOut) {
      throw makeTimeoutError();
    }
    if (controller.signal.aborted || signal?.aborted) {
      throw makeAbortError();
    }
  };

  const awaitWithSignal = (promise) => {
    if (controller.signal.aborted || signal?.aborted) {
      Promise.resolve(promise).catch(() => {});
      return Promise.reject(timedOut ? makeTimeoutError() : makeAbortError());
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        Promise.resolve(promise).catch(() => {});
        reject(timedOut ? makeTimeoutError() : makeAbortError());
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  };

  const onExternalAbort = () => {
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      throw makeAbortError();
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    let response;
    try {
      response = await awaitWithSignal(
        fetchImpl(modelsUrl, {
          method: 'GET',
          headers,
          signal: controller.signal
        })
      );
    } catch (error) {
      throwIfTerminated();
      if (error?.name === 'AbortError') {
        throw makeAbortError();
      }
      throw new ChatApiError(
        `Network error reaching ${originLabel}: ${error?.message || 'Failed to fetch'}`,
        { code: 'network_error' }
      );
    }

    throwIfTerminated();

    if (!response.ok) {
      let errorBody = '';
      if (typeof response.text === 'function') {
        try {
          errorBody = await awaitWithSignal(response.text());
        } catch (error) {
          throwIfTerminated();
          if (error?.name === 'AbortError') {
            throw makeAbortError();
          }
          errorBody = '';
        }
      }
      throwIfTerminated();
      throw buildHttpStatusError(response.status, response.statusText, errorBody);
    }

    let parsedBody;
    if (typeof response.text === 'function') {
      let bodyText = '';
      try {
        bodyText = await awaitWithSignal(response.text());
      } catch (error) {
        throwIfTerminated();
        if (error?.name === 'AbortError') {
          throw makeAbortError();
        }
        throw new ChatApiError('Failed to read models response body', {
          code: 'invalid_models_payload'
        });
      }
      throwIfTerminated();
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        throw new ChatApiError('Endpoint did not return valid JSON for /models', {
          code: 'invalid_models_json'
        });
      }
    } else if (typeof response.json === 'function') {
      try {
        parsedBody = await awaitWithSignal(response.json());
      } catch (error) {
        throwIfTerminated();
        if (error?.name === 'AbortError') {
          throw makeAbortError();
        }
        throw new ChatApiError('Endpoint did not return valid JSON for /models', {
          code: 'invalid_models_json'
        });
      }
      throwIfTerminated();
    } else {
      throw new ChatApiError('Failed to read models response body', {
        code: 'invalid_models_payload'
      });
    }

    const models = normalizeModelCatalogEntries(parsedBody);
    return { modelsUrl, models };
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    signal?.removeEventListener?.('abort', onExternalAbort);
  }
}

const SAFE_IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

/**
 * Formats conversation turns into OpenAI-compatible `messages` array.
 * Uses plain string `content` when a user turn has no images so text-only
 * local servers accept the payload, and OpenAI multimodal content parts when
 * images are attached. Idempotent when given already-formatted OpenAI messages.
 *
 * @param {Array<{ role: 'system' | 'user' | 'assistant', content?: string | Array<object>, text?: string, images?: Array<{ dataUrl: string }> }>} turns
 * @returns {Array<{ role: string, content: string | Array<object> }>}
 */
export function buildOpenAiChatMessages(turns) {
  if (!Array.isArray(turns)) {
    return [];
  }

  const formatted = [];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') {
      continue;
    }
    const role = turn.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      continue;
    }

    if (Array.isArray(turn.content)) {
      const parts = [];
      for (const part of turn.content) {
        if (!part || typeof part !== 'object') {
          continue;
        }
        if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
          parts.push({ type: 'text', text: part.text });
        } else if (
          role === 'user' &&
          part.type === 'image_url' &&
          typeof part.image_url?.url === 'string' &&
          SAFE_IMAGE_DATA_URL_PATTERN.test(part.image_url.url)
        ) {
          parts.push({
            type: 'image_url',
            image_url: { url: part.image_url.url }
          });
        }
      }
      formatted.push({ role, content: parts });
      continue;
    }

    const text =
      typeof turn.content === 'string'
        ? turn.content
        : (typeof turn.text === 'string' ? turn.text : '');
    const validImages = role === 'user' && Array.isArray(turn.images)
      ? turn.images.filter(
          (img) =>
            img &&
            typeof img.dataUrl === 'string' &&
            SAFE_IMAGE_DATA_URL_PATTERN.test(img.dataUrl)
        )
      : [];

    if (validImages.length > 0) {
      const parts = [];
      if (text.length > 0) {
        parts.push({ type: 'text', text });
      }
      for (const img of validImages) {
        parts.push({
          type: 'image_url',
          image_url: { url: img.dataUrl }
        });
      }
      formatted.push({ role, content: parts });
    } else {
      formatted.push({ role, content: text });
    }
  }

  return formatted;
}

function extractTextPiece(raw) {
  if (typeof raw === 'string') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractChoiceDelta(choice) {
  if (!choice || typeof choice !== 'object') {
    return { contentDelta: '', reasoningDelta: '' };
  }
  const container = choice.delta && typeof choice.delta === 'object'
    ? choice.delta
    : (choice.message && typeof choice.message === 'object' ? choice.message : null);

  if (!container) {
    return { contentDelta: '', reasoningDelta: '' };
  }

  const contentDelta = extractTextPiece(container.content);
  const reasoningDelta = extractTextPiece(
    container.reasoning_content ?? container.reasoning ?? ''
  );

  return { contentDelta, reasoningDelta };
}

function extractUpstreamMetadataDetail(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }
  const providerName =
    typeof metadata.provider_name === 'string' ? metadata.provider_name.trim() : '';
  const raw = typeof metadata.raw === 'string' ? metadata.raw.trim() : '';
  let rawMessage = raw;
  if (raw.startsWith('{')) {
    try {
      const parsedRaw = JSON.parse(raw);
      const inner =
        parsedRaw?.error?.message ??
        (typeof parsedRaw?.error === 'string' ? parsedRaw.error : null) ??
        parsedRaw?.message;
      if (typeof inner === 'string' && inner.trim().length > 0) {
        rawMessage = inner.trim();
      }
    } catch {
      // Keep plain string `metadata.raw` when it is not JSON.
    }
  }
  rawMessage = rawMessage.replace(/\s+/g, ' ').trim();
  if (!rawMessage) {
    return providerName;
  }
  if (providerName && !rawMessage.toLowerCase().includes(providerName.toLowerCase())) {
    return `[${providerName}] ${rawMessage}`;
  }
  return rawMessage;
}

function extractServerErrorDetail(bodyText) {
  if (typeof bodyText !== 'string') {
    return '';
  }
  const trimmed = bodyText.trim().slice(0, MAX_ERROR_BODY_CHARS);
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = JSON.parse(trimmed);
    const candidate =
      parsed?.error?.message ??
      (typeof parsed?.error === 'string' ? parsed.error : null) ??
      parsed?.message ??
      parsed?.detail;
    const metadataDetail = extractUpstreamMetadataDetail(parsed?.error?.metadata);

    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      const cleanCandidate = candidate.trim();
      if (metadataDetail) {
        if (/^provider returned error\.?$/i.test(cleanCandidate)) {
          return metadataDetail.slice(0, 500);
        }
        if (!cleanCandidate.includes(metadataDetail)) {
          return `${cleanCandidate} (${metadataDetail})`.slice(0, 500);
        }
      }
      return cleanCandidate.slice(0, 500);
    }
    if (metadataDetail) {
      return metadataDetail.slice(0, 500);
    }
  } catch {
    // Fall back to plain-text snippet when server returns non-JSON error text.
  }

  // Collapse whitespace and keep a concise snippet.
  return trimmed.replace(/\s+/g, ' ').slice(0, 300);
}

function buildHttpStatusError(status, statusText, bodyText) {
  const detail = extractServerErrorDetail(bodyText);
  const statusLabel = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;

  let code = 'http_error';
  let prefix = `Request rejected (${statusLabel})`;
  if (status === 401) {
    code = 'unauthorized';
    prefix = `Authentication failed (${statusLabel})`;
  } else if (status === 403) {
    code = 'forbidden';
    prefix = `Access forbidden (${statusLabel})`;
  } else if (status === 404) {
    code = 'not_found';
    prefix = `Endpoint or model not found (${statusLabel})`;
  } else if (status === 429) {
    code = 'rate_limited';
    prefix = `Rate limit or quota exceeded (${statusLabel})`;
  } else if (status >= 500) {
    code = 'server_error';
    prefix = `API server error (${statusLabel})`;
  }

  const message = detail ? `${prefix}: ${detail}` : `${prefix}.`;
  return new ChatApiError(message, { status, code });
}

function isCompleteSsePayload(rawData) {
  const trimmed = rawData.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === '[DONE]') {
    return true;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function parseAndEmitPayload(rawData, state, onDelta) {
  const trimmed = rawData.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === '[DONE]') {
    return true;
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ChatApiError('Received malformed JSON chunk from API stream', {
      code: 'invalid_stream_json'
    });
  }

  if (parsed && typeof parsed === 'object' && parsed.error) {
    const detail = extractServerErrorDetail(trimmed) || 'Stream returned an error';
    const rawStatus = parsed.error?.status ?? parsed.error?.code;
    throw new ChatApiError(detail, {
      status: Number.isInteger(rawStatus) ? rawStatus : null,
      code: 'stream_error'
    });
  }

  const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
  if (choices.length === 0) {
    return false;
  }

  if (typeof choices[0]?.finish_reason === 'string' && choices[0].finish_reason) {
    state.finishReason = choices[0].finish_reason;
  }

  const { contentDelta, reasoningDelta } = extractChoiceDelta(choices[0]);
  if (contentDelta || reasoningDelta) {
    state.content += contentDelta;
    state.reasoning += reasoningDelta;
    onDelta?.({
      contentDelta,
      reasoningDelta
    });
  }
  return false;
}

/**
 * Streams an OpenAI-compatible Chat Completion response over `fetch` SSE,
 * with automatic fallback when an endpoint returns a non-streaming JSON body.
 *
 * @param {{
 *   endpointUrl: string,
 *   apiKey?: string,
 *   model: string,
 *   messages: Array<{ role: 'system' | 'user' | 'assistant', content?: string, images?: Array<{ dataUrl: string }> }>,
 *   signal?: AbortSignal,
 *   connectTimeoutMs?: number,
 *   idleTimeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   onDelta?: (delta: { contentDelta: string, reasoningDelta: string, content: string, reasoning: string }) => void
 * }} params
 * @returns {Promise<{ content: string, reasoning: string }>}
 */
export async function streamChatCompletion({
  endpointUrl,
  apiKey = '',
  model,
  messages,
  signal,
  connectTimeoutMs = 30_000,
  idleTimeoutMs = 60_000,
  fetchImpl = globalThis.fetch,
  onDelta
}) {
  if (typeof endpointUrl !== 'string' || endpointUrl.trim().length === 0) {
    throw new ChatApiError('Endpoint URL is required', { code: 'invalid_endpoint' });
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    throw new ChatApiError('Model ID is required', { code: 'invalid_model' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new ChatApiError('Fetch API is unavailable', { code: 'network_error' });
  }

  const resolvedUrl = resolveChatCompletionsUrl(endpointUrl.trim());
  const originLabel = new URL(resolvedUrl).origin;
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const formattedMessages = buildOpenAiChatMessages(messages);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json'
  };
  if (trimmedKey.length > 0) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  const controller = new AbortController();
  let timedOut = false;
  let activeTimerId = null;

  const clearActiveTimer = () => {
    if (activeTimerId !== null) {
      clearTimeout(activeTimerId);
      activeTimerId = null;
    }
  };

  const armTimer = (ms) => {
    clearActiveTimer();
    if (Number.isFinite(ms) && ms > 0) {
      activeTimerId = setTimeout(() => {
        activeTimerId = null;
        if (!signal?.aborted) {
          timedOut = true;
          controller.abort();
        }
      }, ms);
    }
  };

  const makeAbortError = () => {
    const abortErr = new Error('Request aborted');
    abortErr.name = 'AbortError';
    return abortErr;
  };

  const makeTimeoutError = () =>
    new ChatApiError(`Timed out waiting for response from ${originLabel}`, {
      code: 'timeout_error'
    });

  const throwIfTerminated = () => {
    if (signal?.aborted) {
      throw makeAbortError();
    }
    if (timedOut) {
      throw makeTimeoutError();
    }
    if (controller.signal.aborted) {
      throw makeAbortError();
    }
  };

  const awaitWithSignal = (promise) => {
    if (controller.signal.aborted || signal?.aborted) {
      Promise.resolve(promise).catch(() => {});
      return Promise.reject(
        signal?.aborted ? makeAbortError() : (timedOut ? makeTimeoutError() : makeAbortError())
      );
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        Promise.resolve(promise).catch(() => {});
        reject(
          signal?.aborted ? makeAbortError() : (timedOut ? makeTimeoutError() : makeAbortError())
        );
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(promise).then(
        (value) => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err) => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  };

  const onExternalAbort = () => {
    clearActiveTimer();
    controller.abort();
  };

  if (signal) {
    if (signal.aborted) {
      throw makeAbortError();
    }
    signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    armTimer(connectTimeoutMs);

    let response;
    try {
      response = await awaitWithSignal(
        fetchImpl(resolvedUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model.trim(),
            messages: formattedMessages,
            stream: true
          }),
          signal: controller.signal
        })
      );
    } catch (error) {
      throwIfTerminated();
      if (error?.name === 'AbortError') {
        throw makeAbortError();
      }
      throw new ChatApiError(
        `Network error reaching ${originLabel}: ${error?.message || 'Failed to fetch'}`,
        { code: 'network_error' }
      );
    }

    throwIfTerminated();

    if (!response.ok) {
      let errorBody = '';
      if (typeof response.text === 'function') {
        try {
          errorBody = await awaitWithSignal(response.text());
        } catch (error) {
          throwIfTerminated();
          if (error?.name === 'AbortError') {
            throw makeAbortError();
          }
          errorBody = '';
        }
      }
      clearActiveTimer();
      throwIfTerminated();
      throw buildHttpStatusError(response.status, response.statusText, errorBody);
    }

    const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
    const state = { content: '', reasoning: '', finishReason: null };

    if (!response.body || contentType.includes('application/json')) {
      let bodyText = '';
      try {
        bodyText = await awaitWithSignal(response.text());
      } catch (error) {
        throwIfTerminated();
        if (error?.name === 'AbortError') {
          throw makeAbortError();
        }
        throw error;
      }
      clearActiveTimer();
      throwIfTerminated();
      parseAndEmitPayload(bodyText, state, onDelta);
      return state;
    }

    clearActiveTimer();
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuffer = '';
    let eventDataLines = [];
    let doneReceived = false;

    const flushBufferedEvent = () => {
      if (eventDataLines.length === 0) {
        return;
      }
      const eventPayload = eventDataLines.join('\n');
      eventDataLines = [];
      if (parseAndEmitPayload(eventPayload, state, onDelta)) {
        doneReceived = true;
      }
    };

    const processLine = (rawLine) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        flushBufferedEvent();
        return;
      }

      if (line.startsWith(':')) {
        return;
      }

      if (line.startsWith('data:')) {
        if (eventDataLines.length > 0 && isCompleteSsePayload(eventDataLines.join('\n'))) {
          flushBufferedEvent();
          if (doneReceived) {
            return;
          }
        }
        const value = line.slice(5);
        eventDataLines.push(value.startsWith(' ') ? value.slice(1) : value);
      }
    };

    try {
      while (!doneReceived) {
        armTimer(idleTimeoutMs);
        const { value, done } = await awaitWithSignal(reader.read());
        clearActiveTimer();
        throwIfTerminated();
        if (done) {
          break;
        }

        lineBuffer += decoder.decode(value, { stream: true });
        let newlineIdx = lineBuffer.indexOf('\n');
        while (newlineIdx !== -1 && !doneReceived) {
          const rawLine = lineBuffer.slice(0, newlineIdx);
          lineBuffer = lineBuffer.slice(newlineIdx + 1);
          processLine(rawLine);
          newlineIdx = lineBuffer.indexOf('\n');
        }
      }

      if (!doneReceived) {
        lineBuffer += decoder.decode();
        if (lineBuffer.length > 0) {
          const remainingLines = lineBuffer.split('\n');
          for (const rawLine of remainingLines) {
            processLine(rawLine);
            if (doneReceived) {
              break;
            }
          }
        }
        if (!doneReceived && eventDataLines.length > 0) {
          const trailingPayload = eventDataLines.join('\n');
          eventDataLines = [];
          // If a server ignored Accept: text/event-stream without setting content-type: application/json
          parseAndEmitPayload(trailingPayload, state, onDelta);
        } else if (
          !doneReceived &&
          state.content === '' &&
          state.reasoning === '' &&
          lineBuffer.trim().startsWith('{')
        ) {
          parseAndEmitPayload(lineBuffer, state, onDelta);
        }
      }
    } catch (error) {
      clearActiveTimer();
      throwIfTerminated();
      if (error?.name === 'AbortError') {
        throw makeAbortError();
      }
      throw error;
    } finally {
      clearActiveTimer();
      try {
        await reader.cancel();
      } catch {
        // Ignore reader cancel errors after completion/abort.
      }
    }

    return state;
  } finally {
    clearActiveTimer();
    signal?.removeEventListener?.('abort', onExternalAbort);
  }
}
