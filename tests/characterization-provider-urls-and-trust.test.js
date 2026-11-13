import { describe, expect, it } from 'vitest';
import { PROVIDERS, getProviderById } from '../modules/providers.js';
import {
  findMessageSourcePanel,
  getProviderFallbackUrl,
  getProviderFrameOrigins,
  getProviderOpenUrl,
  isProviderAllowedUrl,
  isProviderCurrentUrl,
  isProviderFrameOrigin,
} from '../modules/provider-open-url.js';

const EXPECTED_FRAME_ORIGINS = {
  chatgpt: ['https://chatgpt.com', 'https://chat.openai.com'],
  claude: ['https://claude.ai'],
  gemini: ['https://gemini.google.com'],
  grok: ['https://grok.com'],
  deepseek: ['https://chat.deepseek.com'],
  kimi: ['https://www.kimi.com', 'https://kimi.com'],
  google: ['https://www.google.com', 'https://google.com'],
  doubao: ['https://www.doubao.com', 'https://doubao.com'],
  'qwen-cn': ['https://www.qianwen.com'],
  'qwen-global': ['https://chat.qwen.ai'],
  chatglm: ['https://chatglm.cn'],
  'zai-global': ['https://chat.z.ai'],
  yuanbao: ['https://yuanbao.tencent.com'],
  aistudio: ['https://aistudio.google.com'],
};

const EXPECTED_FALLBACK_URLS = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/new',
  gemini: 'https://gemini.google.com/app',
  grok: 'https://grok.com/',
  deepseek: 'https://chat.deepseek.com/',
  kimi: 'https://www.kimi.com/',
  google: 'https://www.google.com/search?udm=50',
  doubao: 'https://www.doubao.com/chat/',
  'qwen-cn': 'https://www.qianwen.com/',
  'qwen-global': 'https://chat.qwen.ai/',
  chatglm: 'https://chatglm.cn/',
  'zai-global': 'https://chat.z.ai/',
  yuanbao: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
  aistudio: 'https://aistudio.google.com/prompts/new_chat',
};

describe('characterization: provider frame origins, URL validation, and message source trust', () => {
  describe('getProviderFrameOrigins', () => {
    it('returns the exact frame origin list for all 14 providers', () => {
      const actual = Object.fromEntries(
        PROVIDERS.map((provider) => [provider.id, getProviderFrameOrigins(provider.id)])
      );
      expect(actual).toEqual(EXPECTED_FRAME_ORIGINS);
    });

    it('returns an empty array for unknown, empty, colon-prefixed, or prototype keys', () => {
      for (const badId of [
        'unknown',
        '',
        'custom:chatgpt',
        '__proto__',
        'constructor',
        'toString',
        'valueOf',
        null,
        undefined,
      ]) {
        expect(getProviderFrameOrigins(badId)).toEqual([]);
      }
    });

    it('returns a fresh copy on each call', () => {
      const first = getProviderFrameOrigins('kimi');
      first.push('https://evil.example');
      expect(getProviderFrameOrigins('kimi')).toEqual([
        'https://www.kimi.com',
        'https://kimi.com',
      ]);
    });
  });

  describe('isProviderFrameOrigin', () => {
    it('accepts every listed frame origin for all 14 providers and rejects cross-provider origins', () => {
      for (const [providerId, origins] of Object.entries(EXPECTED_FRAME_ORIGINS)) {
        for (const origin of origins) {
          expect(isProviderFrameOrigin(providerId, origin)).toBe(true);
        }
        for (const [otherId, otherOrigins] of Object.entries(EXPECTED_FRAME_ORIGINS)) {
          if (otherId === providerId) continue;
          for (const otherOrigin of otherOrigins) {
            expect(isProviderFrameOrigin(providerId, otherOrigin)).toBe(false);
          }
        }
      }
    });

    it.each([
      ['http scheme on built-in provider', 'chatgpt', 'http://chatgpt.com'],
      ['http scheme on optional provider', 'aistudio', 'http://aistudio.google.com'],
      ['non-default port', 'chatgpt', 'https://chatgpt.com:8443'],
      ['explicit 443 port string', 'claude', 'https://claude.ai:443'],
      ['subdomain of chatgpt', 'chatgpt', 'https://sub.chatgpt.com'],
      ['subdomain of claude', 'claude', 'https://app.claude.ai'],
      ['bare domain where www is required', 'qwen-cn', 'https://qianwen.com'],
      ['www subdomain where bare is required', 'grok', 'https://www.grok.com'],
      ['qwen-global secondary auth permission origin', 'qwen-global', 'https://auth.qwen.ai'],
      ['aistudio secondary RPC permission origin', 'aistudio', 'https://alkalimakersuite-pa.clients6.google.com'],
      ['trailing slash', 'gemini', 'https://gemini.google.com/'],
      ['origin with path', 'deepseek', 'https://chat.deepseek.com/chat'],
      ['chrome-extension origin', 'chatgpt', 'chrome-extension://panelize-test-extension-id'],
      ['opaque null origin', 'chatgpt', 'null'],
      ['wildcard', 'chatgpt', '*'],
      ['empty string', 'chatgpt', ''],
      ['non-string null', 'chatgpt', null],
      ['non-string undefined', 'chatgpt', undefined],
      ['non-string object', 'chatgpt', { toString: () => 'https://chatgpt.com' }],
      ['unknown provider id', 'unknown', 'https://chatgpt.com'],
      ['prototype key provider id', '__proto__', 'https://chatgpt.com'],
    ])('rejects %s (%s, %s)', (_label, providerId, origin) => {
      expect(isProviderFrameOrigin(providerId, origin)).toBe(false);
    });
  });

  describe('isProviderAllowedUrl', () => {
    it('accepts https URLs on every allowed host across all 14 providers', () => {
      for (const [providerId, origins] of Object.entries(EXPECTED_FRAME_ORIGINS)) {
        for (const origin of origins) {
          expect(isProviderAllowedUrl(providerId, `${origin}/`)).toBe(true);
          expect(isProviderAllowedUrl(providerId, `${origin}/some/deep/path?foo=1#bar`)).toBe(true);
        }
      }
    });

    it('pins current port behavior: isProviderAllowedUrl checks protocol + hostname (accepting custom ports) while isProviderFrameOrigin rejects custom ports', () => {
      expect(isProviderAllowedUrl('chatgpt', 'https://chatgpt.com:8443/c/123')).toBe(true);
      expect(isProviderFrameOrigin('chatgpt', 'https://chatgpt.com:8443')).toBe(false);
    });

    it.each([
      ['http scheme', 'chatgpt', 'http://chatgpt.com/c/123'],
      ['subdomain', 'chatgpt', 'https://sub.chatgpt.com/c/123'],
      ['lookalike suffix', 'claude', 'https://claude.ai.evil.example/chat/1'],
      ['qwen-global auth host', 'qwen-global', 'https://auth.qwen.ai/login'],
      ['aistudio backend RPC host', 'aistudio', 'https://alkalimakersuite-pa.clients6.google.com/'],
      ['cross-provider URL', 'gemini', 'https://chatgpt.com/c/123'],
      ['extension URL', 'chatgpt', 'chrome-extension://panelize-test-extension-id/multi-panel/multi-panel.html'],
      ['about:blank', 'chatgpt', 'about:blank'],
      ['javascript URL', 'chatgpt', 'javascript:alert(1)'],
      ['relative path', 'chatgpt', '/c/123'],
      ['empty string', 'chatgpt', ''],
      ['null', 'chatgpt', null],
      ['undefined', 'chatgpt', undefined],
      ['unknown provider id', 'unknown', 'https://chatgpt.com/'],
      ['colon-prefixed unknown provider id', 'custom:chatgpt', 'https://chatgpt.com/'],
    ])('rejects %s (%s, %s)', (_label, providerId, rawUrl) => {
      expect(isProviderAllowedUrl(providerId, rawUrl)).toBe(false);
    });
  });

  describe('getProviderFallbackUrl', () => {
    it('returns exact fallback URLs for all 14 providers with default mode', () => {
      const actual = Object.fromEntries(
        PROVIDERS.map((provider) => [provider.id, getProviderFallbackUrl(provider)])
      );
      expect(actual).toEqual(EXPECTED_FALLBACK_URLS);
    });

    it('resolves Google fallback URL according to normalized providerMode', () => {
      const google = getProviderById('google');
      expect(getProviderFallbackUrl(google, 'ai')).toBe('https://www.google.com/search?udm=50');
      expect(getProviderFallbackUrl(google, 'search')).toBe('https://www.google.com/');
      expect(getProviderFallbackUrl(google, null)).toBe('https://www.google.com/search?udm=50');
      expect(getProviderFallbackUrl(google, 'unexpected')).toBe('https://www.google.com/search?udm=50');
    });

    it('falls back to provider.url when topLevelUrl is absent and returns empty string for nullish provider', () => {
      expect(getProviderFallbackUrl({ id: 'custom', url: 'https://example.com/chat' })).toBe(
        'https://example.com/chat'
      );
      expect(getProviderFallbackUrl({ id: 'empty' })).toBe('');
      expect(getProviderFallbackUrl(null)).toBe('');
      expect(getProviderFallbackUrl(undefined)).toBe('');
    });
  });

  describe('isProviderCurrentUrl and getProviderOpenUrl across all 14 providers', () => {
    const positiveCases = [
      ['chatgpt primary host', 'chatgpt', 'https://chatgpt.com/c/6789abcd'],
      ['chatgpt legacy host', 'chatgpt', 'https://chat.openai.com/c/6789abcd'],
      ['claude', 'claude', 'https://claude.ai/chat/uuid-1234'],
      ['gemini', 'gemini', 'https://gemini.google.com/app/abc123def'],
      ['grok /c/ path', 'grok', 'https://grok.com/c/conv-123'],
      ['grok /chat/ path', 'grok', 'https://grok.com/chat/conv-456'],
      ['deepseek /a/chat/s/', 'deepseek', 'https://chat.deepseek.com/a/chat/s/session-1'],
      ['deepseek /chat/', 'deepseek', 'https://chat.deepseek.com/chat/session-2'],
      ['kimi www host', 'kimi', 'https://www.kimi.com/chat/conv-1'],
      ['kimi bare host', 'kimi', 'https://kimi.com/chat/conv-2'],
      ['google root', 'google', 'https://www.google.com/'],
      ['google webhp', 'google', 'https://google.com/webhp?hl=en'],
      ['google search query', 'google', 'https://www.google.com/search?q=panelize&udm=50'],
      ['doubao www host', 'doubao', 'https://www.doubao.com/chat/998877'],
      ['doubao bare host', 'doubao', 'https://doubao.com/chat/998877'],
      ['qwen-global conversation', 'qwen-global', 'https://chat.qwen.ai/c/8f4a2b1c-1234'],
      ['chatglm conversation', 'chatglm', 'https://chatglm.cn/main/alltoolsdetail?cid=abc123'],
      ['zai-global conversation', 'zai-global', 'https://chat.z.ai/c/conv-xyz-99'],
      ['yuanbao conversation', 'yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa/conv-789'],
      ['aistudio saved prompt', 'aistudio', 'https://aistudio.google.com/prompts/1AbCdEfGhIjKlMnOp'],
    ];

    it.each(positiveCases)(
      'recognizes current URL for %s and returns it from getProviderOpenUrl',
      (_label, providerId, url) => {
        const provider = getProviderById(providerId);
        expect(isProviderCurrentUrl(providerId, url)).toBe(true);
        expect(getProviderOpenUrl(provider, url, 'search')).toBe(new URL(url).toString());
      }
    );

    const negativeCases = [
      ['chatgpt landing', 'chatgpt', 'https://chatgpt.com/'],
      ['chatgpt temporary chat', 'chatgpt', 'https://chatgpt.com/c/6789abcd?temporary-chat=true'],
      ['claude landing', 'claude', 'https://claude.ai/new'],
      ['claude incognito conversation', 'claude', 'https://claude.ai/chat/uuid-1234?incognito=true'],
      ['gemini landing /app', 'gemini', 'https://gemini.google.com/app'],
      ['gemini landing /app/', 'gemini', 'https://gemini.google.com/app/'],
      ['grok landing', 'grok', 'https://grok.com/'],
      ['grok private hash', 'grok', 'https://grok.com/c/conv-123#private'],
      ['deepseek landing', 'deepseek', 'https://chat.deepseek.com/'],
      ['kimi landing', 'kimi', 'https://www.kimi.com/'],
      ['google non-search path', 'google', 'https://www.google.com/preferences'],
      ['doubao landing /chat/', 'doubao', 'https://www.doubao.com/chat/'],
      ['qwen-cn root (always false)', 'qwen-cn', 'https://www.qianwen.com/'],
      ['qwen-cn chat path (always false)', 'qwen-cn', 'https://www.qianwen.com/chat/12345'],
      ['qwen-global landing', 'qwen-global', 'https://chat.qwen.ai/'],
      ['qwen-global new-chat', 'qwen-global', 'https://chat.qwen.ai/c/new-chat'],
      ['qwen-global new-branch', 'qwen-global', 'https://chat.qwen.ai/c/new-branch'],
      ['qwen-global guest', 'qwen-global', 'https://chat.qwen.ai/c/guest'],
      ['chatglm missing cid', 'chatglm', 'https://chatglm.cn/main/alltoolsdetail'],
      ['zai-global landing', 'zai-global', 'https://chat.z.ai/'],
      ['yuanbao agent landing without conversation segment', 'yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa'],
      ['yuanbao temporary chatMode', 'yuanbao', 'https://yuanbao.tencent.com/chat/naQivTmsDa/conv-789?chatMode=temp'],
      ['aistudio new_chat', 'aistudio', 'https://aistudio.google.com/prompts/new_chat'],
      ['aistudio new_multiturn', 'aistudio', 'https://aistudio.google.com/prompts/new_multiturn'],
      ['aistudio new_chunk', 'aistudio', 'https://aistudio.google.com/prompts/new_chunk'],
      ['aistudio temporary=true', 'aistudio', 'https://aistudio.google.com/prompts/1AbCdEfGhIjKlMnOp?temporary=true'],
      ['http scheme on valid path', 'chatgpt', 'http://chatgpt.com/c/6789abcd'],
      ['wrong provider host', 'chatgpt', 'https://claude.ai/chat/uuid-1234'],
    ];

    it.each(negativeCases)(
      'rejects non-current URL for %s and falls back in getProviderOpenUrl',
      (_label, providerId, url) => {
        const provider = getProviderById(providerId);
        expect(isProviderCurrentUrl(providerId, url)).toBe(false);
        expect(getProviderOpenUrl(provider, url)).toBe(EXPECTED_FALLBACK_URLS[providerId]);
      }
    );

    it('returns false for unknown provider in isProviderCurrentUrl and respects google search mode fallback in getProviderOpenUrl', () => {
      expect(isProviderCurrentUrl('unknown', 'https://chatgpt.com/c/123')).toBe(false);
      expect(getProviderOpenUrl(getProviderById('google'), null, 'search')).toBe('https://www.google.com/');
      expect(getProviderOpenUrl(null, 'https://chatgpt.com/c/123')).toBe('');
    });
  });

  describe('findMessageSourcePanel', () => {
    it('resolves the matching panel for every allowed origin across all 14 providers', () => {
      const panels = PROVIDERS.map((provider, idx) => ({
        id: `panel-${idx + 1}`,
        providerId: provider.id,
        iframe: { contentWindow: { marker: provider.id } },
      }));

      for (const panel of panels) {
        for (const origin of EXPECTED_FRAME_ORIGINS[panel.providerId]) {
          expect(
            findMessageSourcePanel(panels, {
              source: panel.iframe.contentWindow,
              origin,
            })
          ).toBe(panel);
        }
      }
    });

    it('returns null when source window or origin does not match the panel provider', () => {
      const chatgptWin = { name: 'chatgpt' };
      const qwenGlobalWin = { name: 'qwen-global' };
      const aistudioWin = { name: 'aistudio' };
      const panels = [
        { id: 'p-1', providerId: 'chatgpt', iframe: { contentWindow: chatgptWin } },
        { id: 'p-2', providerId: 'qwen-global', iframe: { contentWindow: qwenGlobalWin } },
        { id: 'p-3', providerId: 'aistudio', iframe: { contentWindow: aistudioWin } },
        { id: 'p-4', providerId: 'claude', iframe: null },
      ];

      // Wrong source window with valid origin
      expect(findMessageSourcePanel(panels, { source: {}, origin: 'https://chatgpt.com' })).toBeNull();
      // Source belongs to p-1 (chatgpt) but origin is p-2's provider
      expect(findMessageSourcePanel(panels, { source: chatgptWin, origin: 'https://chat.qwen.ai' })).toBeNull();
      // Secondary permission-only origins are NOT valid message frame origins
      expect(findMessageSourcePanel(panels, { source: qwenGlobalWin, origin: 'https://auth.qwen.ai' })).toBeNull();
      expect(
        findMessageSourcePanel(panels, {
          source: aistudioWin,
          origin: 'https://alkalimakersuite-pa.clients6.google.com',
        })
      ).toBeNull();
      // Plain HTTP and non-default port
      expect(findMessageSourcePanel(panels, { source: chatgptWin, origin: 'http://chatgpt.com' })).toBeNull();
      expect(findMessageSourcePanel(panels, { source: chatgptWin, origin: 'https://chatgpt.com:8443' })).toBeNull();
      // Nullish event, nullish source, or non-array panels
      expect(findMessageSourcePanel(panels, null)).toBeNull();
      expect(findMessageSourcePanel(panels, { source: null, origin: 'https://chatgpt.com' })).toBeNull();
      expect(findMessageSourcePanel(null, { source: chatgptWin, origin: 'https://chatgpt.com' })).toBeNull();
      expect(findMessageSourcePanel({}, { source: chatgptWin, origin: 'https://chatgpt.com' })).toBeNull();
    });
  });
});
