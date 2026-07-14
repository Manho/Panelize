import { describe, expect, it } from 'vitest';

import { getProviderById } from '../modules/providers.js';
import {
  getProviderFallbackUrl,
  getProviderOpenUrl,
  isProviderAllowedUrl,
  isProviderCurrentUrl,
} from '../modules/provider-open-url.js';

describe('provider open URL helpers', () => {
  it('accepts known current conversation URLs', () => {
    expect(isProviderCurrentUrl('chatgpt', 'https://chatgpt.com/c/abc123')).toBe(true);
    expect(isProviderCurrentUrl('claude', 'https://claude.ai/chat/abc123')).toBe(true);
    expect(isProviderCurrentUrl('gemini', 'https://gemini.google.com/app/abc123')).toBe(true);
    expect(isProviderCurrentUrl('grok', 'https://grok.com/c/abc123')).toBe(true);
    expect(isProviderCurrentUrl('deepseek', 'https://chat.deepseek.com/a/chat/s/abc123')).toBe(true);
    expect(isProviderCurrentUrl('kimi', 'https://www.kimi.com/chat/abc123')).toBe(true);
    expect(isProviderCurrentUrl('doubao', 'https://www.doubao.com/chat/abc123')).toBe(true);
    expect(isProviderCurrentUrl('qwen-global', 'https://chat.qwen.ai/c/abc123')).toBe(true);
  });

  it('accepts current Google pages for both AI Mode and Search', () => {
    expect(isProviderCurrentUrl('google', 'https://www.google.com/search?udm=50')).toBe(true);
    expect(isProviderCurrentUrl('google', 'https://www.google.com/search?q=panelize')).toBe(true);
    expect(isProviderCurrentUrl('google', 'https://www.google.com/')).toBe(true);
  });

  it('rejects invalid origins, generic pages, and temporary private pages', () => {
    expect(isProviderAllowedUrl('chatgpt', 'https://evil.example/c/abc123')).toBe(false);
    expect(isProviderCurrentUrl('chatgpt', 'https://chatgpt.com/')).toBe(false);
    expect(isProviderCurrentUrl('chatgpt', 'https://chatgpt.com/?temporary-chat=true')).toBe(false);
    expect(isProviderCurrentUrl('claude', 'https://claude.ai/new?incognito')).toBe(false);
    expect(isProviderCurrentUrl('gemini', 'https://gemini.google.com/app')).toBe(false);
    expect(isProviderCurrentUrl('grok', 'https://grok.com/c#private')).toBe(false);
    expect(isProviderCurrentUrl('kimi', 'https://www.kimi.com/')).toBe(false);
    expect(isProviderCurrentUrl('doubao', 'https://www.doubao.com/chat/')).toBe(false);
    expect(isProviderCurrentUrl('qwen-cn', 'https://www.qianwen.com/chat/abc123')).toBe(false);
    expect(isProviderCurrentUrl('qwen-global', 'https://chat.qwen.ai/c/new-chat')).toBe(false);
    expect(isProviderCurrentUrl('qwen-global', 'https://chat.qwen.ai/c/new-chat/')).toBe(false);
    expect(isProviderCurrentUrl('qwen-global', 'https://chat.qwen.ai/c/abc123/unknown')).toBe(false);
  });

  it('opens the reported current URL when it is valid', () => {
    const provider = getProviderById('claude');

    expect(getProviderOpenUrl(provider, 'https://claude.ai/chat/abc123')).toBe('https://claude.ai/chat/abc123');
  });

  it('falls back when the reported URL is missing or not a current conversation', () => {
    expect(getProviderOpenUrl(getProviderById('chatgpt'), 'https://chatgpt.com/')).toBe('https://chatgpt.com/');
    expect(getProviderOpenUrl(getProviderById('claude'), 'https://claude.ai/new?incognito')).toBe('https://claude.ai/new');
    expect(getProviderOpenUrl(getProviderById('google'), null, 'search')).toBe('https://www.google.com/');
    expect(getProviderFallbackUrl(getProviderById('google'), 'ai')).toBe('https://www.google.com/search?udm=50');
    expect(getProviderOpenUrl(getProviderById('qwen-cn'), 'https://www.qianwen.com/chat/abc123')).toBe('https://www.qianwen.com/');
  });
});
