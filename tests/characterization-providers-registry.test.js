import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROVIDERS,
  getEnabledProviders,
  getProviderById,
  getProviderByIdWithSettings,
  getProviderIcon,
} from '../modules/providers.js';
import {
  DEFAULT_PROVIDER_IDS,
  LEGACY_DEFAULT_PROVIDER_IDS,
  migrateEnabledProvidersOnUpdate,
} from '../modules/provider-defaults.js';
import {
  appendProviderToOrder,
  normalizeProviderOrder,
} from '../modules/provider-order.js';

const EXPECTED_PROVIDERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    topLevelUrl: 'https://chatgpt.com/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true,
  },
  {
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    topLevelUrl: 'https://claude.ai/new',
    icon: '/icons/providers/claude.png',
    iconDark: '/icons/providers/dark/claude.png',
    enabled: true,
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    topLevelUrl: 'https://gemini.google.com/app',
    icon: '/icons/providers/gemini.png',
    iconDark: '/icons/providers/dark/gemini.png',
    enabled: true,
  },
  {
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    topLevelUrl: 'https://grok.com/',
    icon: '/icons/providers/grok.png',
    iconDark: '/icons/providers/dark/grok.png',
    enabled: true,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    topLevelUrl: 'https://chat.deepseek.com/',
    icon: '/icons/providers/deepseek.png',
    iconDark: '/icons/providers/dark/deepseek.png',
    enabled: true,
  },
  {
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com',
    topLevelUrl: 'https://www.kimi.com/',
    icon: '/icons/providers/kimi.png',
    iconDark: '/icons/providers/dark/kimi.png',
    enabled: true,
  },
  {
    id: 'google',
    name: 'Google',
    url: 'https://www.google.com/search?udm=50',
    topLevelUrl: 'https://www.google.com/search?udm=50',
    icon: '/icons/providers/google.png',
    iconDark: '/icons/providers/dark/google.png',
    enabled: true,
  },
  {
    id: 'doubao',
    name: 'Doubao',
    url: 'https://www.doubao.com/chat/',
    topLevelUrl: 'https://www.doubao.com/chat/',
    icon: '/icons/providers/doubao.png',
    iconDark: '/icons/providers/dark/doubao.png',
    enabled: true,
  },
  {
    id: 'qwen-cn',
    name: 'Qwen (China)',
    url: 'https://www.qianwen.com/',
    topLevelUrl: 'https://www.qianwen.com/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    optionalOrigins: ['https://www.qianwen.com/*'],
  },
  {
    id: 'qwen-global',
    name: 'Qwen (Global)',
    url: 'https://chat.qwen.ai/',
    topLevelUrl: 'https://chat.qwen.ai/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    optionalOrigins: ['https://chat.qwen.ai/*', 'https://auth.qwen.ai/*'],
  },
  {
    id: 'chatglm',
    name: 'Zhipu (China)',
    url: 'https://chatglm.cn/',
    topLevelUrl: 'https://chatglm.cn/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    optionalOrigins: ['https://chatglm.cn/*'],
  },
  {
    id: 'zai-global',
    name: 'Z.ai (Global)',
    url: 'https://chat.z.ai/',
    topLevelUrl: 'https://chat.z.ai/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    optionalOrigins: ['https://chat.z.ai/*'],
  },
  {
    id: 'yuanbao',
    name: 'Yuanbao',
    url: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    topLevelUrl: 'https://yuanbao.tencent.com/chat/naQivTmsDa',
    icon: '/icons/providers/yuanbao.png',
    iconDark: '/icons/providers/dark/yuanbao.png',
    enabled: true,
    optionalOrigins: ['https://yuanbao.tencent.com/*'],
  },
  {
    id: 'aistudio',
    name: 'Google AI Studio',
    url: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
    topLevelUrl: 'https://aistudio.google.com/prompts/new_chat',
    icon: '/icons/providers/aistudio.svg',
    iconDark: '/icons/providers/dark/aistudio.svg',
    enabled: true,
    optionalOrigins: [
      'https://aistudio.google.com/*',
      'https://alkalimakersuite-pa.clients6.google.com/*',
    ],
  },
];

const BUILT_IN_IDS = [
  'chatgpt',
  'claude',
  'gemini',
  'grok',
  'deepseek',
  'kimi',
  'google',
  'doubao',
];

const OPTIONAL_IDS = [
  'qwen-cn',
  'qwen-global',
  'chatglm',
  'zai-global',
  'yuanbao',
  'aistudio',
];

describe('characterization: providers registry, defaults, and ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.removeAttribute('data-theme');
    chrome.permissions = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    chrome.storage.sync.get.mockImplementation((defaults) => Promise.resolve(defaults));
    chrome.storage.sync.set.mockResolvedValue();
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
  });

  describe('PROVIDERS full catalog', () => {
    it('matches the exact ordered list of 14 provider definitions', () => {
      expect(PROVIDERS).toEqual(EXPECTED_PROVIDERS);
    });

    it('omits optionalOrigins on built-in providers and freezes optionalOrigins on optional providers', () => {
      const builtInFlags = Object.fromEntries(
        PROVIDERS.map((provider) => [
          provider.id,
          Object.prototype.hasOwnProperty.call(provider, 'optionalOrigins'),
        ])
      );
      expect(builtInFlags).toEqual({
        chatgpt: false,
        claude: false,
        gemini: false,
        grok: false,
        deepseek: false,
        kimi: false,
        google: false,
        doubao: false,
        'qwen-cn': true,
        'qwen-global': true,
        chatglm: true,
        'zai-global': true,
        yuanbao: true,
        aistudio: true,
      });

      for (const optionalId of OPTIONAL_IDS) {
        const provider = getProviderById(optionalId);
        expect(Object.isFrozen(provider.optionalOrigins)).toBe(true);
      }
    });
  });

  describe('getProviderIcon', () => {
    it('resolves exact light and dark icons for all 14 providers', () => {
      const lightIcons = Object.fromEntries(
        PROVIDERS.map((provider) => [provider.id, getProviderIcon(provider, 'light')])
      );
      const darkIcons = Object.fromEntries(
        PROVIDERS.map((provider) => [provider.id, getProviderIcon(provider, 'dark')])
      );

      expect(lightIcons).toEqual({
        chatgpt: '/icons/providers/chatgpt.png',
        claude: '/icons/providers/claude.png',
        gemini: '/icons/providers/gemini.png',
        grok: '/icons/providers/grok.png',
        deepseek: '/icons/providers/deepseek.png',
        kimi: '/icons/providers/kimi.png',
        google: '/icons/providers/google.png',
        doubao: '/icons/providers/doubao.png',
        'qwen-cn': '/icons/providers/qwen.png',
        'qwen-global': '/icons/providers/qwen.png',
        chatglm: '/icons/providers/zhipu.svg',
        'zai-global': '/icons/providers/zhipu.svg',
        yuanbao: '/icons/providers/yuanbao.png',
        aistudio: '/icons/providers/aistudio.svg',
      });

      expect(darkIcons).toEqual({
        chatgpt: '/icons/providers/dark/chatgpt.png',
        claude: '/icons/providers/dark/claude.png',
        gemini: '/icons/providers/dark/gemini.png',
        grok: '/icons/providers/dark/grok.png',
        deepseek: '/icons/providers/dark/deepseek.png',
        kimi: '/icons/providers/dark/kimi.png',
        google: '/icons/providers/dark/google.png',
        doubao: '/icons/providers/dark/doubao.png',
        'qwen-cn': '/icons/providers/dark/qwen.png',
        'qwen-global': '/icons/providers/dark/qwen.png',
        chatglm: '/icons/providers/dark/zhipu.svg',
        'zai-global': '/icons/providers/dark/zhipu.svg',
        yuanbao: '/icons/providers/dark/yuanbao.png',
        aistudio: '/icons/providers/dark/aistudio.svg',
      });
    });

    it('falls back to documentElement data-theme when explicit theme is omitted, and handles null/missing iconDark', () => {
      const chatgpt = getProviderById('chatgpt');

      expect(getProviderIcon(chatgpt)).toBe('/icons/providers/chatgpt.png');

      document.documentElement.setAttribute('data-theme', 'dark');
      expect(getProviderIcon(chatgpt)).toBe('/icons/providers/dark/chatgpt.png');
      expect(getProviderIcon(chatgpt, 'light')).toBe('/icons/providers/chatgpt.png');

      expect(getProviderIcon({ icon: '/icons/custom.png' }, 'dark')).toBe('/icons/custom.png');
      expect(getProviderIcon(null)).toBe('');
      expect(getProviderIcon(undefined)).toBe('');
    });
  });

  describe('getProviderById and getProviderByIdWithSettings', () => {
    it('returns the exact provider object for every known id', async () => {
      for (const expected of EXPECTED_PROVIDERS) {
        expect(getProviderById(expected.id)).toEqual(expected);
        await expect(getProviderByIdWithSettings(expected.id)).resolves.toEqual(expected);
      }
    });

    it('returns undefined from getProviderById and null from getProviderByIdWithSettings for unknown or prototype ids', async () => {
      const invalidIds = [
        'unknown',
        '',
        'ChatGPT',
        'custom:example',
        '__proto__',
        'constructor',
        'toString',
        null,
        undefined,
      ];

      for (const id of invalidIds) {
        expect(getProviderById(id)).toBeUndefined();
        await expect(getProviderByIdWithSettings(id)).resolves.toBeNull();
      }
    });
  });

  describe('getEnabledProviders', () => {
    it('returns the 8 default built-in providers in catalog order when storage uses defaults', async () => {
      const result = await getEnabledProviders();
      expect(result).toEqual(EXPECTED_PROVIDERS.slice(0, 8));
      expect(result.map((p) => p.id)).toEqual(BUILT_IN_IDS);
    });

    it('preserves PROVIDERS catalog order when providerOrder is null even if enabledProviders is reversed', async () => {
      chrome.storage.sync.get.mockResolvedValue({
        enabledProviders: ['doubao', 'grok', 'chatgpt'],
        providerOrder: null,
      });

      const result = await getEnabledProviders();
      expect(result.map((p) => p.id)).toEqual(['chatgpt', 'grok', 'doubao']);
    });

    it('sorts enabled providers by providerOrder and places enabled providers missing from providerOrder at the end', async () => {
      chrome.storage.sync.get.mockResolvedValue({
        enabledProviders: ['chatgpt', 'claude', 'gemini', 'doubao'],
        providerOrder: ['doubao', 'gemini'],
      });

      const result = await getEnabledProviders();
      expect(result.map((p) => p.id)).toEqual(['doubao', 'gemini', 'chatgpt', 'claude']);
    });

    it('includes optional providers only when all of their origins are granted and ignores unknown/disabled ids', async () => {
      chrome.storage.sync.get.mockResolvedValue({
        enabledProviders: [
          'chatgpt',
          'qwen-cn',
          'qwen-global',
          'yuanbao',
          'aistudio',
          'unknown-provider',
        ],
        providerOrder: [
          'unknown-provider',
          'aistudio',
          'yuanbao',
          'qwen-global',
          'qwen-cn',
          'claude',
          'chatgpt',
        ],
      });

      // Grant yuanbao fully, qwen-cn denied, qwen-global partial (missing auth.qwen.ai),
      // aistudio fully granted (both origins).
      const grantedOriginSet = new Set([
        'https://chat.qwen.ai/*',
        'https://yuanbao.tencent.com/*',
        'https://aistudio.google.com/*',
        'https://alkalimakersuite-pa.clients6.google.com/*',
      ]);
      chrome.permissions.contains.mockImplementation(({ origins }) =>
        Promise.resolve(origins.every((origin) => grantedOriginSet.has(origin)))
      );

      const result = await getEnabledProviders();
      expect(result.map((p) => p.id)).toEqual(['aistudio', 'yuanbao', 'chatgpt']);
      expect(result).toEqual([
        getProviderById('aistudio'),
        getProviderById('yuanbao'),
        getProviderById('chatgpt'),
      ]);
      expect(chrome.storage.sync.set).not.toHaveBeenCalled();
    });

    it('falls back to DEFAULT_PROVIDER_IDS when chrome.storage.sync.get rejects', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      chrome.storage.sync.get.mockRejectedValue(new Error('storage failure'));

      const result = await getEnabledProviders();
      expect(result.map((p) => p.id)).toEqual(BUILT_IN_IDS);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('provider-defaults exports and migration', () => {
    it('exports exact LEGACY_DEFAULT_PROVIDER_IDS and DEFAULT_PROVIDER_IDS arrays', () => {
      expect(LEGACY_DEFAULT_PROVIDER_IDS).toEqual([
        'chatgpt',
        'claude',
        'gemini',
        'grok',
        'deepseek',
        'kimi',
        'google',
      ]);
      expect(DEFAULT_PROVIDER_IDS).toEqual([
        'chatgpt',
        'claude',
        'gemini',
        'grok',
        'deepseek',
        'kimi',
        'google',
        'doubao',
      ]);
    });

    it('migrates null or legacy default enabledProviders to include doubao at the end', () => {
      expect(migrateEnabledProvidersOnUpdate(null, null)).toEqual({
        enabledProviders: DEFAULT_PROVIDER_IDS,
        providerOrder: DEFAULT_PROVIDER_IDS,
      });

      expect(migrateEnabledProvidersOnUpdate(undefined, undefined)).toEqual({
        enabledProviders: DEFAULT_PROVIDER_IDS,
        providerOrder: DEFAULT_PROVIDER_IDS,
      });

      expect(migrateEnabledProvidersOnUpdate(LEGACY_DEFAULT_PROVIDER_IDS, [])).toEqual({
        enabledProviders: DEFAULT_PROVIDER_IDS,
        providerOrder: DEFAULT_PROVIDER_IDS,
      });
    });

    it('preserves reordered legacy providers, deduplicates, drops non-legacy ids in providerOrder, and appends missing legacy ids plus doubao', () => {
      const reorderedLegacy = [
        'google',
        'kimi',
        'deepseek',
        'grok',
        'gemini',
        'claude',
        'chatgpt',
      ];
      expect(migrateEnabledProvidersOnUpdate(reorderedLegacy, null)).toEqual({
        enabledProviders: [...reorderedLegacy, 'doubao'],
        providerOrder: [...reorderedLegacy, 'doubao'],
      });

      expect(
        migrateEnabledProvidersOnUpdate(LEGACY_DEFAULT_PROVIDER_IDS, [
          'grok',
          'unknown',
          'qwen-cn',
          'grok',
          'claude',
        ])
      ).toEqual({
        enabledProviders: [
          'grok',
          'claude',
          'chatgpt',
          'gemini',
          'deepseek',
          'kimi',
          'google',
          'doubao',
        ],
        providerOrder: [
          'grok',
          'claude',
          'chatgpt',
          'gemini',
          'deepseek',
          'kimi',
          'google',
          'doubao',
        ],
      });
    });

    it('returns null without migrating when enabledProviders differs from the 7-provider legacy set', () => {
      expect(migrateEnabledProvidersOnUpdate(DEFAULT_PROVIDER_IDS, DEFAULT_PROVIDER_IDS)).toBeNull();
      expect(migrateEnabledProvidersOnUpdate(['chatgpt', 'claude'], ['chatgpt', 'claude'])).toBeNull();
      expect(
        migrateEnabledProvidersOnUpdate([...LEGACY_DEFAULT_PROVIDER_IDS, 'qwen-cn'], null)
      ).toBeNull();
      expect(
        migrateEnabledProvidersOnUpdate(
          ['chatgpt', 'chatgpt', 'claude', 'gemini', 'grok', 'deepseek', 'kimi'],
          null
        )
      ).toBeNull();
    });
  });

  describe('provider-order normalization and appending', () => {
    it('normalizes savedOrder against availableProviderIds, deduplicating and appending missing available ids', () => {
      expect(
        normalizeProviderOrder(
          ['grok', 'unknown', 'chatgpt', 'grok', 'aistudio'],
          ['chatgpt', 'claude', 'grok', 'aistudio']
        )
      ).toEqual(['grok', 'chatgpt', 'aistudio', 'claude']);

      expect(normalizeProviderOrder(null, ['chatgpt', 'claude'])).toEqual(['chatgpt', 'claude']);
      expect(normalizeProviderOrder(['chatgpt'], null)).toEqual([]);
    });

    it('appends a newly enabled provider using savedOrder when it is an array or fallbackOrder otherwise', () => {
      expect(
        appendProviderToOrder(
          ['claude', 'chatgpt', 'stale'],
          ['chatgpt', 'claude'],
          'aistudio',
          ['chatgpt', 'claude', 'aistudio']
        )
      ).toEqual(['claude', 'chatgpt', 'aistudio']);

      // Empty array is still an Array, so fallbackOrder is NOT used.
      expect(
        appendProviderToOrder(
          [],
          ['chatgpt', 'claude'],
          'aistudio',
          ['chatgpt', 'claude', 'aistudio']
        )
      ).toEqual(['aistudio']);

      // Non-array savedOrder falls back to fallbackOrder.
      expect(
        appendProviderToOrder(
          null,
          ['claude', 'chatgpt'],
          'aistudio',
          ['chatgpt', 'claude', 'aistudio']
        )
      ).toEqual(['claude', 'chatgpt', 'aistudio']);

      // Does not duplicate an already present provider or append an unavailable provider.
      expect(
        appendProviderToOrder(
          ['claude', 'aistudio'],
          [],
          'aistudio',
          ['claude', 'aistudio']
        )
      ).toEqual(['claude', 'aistudio']);

      expect(
        appendProviderToOrder(
          ['claude'],
          [],
          'qwen-cn',
          ['claude', 'chatgpt']
        )
      ).toEqual(['claude']);
    });
  });
});
