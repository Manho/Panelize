import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAllCustomApiKeys,
  deleteCustomApiKey,
  getCustomApiKey,
  getCustomApiKeyRecord,
  MAX_CUSTOM_API_KEY_LENGTH,
  onCustomApiSecretChanged,
  resetCustomApiSecretsDbForTests,
  saveCustomApiKey
} from '../modules/custom-api-secrets.js';
import { createMockIndexedDB } from './helpers/mock-indexeddb.js';

describe('custom-api-secrets local IndexedDB store', () => {
  let savedIndexedDB;

  beforeEach(() => {
    savedIndexedDB = globalThis.indexedDB;
    resetCustomApiSecretsDbForTests();
    globalThis.indexedDB = createMockIndexedDB();
  });

  afterEach(() => {
    resetCustomApiSecretsDbForTests();
    globalThis.indexedDB = savedIndexedDB;
    vi.restoreAllMocks();
  });

  it('saves, reads, updates, deletes, and clears keys strictly in local IndexedDB without touching chrome.storage', async () => {
    await saveCustomApiKey('custom-0123456789', '  sk-secret-alpha  ');
    await saveCustomApiKey('custom-abcdef0123', 'sk-secret-beta');

    expect(await getCustomApiKey('custom-0123456789')).toBe('sk-secret-alpha');
    expect(await getCustomApiKey('custom-abcdef0123')).toBe('sk-secret-beta');
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();

    // Saving whitespace/empty string deletes any existing key
    await saveCustomApiKey('custom-0123456789', '   ');
    expect(await getCustomApiKey('custom-0123456789')).toBeNull();

    await deleteCustomApiKey('custom-abcdef0123');
    expect(await getCustomApiKey('custom-abcdef0123')).toBeNull();

    await saveCustomApiKey('custom-1111111111', 'sk-one');
    await saveCustomApiKey('custom-2222222222', 'sk-two');
    await clearAllCustomApiKeys();
    expect(await getCustomApiKey('custom-1111111111')).toBeNull();
    expect(await getCustomApiKey('custom-2222222222')).toBeNull();
  });

  it('validates providerId format and maximum API key length', async () => {
    await expect(saveCustomApiKey('chatgpt', 'sk-123')).rejects.toThrow(/Invalid custom provider ID/);
    await expect(saveCustomApiKey('custom-0123456789', 12345)).rejects.toThrow(/must be a string/);
    await expect(
      saveCustomApiKey('custom-0123456789', 'x'.repeat(MAX_CUSTOM_API_KEY_LENGTH + 1))
    ).rejects.toThrow(/maximum length/);

    expect(await getCustomApiKey('not-a-custom-id')).toBeNull();
    expect(await deleteCustomApiKey('not-a-custom-id')).toBe(false);
  });

  it('binds saved credentials to endpointUrl with monotonic revisions and emits invalidation events', async () => {
    const events = [];
    const unsubscribe = onCustomApiSecretChanged((payload) => events.push(payload));

    const first = await saveCustomApiKey('custom-0123456789', 'sk-bound-a', {
      endpointUrl: 'https://a.example/v1/chat/completions'
    });
    expect(first.hasApiKey).toBe(true);
    expect(await getCustomApiKeyRecord('custom-0123456789')).toMatchObject({
      apiKey: 'sk-bound-a',
      endpointUrl: 'https://a.example/v1/chat/completions',
      revision: first.revision
    });

    const second = await saveCustomApiKey('custom-0123456789', 'sk-bound-b', {
      endpointUrl: 'https://b.example/v1/chat/completions'
    });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(await getCustomApiKeyRecord('custom-0123456789')).toMatchObject({
      apiKey: 'sk-bound-b',
      endpointUrl: 'https://b.example/v1/chat/completions',
      revision: second.revision
    });

    await deleteCustomApiKey('custom-0123456789');
    await clearAllCustomApiKeys();
    unsubscribe();

    expect(events.map((e) => e.providerId)).toEqual([
      'custom-0123456789',
      'custom-0123456789',
      'custom-0123456789',
      '*'
    ]);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});
