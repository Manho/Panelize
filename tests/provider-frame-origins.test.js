import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PROVIDERS } from '../modules/providers.js';
import { OPTIONAL_PROVIDER_CONFIGS } from '../modules/optional-provider-access.js';
import { getProviderFrameOrigins } from '../modules/provider-open-url.js';

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
