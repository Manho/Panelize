import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenAiChatMessages,
  ChatApiError,
  fetchOpenAiModels,
  resolveChatCompletionsUrl,
  resolveModelsUrl,
  streamChatCompletion
} from '../modules/openai-chat-client.js';

function createSseStream(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    }
  });
}

describe('openai-chat-client', () => {
  describe('resolveChatCompletionsUrl', () => {
    it('normalizes OpenAI, Ollama, OpenRouter, Zhipu, Volcengine, DashScope, Gemini, and full URLs', () => {
      expect(resolveChatCompletionsUrl('https://api.openai.com/v1')).toBe(
        'https://api.openai.com/v1/chat/completions'
      );
      expect(resolveChatCompletionsUrl('http://localhost:11434')).toBe(
        'http://localhost:11434/v1/chat/completions'
      );
      expect(resolveChatCompletionsUrl('http://127.0.0.1:11434/v1/')).toBe(
        'http://127.0.0.1:11434/v1/chat/completions'
      );
      expect(resolveChatCompletionsUrl('https://openrouter.ai/api/v1')).toBe(
        'https://openrouter.ai/api/v1/chat/completions'
      );
      expect(resolveChatCompletionsUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions'
      );
      expect(resolveChatCompletionsUrl('https://ark.cn-beijing.volces.com/api/v3')).toBe(
        'https://ark.cn-beijing.volces.com/api/v3/chat/completions'
      );
      expect(resolveChatCompletionsUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(
        'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
      );
      expect(resolveChatCompletionsUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
      );
      expect(
        resolveChatCompletionsUrl(
          'https://resource.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21#frag'
        )
      ).toBe(
        'https://resource.openai.azure.com/openai/deployments/gpt4/chat/completions?api-version=2024-10-21'
      );
    });

    it('rejects non-http(s) schemes, empty strings, and embedded credentials', () => {
      expect(() => resolveChatCompletionsUrl('')).toThrow(ChatApiError);
      expect(() => resolveChatCompletionsUrl('ftp://example.com/v1')).toThrow(ChatApiError);
      expect(() => resolveChatCompletionsUrl('https://user:pass@api.example.com/v1')).toThrow(
        ChatApiError
      );
    });
  });

  describe('buildOpenAiChatMessages', () => {
    it('builds plain string messages for text turns and multimodal image_url arrays when images exist', () => {
      const messages = buildOpenAiChatMessages([
        { role: 'user', text: 'Compare recursion vs iteration' },
        { role: 'assistant', content: 'Recursion uses the call stack.' },
        {
          role: 'user',
          text: 'Describe this diagram',
          images: [
            { id: 'img-1', dataUrl: 'data:image/png;base64,AAAA' },
            { id: 'bad', dataUrl: 'javascript:alert(1)' }
          ]
        }
      ]);

      expect(messages).toEqual([
        { role: 'user', content: 'Compare recursion vs iteration' },
        { role: 'assistant', content: 'Recursion uses the call stack.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this diagram' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
          ]
        }
      ]);
    });
  });

  describe('streamChatCompletion', () => {
    it('streams chunk-split CRLF SSE deltas, reasoning_content, and omits Authorization when apiKey is empty', async () => {
      const fetchImpl = vi.fn(async (url, init) => {
        expect(url).toBe('http://localhost:11434/v1/chat/completions');
        expect(init.headers.Authorization).toBeUndefined();
        return new Response(
          createSseStream([
            ': keep-alive\r\ndata: {"choices":[{"delta":{"reasoning_content":"Step 1"}}]}\r\n',
            'data: {"choices":[{"delta":{"content":"Hello"}}]}\r',
            '\ndata: {"choices":[{"delta":{"content":" world!"},"finish_reason":"stop"}]}\r\n\r\n',
            'data: [DONE]\r\n'
          ]),
          {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
          }
        );
      });

      const deltas = [];
      const result = await streamChatCompletion({
        endpointUrl: 'http://localhost:11434/v1/chat/completions',
        model: 'qwen2.5:14b',
        apiKey: '',
        messages: [{ role: 'user', content: 'Hi' }],
        onDelta: (delta) => deltas.push(delta),
        fetchImpl
      });

      expect(result).toEqual({
        content: 'Hello world!',
        reasoning: 'Step 1',
        finishReason: 'stop'
      });
      expect(deltas).toHaveLength(3);
    });

    it('sends Bearer token when apiKey is provided and falls back cleanly for non-streaming JSON responses', async () => {
      const fetchImpl = vi.fn(async (_url, init) => {
        expect(init.headers.Authorization).toBe('Bearer sk-live-token');
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { content: 'Non-stream reply', reasoning: 'Quick thought' },
                finish_reason: 'stop'
              }
            ]
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      });

      const deltas = [];
      const result = await streamChatCompletion({
        endpointUrl: 'https://api.example.com/v1/chat/completions',
        model: 'gpt-4o-mini',
        apiKey: 'sk-live-token',
        messages: [{ role: 'user', content: 'Ping' }],
        onDelta: (delta) => deltas.push(delta),
        fetchImpl
      });

      expect(result.content).toBe('Non-stream reply');
      expect(result.reasoning).toBe('Quick thought');
      expect(deltas).toEqual([{ contentDelta: 'Non-stream reply', reasoningDelta: 'Quick thought' }]);
    });

    it('surfaces actionable HTTP 401/403/404/429 errors and mid-stream error payloads', async () => {
      const unauthorizedFetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        })
      );

      await expect(
        streamChatCompletion({
          endpointUrl: 'https://api.example.com/v1/chat/completions',
          model: 'gpt-4o',
          apiKey: 'sk-bad',
          messages: [{ role: 'user', content: 'Hi' }],
          fetchImpl: unauthorizedFetch
        })
      ).rejects.toThrow(/Authentication failed \(HTTP 401\).*Incorrect API key/);

      const streamErrorFetch = vi.fn(async () =>
        new Response(
          createSseStream(['data: {"error":{"message":"Context length exceeded"}}\n\n']),
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
        )
      );

      await expect(
        streamChatCompletion({
          endpointUrl: 'https://api.example.com/v1/chat/completions',
          model: 'gpt-4o',
          messages: [{ role: 'user', content: 'Hi' }],
          fetchImpl: streamErrorFetch
        })
      ).rejects.toThrow(/Context length exceeded/);

      const openRouter429Fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Provider returned error',
              code: 429,
              metadata: {
                raw: 'google/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream.',
                provider_name: 'Google AI Studio',
                limit_source: 'upstream_provider_shared_pool'
              }
            }
          }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(
        streamChatCompletion({
          endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
          model: 'openrouter/free',
          apiKey: 'sk-or-test',
          messages: [{ role: 'user', content: 'Hi' }],
          fetchImpl: openRouter429Fetch
        })
      ).rejects.toThrow(
        /Rate limit or quota exceeded \(HTTP 429\): \[Google AI Studio\] google\/gemma-4-26b-a4b-it:free is temporarily rate-limited upstream\./
      );
    });
  });

  describe('resolveModelsUrl & fetchOpenAiModels', () => {
    it('resolves base URLs, /v1, /chat/completions, and /models endpoints cleanly', () => {
      expect(resolveModelsUrl('http://localhost:11434')).toBe(
        'http://localhost:11434/v1/models'
      );
      expect(resolveModelsUrl('https://openrouter.ai/api/v1')).toBe(
        'https://openrouter.ai/api/v1/models'
      );
      expect(resolveModelsUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(
        'https://openrouter.ai/api/v1/models'
      );
      expect(resolveModelsUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions')).toBe(
        'https://open.bigmodel.cn/api/paas/v4/models'
      );
      expect(resolveModelsUrl('https://api.openai.com/v1/models')).toBe(
        'https://api.openai.com/v1/models'
      );
      expect(() => resolveModelsUrl('ftp://bad.example.com')).toThrow(ChatApiError);
    });

    it('fetches, normalizes, and deduplicates OpenAI/OpenRouter/Ollama model catalogs with optional Bearer auth', async () => {
      const fetchImpl = vi.fn(async (url, init) => {
        expect(url).toBe('https://openrouter.ai/api/v1/models');
        expect(init.method).toBe('GET');
        expect(init.headers.Authorization).toBe('Bearer sk-or-models');
        return new Response(
          JSON.stringify({
            data: [
              { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek: DeepSeek V3.2' },
              { id: 'deepseek/deepseek-v3.2', name: 'Duplicate ignored' },
              { id: 'qwen/qwen2.5-coder:free', name: 'qwen/qwen2.5-coder:free' },
              { id: '   ' },
              'llama3.3:70b'
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const res = await fetchOpenAiModels({
        endpointUrl: 'https://openrouter.ai/api/v1/chat/completions',
        apiKey: 'sk-or-models',
        fetchImpl
      });

      expect(res.modelsUrl).toBe('https://openrouter.ai/api/v1/models');
      expect(res.models).toEqual([
        { id: 'deepseek/deepseek-v3.2', name: 'DeepSeek: DeepSeek V3.2' },
        { id: 'qwen/qwen2.5-coder:free', name: null },
        { id: 'llama3.3:70b', name: null }
      ]);
    });

    it('supports { models: [...] } payloads without Authorization header and surfaces HTTP 404/401 errors', async () => {
      const localFetch = vi.fn(async (url, init) => {
        expect(url).toBe('http://localhost:11434/v1/models');
        expect(init.headers.Authorization).toBeUndefined();
        return new Response(
          JSON.stringify({
            models: [{ model: 'qwen2.5:14b', name: 'Qwen 2.5 14B' }]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const localRes = await fetchOpenAiModels({
        endpointUrl: 'http://localhost:11434',
        apiKey: '',
        fetchImpl: localFetch
      });
      expect(localRes.models).toEqual([{ id: 'qwen2.5:14b', name: 'Qwen 2.5 14B' }]);

      const notFoundFetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Models endpoint unsupported' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        })
      );
      await expect(
        fetchOpenAiModels({
          endpointUrl: 'https://gateway.example.com/v1',
          fetchImpl: notFoundFetch
        })
      ).rejects.toThrow(/Endpoint or model not found \(HTTP 404\).*Models endpoint unsupported/);
    });

    it('keeps caller cancellation attached after response headers until body finishes on both 200 and error responses', async () => {
      // 1. Stalled 200 OK body canceled after headers arrive and response.text() has begun
      let signal200 = null;
      let text200Started = false;
      let resolveBody200 = null;
      const body200Promise = new Promise((resolve) => {
        resolveBody200 = resolve;
      });
      const callerController200 = new AbortController();

      const pending200 = fetchOpenAiModels({
        endpointUrl: 'https://slow-body.example.com/v1',
        signal: callerController200.signal,
        timeoutMs: 5000,
        fetchImpl: vi.fn(async (_url, init) => {
          signal200 = init.signal;
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: () => {
              text200Started = true;
              return body200Promise;
            }
          };
        })
      });

      await vi.waitFor(() => {
        expect(text200Started).toBe(true);
      });
      expect(signal200.aborted).toBe(false);

      callerController200.abort();
      expect(signal200.aborted).toBe(true);

      // Even if the stalled body later resolves with valid JSON, AbortError wins.
      resolveBody200(JSON.stringify({ data: [{ id: 'stale-model' }] }));
      await expect(pending200).rejects.toMatchObject({ name: 'AbortError' });

      // 2. Stalled 500 error body canceled after headers arrive and response.text() has begun
      let signal500 = null;
      let text500Started = false;
      let rejectBody500 = null;
      const body500Promise = new Promise((_resolve, reject) => {
        rejectBody500 = reject;
      });
      const callerController500 = new AbortController();

      const pending500 = fetchOpenAiModels({
        endpointUrl: 'https://slow-error.example.com/v1',
        signal: callerController500.signal,
        timeoutMs: 5000,
        fetchImpl: vi.fn(async (_url, init) => {
          signal500 = init.signal;
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: () => {
              text500Started = true;
              return body500Promise;
            }
          };
        })
      });

      await vi.waitFor(() => {
        expect(text500Started).toBe(true);
      });
      expect(signal500.aborted).toBe(false);

      callerController500.abort();
      expect(signal500.aborted).toBe(true);

      const abortErr = new Error('Body aborted');
      abortErr.name = 'AbortError';
      rejectBody500(abortErr);
      await expect(pending500).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('keeps timeout attached after response headers until body finishes on both 200 and error responses', async () => {
      // 1. Stalled 200 OK body times out after headers arrive
      let signal200 = null;
      const stalled200 = fetchOpenAiModels({
        endpointUrl: 'https://timeout-body.example.com/v1',
        timeoutMs: 25,
        fetchImpl: vi.fn(async (_url, init) => {
          signal200 = init.signal;
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: () => new Promise(() => {})
          };
        })
      });

      await expect(stalled200).rejects.toMatchObject({
        name: 'ChatApiError',
        code: 'timeout_error'
      });
      expect(signal200?.aborted).toBe(true);

      // 2. Stalled 502 error body times out after headers arrive instead of hanging
      let signal502 = null;
      const stalled502 = fetchOpenAiModels({
        endpointUrl: 'https://timeout-err.example.com/v1',
        timeoutMs: 25,
        fetchImpl: vi.fn(async (_url, init) => {
          signal502 = init.signal;
          return {
            ok: false,
            status: 502,
            statusText: 'Bad Gateway',
            text: () => new Promise(() => {})
          };
        })
      });

      await expect(stalled502).rejects.toMatchObject({
        name: 'ChatApiError',
        code: 'timeout_error'
      });
      expect(signal502?.aborted).toBe(true);
    });

    it('enforces connectTimeoutMs and idleTimeoutMs on streamChatCompletion while preserving caller AbortError', async () => {
      // 1. Stalled connection headers -> timeout_error
      let connectSignal = null;
      const stalledConnect = streamChatCompletion({
        endpointUrl: 'https://stalled-connect.example.com/v1',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Hello' }],
        connectTimeoutMs: 25,
        idleTimeoutMs: 200,
        fetchImpl: vi.fn((_url, init) => {
          connectSignal = init.signal;
          return new Promise(() => {});
        })
      });

      await expect(stalledConnect).rejects.toMatchObject({
        name: 'ChatApiError',
        code: 'timeout_error'
      });
      expect(connectSignal?.aborted).toBe(true);

      // 2. Stalled mid-stream reader.read() after first SSE chunk -> timeout_error
      const encoder = new TextEncoder();
      const deltas = [];
      let streamSignal = null;
      let readerCanceled = false;
      let readCalls = 0;

      const stalledStream = streamChatCompletion({
        endpointUrl: 'https://stalled-stream.example.com/v1',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Stream test' }],
        connectTimeoutMs: 200,
        idleTimeoutMs: 30,
        onDelta: ({ contentDelta }) => {
          if (contentDelta) deltas.push(contentDelta);
        },
        fetchImpl: vi.fn(async (_url, init) => {
          streamSignal = init.signal;
          return {
            ok: true,
            status: 200,
            headers: new Headers({ 'content-type': 'text/event-stream' }),
            body: {
              getReader() {
                return {
                  read() {
                    readCalls += 1;
                    if (readCalls === 1) {
                      return Promise.resolve({
                        done: false,
                        value: encoder.encode(
                          'data: {"choices":[{"delta":{"content":"Partial "}}]}\n\n'
                        )
                      });
                    }
                    return new Promise(() => {});
                  },
                  cancel() {
                    readerCanceled = true;
                    return Promise.resolve();
                  }
                };
              }
            }
          };
        })
      });

      await expect(stalledStream).rejects.toMatchObject({
        name: 'ChatApiError',
        code: 'timeout_error'
      });
      expect(deltas).toEqual(['Partial ']);
      expect(streamSignal?.aborted).toBe(true);
      expect(readerCanceled).toBe(true);

      // 3. Caller signal.abort() still rejects with AbortError
      const callerController = new AbortController();
      const abortedByCaller = streamChatCompletion({
        endpointUrl: 'https://caller-abort.example.com/v1',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Abort me' }],
        signal: callerController.signal,
        connectTimeoutMs: 5000,
        idleTimeoutMs: 5000,
        fetchImpl: vi.fn(() => new Promise(() => {}))
      });

      callerController.abort();
      await expect(abortedByCaller).rejects.toMatchObject({ name: 'AbortError' });
    });
  });
});
