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
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().slice(0, 500);
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
    const detail =
      typeof parsed.error === 'string'
        ? parsed.error
        : (typeof parsed.error?.message === 'string'
            ? parsed.error.message
            : 'Stream returned an error');
    throw new ChatApiError(detail, {
      status: Number.isInteger(parsed.error?.status) ? parsed.error.status : null,
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
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const formattedMessages = buildOpenAiChatMessages(messages);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream, application/json'
  };
  if (trimmedKey.length > 0) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  let response;
  try {
    response = await fetchImpl(resolvedUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.trim(),
        messages: formattedMessages,
        stream: true
      }),
      signal
    });
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw new ChatApiError(
      `Network error reaching ${new URL(resolvedUrl).origin}: ${error?.message || 'Failed to fetch'}`,
      { code: 'network_error' }
    );
  }

  if (!response.ok) {
    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch {
      errorBody = '';
    }
    throw buildHttpStatusError(response.status, response.statusText, errorBody);
  }

  const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
  const state = { content: '', reasoning: '', finishReason: null };

  if (!response.body || contentType.includes('application/json')) {
    const bodyText = await response.text();
    parseAndEmitPayload(bodyText, state, onDelta);
    return state;
  }

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
      const { value, done } = await reader.read();
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
    if (error?.name === 'AbortError' || signal?.aborted) {
      const abortErr = new Error('Request aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }
    throw error;
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Ignore reader cancel errors after completion/abort.
    }
  }

  return state;
}
