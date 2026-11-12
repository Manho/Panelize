import { describe, expect, it, vi } from 'vitest';
import {
  buildOpenAiChatMessages,
  ChatApiError,
  resolveChatCompletionsUrl,
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
});
