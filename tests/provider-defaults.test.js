import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_IDS,
  LEGACY_DEFAULT_PROVIDER_IDS,
  migrateEnabledProvidersOnUpdate,
} from '../modules/provider-defaults.js';

describe('provider defaults', () => {
  it('appends Z.ai and Qwen to the current default provider list', () => {
    expect(DEFAULT_PROVIDER_IDS).toEqual([
      'chatgpt',
      'claude',
      'gemini',
      'grok',
      'deepseek',
      'kimi',
      'google',
      'doubao',
      'zai',
      'qwen',
    ]);
    expect(LEGACY_DEFAULT_PROVIDER_IDS).not.toContain('doubao');
    expect(LEGACY_DEFAULT_PROVIDER_IDS).not.toContain('zai');
    expect(LEGACY_DEFAULT_PROVIDER_IDS).not.toContain('qwen');
  });

  it('migrates untouched legacy defaults to include Doubao, Z.ai, and Qwen', () => {
    expect(
      migrateEnabledProvidersOnUpdate(LEGACY_DEFAULT_PROVIDER_IDS, LEGACY_DEFAULT_PROVIDER_IDS)
    ).toEqual({
      enabledProviders: DEFAULT_PROVIDER_IDS,
      providerOrder: DEFAULT_PROVIDER_IDS,
    });
  });

  it('migrates untouched Doubao-era defaults to include Z.ai and Qwen', () => {
    const doubaoEraDefaultIds = [
      'chatgpt',
      'claude',
      'gemini',
      'grok',
      'deepseek',
      'kimi',
      'google',
      'doubao',
    ];

    expect(
      migrateEnabledProvidersOnUpdate(doubaoEraDefaultIds, doubaoEraDefaultIds)
    ).toEqual({
      enabledProviders: DEFAULT_PROVIDER_IDS,
      providerOrder: DEFAULT_PROVIDER_IDS,
    });
  });

  it('migrates missing provider settings as untouched defaults', () => {
    expect(migrateEnabledProvidersOnUpdate(null, null)).toEqual({
      enabledProviders: DEFAULT_PROVIDER_IDS,
      providerOrder: DEFAULT_PROVIDER_IDS,
    });
  });

  it('preserves customized provider order while appending Z.ai and Qwen for legacy-enabled users', () => {
    expect(
      migrateEnabledProvidersOnUpdate(LEGACY_DEFAULT_PROVIDER_IDS, ['claude', 'chatgpt', 'gemini'])
    ).toEqual({
      enabledProviders: ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao', 'zai', 'qwen'],
      providerOrder: ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao', 'zai', 'qwen'],
    });
  });

  it('preserves customized Doubao-era provider order while appending Z.ai and Qwen', () => {
    expect(
      migrateEnabledProvidersOnUpdate(
        ['chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao'],
        ['doubao', 'claude', 'chatgpt', 'gemini']
      )
    ).toEqual({
      enabledProviders: ['doubao', 'claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'zai', 'qwen'],
      providerOrder: ['doubao', 'claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'zai', 'qwen'],
    });
  });

  it('migrates reordered legacy defaults while preserving the user order', () => {
    expect(
      migrateEnabledProvidersOnUpdate(
        ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao'],
        null
      )
    ).toEqual({
      enabledProviders: ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao', 'zai', 'qwen'],
      providerOrder: ['claude', 'chatgpt', 'gemini', 'grok', 'deepseek', 'kimi', 'google', 'doubao', 'zai', 'qwen'],
    });
  });

  it('does not override customized enabled providers', () => {
    expect(
      migrateEnabledProvidersOnUpdate(['chatgpt', 'claude'], LEGACY_DEFAULT_PROVIDER_IDS)
    ).toBeNull();
  });

  it('does not migrate duplicate legacy provider lists that are missing a default provider', () => {
    expect(
      migrateEnabledProvidersOnUpdate(
        ['chatgpt', 'chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'kimi'],
        null
      )
    ).toBeNull();
  });
});
