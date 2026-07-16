import { describe, expect, it } from 'vitest';

import { appendProviderToOrder, normalizeProviderOrder } from '../modules/provider-order.js';

const ALL_PROVIDER_IDS = ['chatgpt', 'claude', 'qwen-cn', 'qwen-global', 'chatglm', 'zai-global'];

describe('provider order', () => {
  it('appends newly available providers without changing the saved order', () => {
    expect(normalizeProviderOrder(
      ['claude', 'chatgpt', 'doubao'],
      ['chatgpt', 'claude', 'doubao', 'qwen-cn', 'qwen-global']
    )).toEqual(['claude', 'chatgpt', 'doubao', 'qwen-cn', 'qwen-global']);
  });

  it('removes unknown and duplicate provider ids', () => {
    expect(normalizeProviderOrder(
      ['claude', 'removed', 'claude'],
      ['chatgpt', 'claude', 'qwen-cn']
    )).toEqual(['claude', 'chatgpt', 'qwen-cn']);
  });

  it('adds only the provider being enabled to a persisted legacy order', () => {
    expect(appendProviderToOrder(
      ['claude', 'chatgpt'],
      ['chatgpt', 'claude'],
      'qwen-cn',
      ALL_PROVIDER_IDS
    )).toEqual(['claude', 'chatgpt', 'qwen-cn']);
  });

  it('uses enabled providers as the order fallback and retains an existing entry', () => {
    expect(appendProviderToOrder(
      null,
      ['chatgpt', 'claude', 'qwen-global'],
      'qwen-global',
      ALL_PROVIDER_IDS
    )).toEqual(['chatgpt', 'claude', 'qwen-global']);
  });

  it('appends ChatGLM without changing an existing provider order', () => {
    expect(appendProviderToOrder(
      ['claude', 'chatgpt'],
      ['chatgpt', 'claude'],
      'chatglm',
      ALL_PROVIDER_IDS
    )).toEqual(['claude', 'chatgpt', 'chatglm']);
  });

  it('appends Z.ai Global without changing an existing provider order', () => {
    expect(appendProviderToOrder(
      ['claude', 'chatgpt'],
      ['chatgpt', 'claude'],
      'zai-global',
      ALL_PROVIDER_IDS
    )).toEqual(['claude', 'chatgpt', 'zai-global']);
  });
});
