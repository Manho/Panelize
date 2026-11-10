import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../modules/providers.js';
import { OPTIONAL_PROVIDER_CONFIGS } from '../modules/optional-provider-access.js';
import {
  findMessageSourcePanel,
  getProviderFrameOrigins,
  isProviderFrameOrigin
} from '../modules/provider-open-url.js';

const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8'));

function matchOrigin(pattern) {
  const match = /^(https?):\/\/([^/]+)\//.exec(pattern);
  if (!match || match[2].includes('*')) {
    throw new Error(`Unexpected content script match pattern: ${pattern}`);
  }
  return `${match[1]}://${match[2]}`;
}

/**
 * Every place the panel content script is injected, paired with the
 * provider it serves. Multi-Panel only reaches a frame whose origin is in
 * getProviderFrameOrigins(providerId), so each of these origins must be
 * listed there or that provider's panels would silently stop receiving
 * Send All, New Chat and snapshot requests.
 */
function panelContentScriptOrigins() {
  const entries = [];
  manifest.content_scripts
    .filter((script) => script.js.includes('content-scripts/text-injection-all-providers.js'))
    .forEach((script) => {
      const enterBehavior = script.js.find((file) => /enter-behavior-(?!utils)[\w-]+\.js$/.test(file));
      const providerId = /enter-behavior-([\w-]+)\.js$/.exec(enterBehavior)[1];
      script.matches.forEach((pattern) => entries.push([providerId, matchOrigin(pattern), 'manifest']));
    });
  Object.entries(OPTIONAL_PROVIDER_CONFIGS).forEach(([providerId, config]) => {
    expect(config.contentScript.js).toContain('content-scripts/text-injection-all-providers.js');
    config.contentScript.matches.forEach((pattern) => entries.push([providerId, matchOrigin(pattern), 'optional']));
  });
  return entries;
}

describe('provider frame origins', () => {
  it('lists every origin the panel content script runs on, per provider', () => {
    const entries = panelContentScriptOrigins();
    expect(entries.length).toBeGreaterThanOrEqual(PROVIDERS.length);
    entries.forEach(([providerId, origin]) => {
      expect(getProviderFrameOrigins(providerId), `${providerId} ${origin}`).toContain(origin);
    });
  });

  it('covers every built-in provider and the page each one opens on', () => {
    const scriptProviderIds = new Set(panelContentScriptOrigins().map(([providerId]) => providerId));
    PROVIDERS.forEach((provider) => {
      expect(scriptProviderIds, provider.id).toContain(provider.id);
      const origins = getProviderFrameOrigins(provider.id);
      expect(origins, provider.id).toContain(new URL(provider.url).origin);
      expect(origins, provider.id).toContain(new URL(provider.topLevelUrl).origin);
    });
  });

  it('returns exact https origins and never a wildcard', () => {
    PROVIDERS.forEach((provider) => {
      getProviderFrameOrigins(provider.id).forEach((origin) => {
        expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
      });
    });
  });

  it('returns no origins for an unknown provider', () => {
    expect(getProviderFrameOrigins('unknown')).toEqual([]);
    expect(getProviderFrameOrigins('__proto__')).toEqual([]);
    expect(getProviderFrameOrigins(undefined)).toEqual([]);
  });

  it('returns a fresh array each call', () => {
    const origins = getProviderFrameOrigins('chatgpt');
    origins.push('*');
    expect(getProviderFrameOrigins('chatgpt')).toEqual(['https://chatgpt.com', 'https://chat.openai.com']);
  });
});

describe('isProviderFrameOrigin', () => {
  it('accepts every origin the provider frame may be on', () => {
    PROVIDERS.forEach((provider) => {
      getProviderFrameOrigins(provider.id).forEach((origin) => {
        expect(isProviderFrameOrigin(provider.id, origin), `${provider.id} ${origin}`).toBe(true);
      });
    });
  });

  it.each([
    ['another site', 'chatgpt', 'https://evil.example'],
    ['a look-alike host', 'chatgpt', 'https://chatgpt.com.evil.example'],
    ['plain http', 'chatgpt', 'http://chatgpt.com'],
    ['a port', 'chatgpt', 'https://chatgpt.com:8443'],
    ['a trailing slash', 'chatgpt', 'https://chatgpt.com/'],
    ['another provider', 'claude', 'https://chatgpt.com'],
    ['the extension origin', 'chatgpt', 'chrome-extension://panelize-test-extension-id'],
    ['an opaque origin', 'chatgpt', 'null'],
    ['an empty origin', 'chatgpt', ''],
    ['a missing origin', 'chatgpt', undefined],
    ['an unknown provider', 'unknown', 'https://chatgpt.com'],
  ])('rejects %s', (_label, providerId, origin) => {
    expect(isProviderFrameOrigin(providerId, origin)).toBe(false);
  });
});

describe('findMessageSourcePanel', () => {
  function createPanels() {
    const chatgpt = { id: 'panel-1', providerId: 'chatgpt', iframe: { contentWindow: {} } };
    const claude = { id: 'panel-2', providerId: 'claude', iframe: { contentWindow: {} } };
    return { chatgpt, claude, panels: [chatgpt, claude] };
  }

  it.each(['https://chatgpt.com', 'https://chat.openai.com'])(
    'finds the ChatGPT panel messaging from %s, either origin its frame may be on',
    (origin) => {
      const { chatgpt, panels } = createPanels();
      expect(findMessageSourcePanel(panels, { source: chatgpt.iframe.contentWindow, origin })).toBe(chatgpt);
    }
  );

  it('finds each panel by its own frame and origin', () => {
    const { claude, panels } = createPanels();
    expect(findMessageSourcePanel(panels, {
      source: claude.iframe.contentWindow,
      origin: 'https://claude.ai',
    })).toBe(claude);
  });

  it.each([
    ['another site', 'https://evil.example'],
    ["another panel's provider", 'https://claude.ai'],
    ['plain http', 'http://chatgpt.com'],
    ['the extension origin', 'chrome-extension://panelize-test-extension-id'],
    ['an opaque origin', 'null'],
    ['no origin', undefined],
  ])('ignores a panel frame that messages from %s', (_label, origin) => {
    const { chatgpt, panels } = createPanels();
    expect(findMessageSourcePanel(panels, { source: chatgpt.iframe.contentWindow, origin })).toBeNull();
  });

  it('ignores a message from a window that is not a panel frame', () => {
    const { panels } = createPanels();
    expect(findMessageSourcePanel(panels, { source: {}, origin: 'https://chatgpt.com' })).toBeNull();
    expect(findMessageSourcePanel(panels, { source: null, origin: 'https://chatgpt.com' })).toBeNull();
  });

  it('ignores a panel whose frame has no window', () => {
    const panel = { id: 'panel-1', providerId: 'chatgpt', iframe: null };
    expect(findMessageSourcePanel([panel], { source: undefined, origin: 'https://chatgpt.com' })).toBeNull();
  });
});
