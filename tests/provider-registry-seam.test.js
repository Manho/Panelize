import { afterEach, describe, expect, it } from 'vitest';
import {
  registerExtraProviderDescriptors,
  resetExtraProviderDescriptors,
} from '../modules/provider-registry.js';
import {
  PROVIDERS,
  getProviderById,
  getProviderByIdWithSettings,
} from '../modules/providers.js';
import {
  findMessageSourcePanel,
  getProviderFrameOrigins,
  isProviderAllowedUrl,
  isProviderFrameOrigin,
} from '../modules/provider-open-url.js';

function createTestLocalDescriptor(overrides = {}) {
  return {
    id: 'test-local',
    name: 'Test Local',
    url: 'http://localhost:43110/',
    topLevelUrl: 'http://localhost:43110/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['http://localhost:43110'],
    allowedHosts: ['localhost'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    ...overrides,
  };
}

describe('provider registry live seam integration', () => {
  afterEach(() => {
    resetExtraProviderDescriptors();
  });

  it('derives live catalog lookup and frame origin trust for an http://localhost:<port> extra provider', async () => {
    const builtInSnapshotBefore = structuredClone(PROVIDERS);

    registerExtraProviderDescriptors([createTestLocalDescriptor()]);

    // Catalog lookups resolve live through the registry.
    const extraProvider = getProviderById('test-local');
    expect(extraProvider).toEqual({
      id: 'test-local',
      name: 'Test Local',
      url: 'http://localhost:43110/',
      topLevelUrl: 'http://localhost:43110/',
      icon: '/icons/providers/chatgpt.png',
      iconDark: '/icons/providers/dark/chatgpt.png',
      enabled: true,
    });
    await expect(getProviderByIdWithSettings('test-local')).resolves.toEqual(extraProvider);

    // Frame origins resolve live and return a defensive copy.
    const frameOrigins = getProviderFrameOrigins('test-local');
    expect(frameOrigins).toEqual(['http://localhost:43110']);
    frameOrigins.push('http://localhost:43111');
    expect(getProviderFrameOrigins('test-local')).toEqual(['http://localhost:43110']);

    // Full-origin comparison accepts exact port/scheme/host and rejects mismatches.
    expect(isProviderFrameOrigin('test-local', 'http://localhost:43110')).toBe(true);
    expect(isProviderFrameOrigin('test-local', 'http://localhost:43111')).toBe(false);
    expect(isProviderFrameOrigin('test-local', 'https://localhost:43110')).toBe(false);
    expect(isProviderFrameOrigin('test-local', 'http://127.0.0.1:43110')).toBe(false);

    // Message source trust accepts matching window + origin and rejects other ports or windows.
    const localWindow = {};
    const chatgptWindow = {};
    const localPanel = {
      id: 'panel-local',
      providerId: 'test-local',
      iframe: { contentWindow: localWindow },
    };
    const chatgptPanel = {
      id: 'panel-chatgpt',
      providerId: 'chatgpt',
      iframe: { contentWindow: chatgptWindow },
    };
    const panelList = [localPanel, chatgptPanel];

    expect(
      findMessageSourcePanel(panelList, {
        source: localWindow,
        origin: 'http://localhost:43110',
      })
    ).toBe(localPanel);
    expect(
      findMessageSourcePanel(panelList, {
        source: localWindow,
        origin: 'http://localhost:43111',
      })
    ).toBeNull();
    expect(
      findMessageSourcePanel(panelList, {
        source: localWindow,
        origin: 'https://localhost:43110',
      })
    ).toBeNull();
    expect(
      findMessageSourcePanel(panelList, {
        source: {},
        origin: 'http://localhost:43110',
      })
    ).toBeNull();

    // Built-in results remain unchanged while the extra entry is registered.
    expect(PROVIDERS).toEqual(builtInSnapshotBefore);
    expect(getProviderById('chatgpt')).toEqual(builtInSnapshotBefore[0]);
    expect(getProviderFrameOrigins('chatgpt')).toEqual([
      'https://chatgpt.com',
      'https://chat.openai.com',
    ]);
    expect(isProviderFrameOrigin('chatgpt', 'https://chatgpt.com')).toBe(true);
    expect(isProviderFrameOrigin('chatgpt', 'http://localhost:43110')).toBe(false);
    expect(isProviderAllowedUrl('chatgpt', 'https://chatgpt.com/c/abc')).toBe(true);

    // Reset removes the extra provider completely.
    resetExtraProviderDescriptors();

    expect(getProviderById('test-local')).toBeUndefined();
    await expect(getProviderByIdWithSettings('test-local')).resolves.toBeNull();
    expect(getProviderFrameOrigins('test-local')).toEqual([]);
    expect(isProviderFrameOrigin('test-local', 'http://localhost:43110')).toBe(false);
    expect(
      findMessageSourcePanel(panelList, {
        source: localWindow,
        origin: 'http://localhost:43110',
      })
    ).toBeNull();
  });

  it('returns false without throwing from isProviderAllowedUrl for prototype-key provider ids', () => {
    for (const protoKey of ['__proto__', 'constructor', 'toString']) {
      expect(() => isProviderAllowedUrl(protoKey, 'https://chatgpt.com/')).not.toThrow();
      expect(isProviderAllowedUrl(protoKey, 'https://chatgpt.com/')).toBe(false);
    }
  });
});
