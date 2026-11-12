/**
 * Leaf registry of provider descriptors for the Multi-Panel host side.
 *
 * Must remain import-free and free of `chrome.*` calls at module evaluation
 * time so other host modules can query built-in descriptors synchronously
 * without circular dependencies.
 */

const YUANBAO_DEFAULT_URL = 'https://yuanbao.tencent.com/chat/naQivTmsDa';

export const CUSTOM_PROVIDER_ID_PATTERN = /^custom-[0-9a-f]{10}$/;
export const CUSTOM_FRAME_RULE_ID_MIN = 10000;
export const CUSTOM_FRAME_RULE_ID_MAX = 19999;

const DEFAULT_BUILTIN_CAPABILITIES = Object.freeze({
  imageUpload: true,
  inPageNewChat: true,
  snapshotStitch: true
});

const DEFAULT_CUSTOM_CAPABILITIES = Object.freeze({
  imageUpload: false,
  inPageNewChat: false,
  snapshotStitch: false
});

const frozenDescriptors = new WeakSet();

function createOptionalContentScriptSpec(matchPattern, enterBehaviorScript) {
  return Object.freeze({
    matches: Object.freeze([matchPattern]),
    js: Object.freeze([
      'content-scripts/button-finder-utils.js',
      'content-scripts/enter-behavior-utils.js',
      enterBehaviorScript,
      'content-scripts/text-injection-all-providers.js',
      'content-scripts/focus-toggle.js'
    ])
  });
}

function freezeDescriptor(descriptor) {
  const frozenFrameOrigins = Object.freeze([...descriptor.frameOrigins]);
  const frozenAllowedHosts = Object.freeze([...descriptor.allowedHosts]);
  const frozenPermissionOrigins = descriptor.permissionOrigins
    ? Object.freeze([...descriptor.permissionOrigins])
    : null;
  const frozenContentScript = descriptor.contentScript
    ? Object.freeze({
        matches: Object.freeze([...descriptor.contentScript.matches]),
        js: Object.freeze([...descriptor.contentScript.js])
      })
    : null;
  const frozenFrameRule = descriptor.frameRule
    ? Object.freeze({
        id: descriptor.frameRule.id,
        urlFilter: descriptor.frameRule.urlFilter
      })
    : null;
  const frozenTempChat = descriptor.tempChat
    ? Object.freeze({
        url: descriptor.tempChat.url ?? null,
        normalUrl: descriptor.tempChat.normalUrl,
        retry: Boolean(descriptor.tempChat.retry)
      })
    : null;
  const rawCapabilities = descriptor.capabilities
    ?? (descriptor.access === 'custom' ? DEFAULT_CUSTOM_CAPABILITIES : DEFAULT_BUILTIN_CAPABILITIES);
  const frozenCapabilities = Object.freeze({
    imageUpload: Boolean(rawCapabilities.imageUpload),
    inPageNewChat: Boolean(rawCapabilities.inPageNewChat),
    snapshotStitch: Boolean(rawCapabilities.snapshotStitch)
  });

  const frozen = Object.freeze({
    id: descriptor.id,
    name: descriptor.name,
    url: descriptor.url,
    topLevelUrl: descriptor.topLevelUrl,
    icon: descriptor.icon,
    iconDark: descriptor.iconDark,
    enabled: descriptor.enabled,
    access: descriptor.access,
    frameOrigins: frozenFrameOrigins,
    allowedHosts: frozenAllowedHosts,
    permissionOrigins: frozenPermissionOrigins,
    contentScript: frozenContentScript,
    frameRule: frozenFrameRule,
    tempChat: frozenTempChat,
    capabilities: frozenCapabilities
  });
  frozenDescriptors.add(frozen);
  return frozen;
}

function isValidHttpHostname(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) {
    return false;
  }
  if (/^\[[0-9a-f:]+\]$/i.test(hostname)) {
    return true;
  }
  if (!/^[a-z0-9.-]+$/i.test(hostname)) {
    return false;
  }
  if (
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.includes('..')
  ) {
    return false;
  }
  return true;
}

function isHttpOrHttpsUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    return isValidHttpHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function isExactHttpOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    if (!isValidHttpHostname(parsed.hostname)) {
      return false;
    }
    return origin === parsed.origin;
  } catch {
    return false;
  }
}

function isBareHostname(hostname) {
  if (
    typeof hostname !== 'string' ||
    hostname.length === 0 ||
    hostname !== hostname.trim() ||
    hostname.includes('://') ||
    hostname.includes(':') ||
    hostname.includes('*') ||
    /[/\\?#\s]/.test(hostname)
  ) {
    return false;
  }
  try {
    const parsed = new URL(`https://${hostname}`);
    return (
      parsed.hostname === hostname &&
      parsed.port === '' &&
      parsed.origin === `https://${hostname}`
    );
  } catch {
    return false;
  }
}

function isOriginMatchPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.endsWith('/*')) {
    return false;
  }
  const originPart = pattern.slice(0, -2);
  return isExactHttpOrigin(originPart);
}

/**
 * Validates one provider descriptor and returns a list of human-readable errors.
 * An empty array means the descriptor is valid.
 *
 * @param {unknown} descriptor
 * @param {{ seenIds?: Set<string> | null, seenFrameRuleIds?: Set<number> | null }} [options]
 * @returns {string[]}
 */
export function validateProviderDescriptor(
  descriptor,
  { seenIds = null, seenFrameRuleIds = null } = {}
) {
  const errors = [];

  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    return ['Descriptor must be a non-null object'];
  }

  const { id } = descriptor;
  const isCustom = descriptor.access === 'custom';
  if (typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()) {
    errors.push('Descriptor id must be a non-empty trimmed string');
  } else {
    if (isCustom && !CUSTOM_PROVIDER_ID_PATTERN.test(id)) {
      errors.push(`Provider "${id}": custom provider id must match /^custom-[0-9a-f]{10}$/`);
    } else if (!isCustom && id.startsWith('custom-')) {
      errors.push(`Provider "${id}": non-custom provider id must not start with "custom-"`);
    }
    if (seenIds instanceof Set) {
      if (seenIds.has(id)) {
        errors.push(`Duplicate provider id: "${id}"`);
      } else {
        seenIds.add(id);
      }
    }
  }

  if (typeof descriptor.name !== 'string' || descriptor.name.trim().length === 0) {
    errors.push(`Provider "${id || '<unnamed>'}": name must be a non-empty string`);
  }

  if (!isHttpOrHttpsUrl(descriptor.url)) {
    errors.push(`Provider "${id || '<unnamed>'}": url must be a valid http(s) URL`);
  }

  if (!isHttpOrHttpsUrl(descriptor.topLevelUrl)) {
    errors.push(`Provider "${id || '<unnamed>'}": topLevelUrl must be a valid http(s) URL`);
  }

  if (typeof descriptor.icon !== 'string' || descriptor.icon.trim().length === 0) {
    errors.push(`Provider "${id || '<unnamed>'}": icon must be a non-empty string`);
  }

  if (typeof descriptor.iconDark !== 'string' || descriptor.iconDark.trim().length === 0) {
    errors.push(`Provider "${id || '<unnamed>'}": iconDark must be a non-empty string`);
  }

  if (typeof descriptor.enabled !== 'boolean') {
    errors.push(`Provider "${id || '<unnamed>'}": enabled must be a boolean`);
  }

  if (
    descriptor.access !== 'builtin' &&
    descriptor.access !== 'optional' &&
    descriptor.access !== 'custom'
  ) {
    errors.push(
      `Provider "${id || '<unnamed>'}": access must be "builtin", "optional", or "custom"`
    );
  }

  let customOrigin = null;
  if (!Array.isArray(descriptor.frameOrigins) || descriptor.frameOrigins.length === 0) {
    errors.push(`Provider "${id || '<unnamed>'}": frameOrigins must be a non-empty array`);
  } else {
    if (isCustom && descriptor.frameOrigins.length !== 1) {
      errors.push(`Provider "${id || '<unnamed>'}": custom provider frameOrigins must contain exactly one origin`);
    }
    for (const origin of descriptor.frameOrigins) {
      if (!isExactHttpOrigin(origin)) {
        errors.push(
          `Provider "${id || '<unnamed>'}": invalid frame origin "${String(origin)}" (expected exact http(s) origin without path, query, or hash)`
        );
      }
    }
    if (isCustom && isExactHttpOrigin(descriptor.frameOrigins[0])) {
      customOrigin = descriptor.frameOrigins[0];
      if (isHttpOrHttpsUrl(descriptor.url) && new URL(descriptor.url).origin !== customOrigin) {
        errors.push(`Provider "${id || '<unnamed>'}": custom provider url origin must match frameOrigins[0]`);
      }
      if (
        isHttpOrHttpsUrl(descriptor.topLevelUrl) &&
        new URL(descriptor.topLevelUrl).origin !== customOrigin
      ) {
        errors.push(`Provider "${id || '<unnamed>'}": custom provider topLevelUrl origin must match frameOrigins[0]`);
      }
    }
  }

  if (isCustom) {
    if (!Array.isArray(descriptor.allowedHosts) || descriptor.allowedHosts.length !== 0) {
      errors.push(`Provider "${id || '<unnamed>'}": custom provider allowedHosts must be an empty array`);
    }
  } else if (!Array.isArray(descriptor.allowedHosts) || descriptor.allowedHosts.length === 0) {
    errors.push(`Provider "${id || '<unnamed>'}": allowedHosts must be a non-empty array`);
  } else {
    for (const host of descriptor.allowedHosts) {
      if (!isBareHostname(host)) {
        errors.push(
          `Provider "${id || '<unnamed>'}": invalid allowedHosts entry "${String(host)}" (expected bare hostname)`
        );
      }
    }
  }

  if (descriptor.access === 'optional') {
    if (
      !Array.isArray(descriptor.permissionOrigins) ||
      descriptor.permissionOrigins.length === 0 ||
      !descriptor.permissionOrigins.every(isOriginMatchPattern)
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": optional provider permissionOrigins must be a non-empty array of http(s) origin/* patterns`
      );
    }
  } else if (isCustom) {
    if (
      !Array.isArray(descriptor.permissionOrigins) ||
      descriptor.permissionOrigins.length !== 1 ||
      !isOriginMatchPattern(descriptor.permissionOrigins[0]) ||
      (customOrigin !== null && descriptor.permissionOrigins[0] !== `${customOrigin}/*`)
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": custom provider permissionOrigins must be ["<origin>/*"]`
      );
    }
  } else if (descriptor.permissionOrigins !== null && descriptor.permissionOrigins !== undefined) {
    errors.push(
      `Provider "${id || '<unnamed>'}": builtin provider permissionOrigins must be null`
    );
  }

  if (isCustom && (descriptor.contentScript === null || descriptor.contentScript === undefined)) {
    errors.push(`Provider "${id || '<unnamed>'}": custom provider contentScript is required`);
  }

  if (descriptor.contentScript !== null && descriptor.contentScript !== undefined) {
    const cs = descriptor.contentScript;
    if (
      typeof cs !== 'object' ||
      !Array.isArray(cs.matches) ||
      cs.matches.length === 0 ||
      !cs.matches.every((pattern) => typeof pattern === 'string' && pattern.trim().length > 0) ||
      !Array.isArray(cs.js) ||
      cs.js.length === 0 ||
      !cs.js.every((file) => typeof file === 'string' && file.trim().length > 0)
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": contentScript must specify non-empty matches and js arrays`
      );
    } else if (
      isCustom &&
      customOrigin !== null &&
      (cs.matches.length !== 1 || cs.matches[0] !== `${customOrigin}/*`)
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": custom provider contentScript.matches must be ["<origin>/*"]`
      );
    }
  }

  if (isCustom && (descriptor.frameRule === null || descriptor.frameRule === undefined)) {
    errors.push(`Provider "${id || '<unnamed>'}": custom provider frameRule is required`);
  }

  if (descriptor.frameRule !== null && descriptor.frameRule !== undefined) {
    const rule = descriptor.frameRule;
    if (
      typeof rule !== 'object' ||
      !Number.isInteger(rule.id) ||
      rule.id <= 0 ||
      typeof rule.urlFilter !== 'string' ||
      rule.urlFilter.trim().length === 0
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": frameRule must have a positive integer id and non-empty urlFilter`
      );
    } else {
      if (isCustom) {
        if (rule.id < CUSTOM_FRAME_RULE_ID_MIN || rule.id > CUSTOM_FRAME_RULE_ID_MAX) {
          errors.push(
            `Provider "${id || '<unnamed>'}": custom provider frameRule.id must be in ${CUSTOM_FRAME_RULE_ID_MIN}..${CUSTOM_FRAME_RULE_ID_MAX}`
          );
        }
        if (customOrigin !== null && rule.urlFilter !== `|${customOrigin}/`) {
          errors.push(
            `Provider "${id || '<unnamed>'}": custom provider frameRule.urlFilter must be "|${customOrigin}/"`
          );
        }
      } else if (rule.id >= CUSTOM_FRAME_RULE_ID_MIN && rule.id <= CUSTOM_FRAME_RULE_ID_MAX) {
        errors.push(
          `Provider "${id || '<unnamed>'}": non-custom frameRule.id must not fall in reserved custom range ${CUSTOM_FRAME_RULE_ID_MIN}..${CUSTOM_FRAME_RULE_ID_MAX}`
        );
      }
      if (seenFrameRuleIds instanceof Set) {
        if (seenFrameRuleIds.has(rule.id)) {
          errors.push(`Duplicate frameRule id: ${rule.id}`);
        } else {
          seenFrameRuleIds.add(rule.id);
        }
      }
    }
  }

  if (isCustom && descriptor.tempChat !== null) {
    errors.push(`Provider "${id || '<unnamed>'}": custom provider tempChat must be null`);
  } else if (descriptor.tempChat !== null && descriptor.tempChat !== undefined) {
    const tc = descriptor.tempChat;
    if (
      typeof tc !== 'object' ||
      (tc.url !== null && tc.url !== undefined && !isHttpOrHttpsUrl(tc.url)) ||
      !isHttpOrHttpsUrl(tc.normalUrl) ||
      typeof tc.retry !== 'boolean'
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": tempChat must have nullable http(s) url, http(s) normalUrl, and boolean retry`
      );
    }
  }

  if (isCustom && (descriptor.capabilities === null || descriptor.capabilities === undefined)) {
    errors.push(`Provider "${id || '<unnamed>'}": custom provider capabilities is required`);
  }

  if (descriptor.capabilities !== null && descriptor.capabilities !== undefined) {
    const cap = descriptor.capabilities;
    if (
      typeof cap !== 'object' ||
      Array.isArray(cap) ||
      typeof cap.imageUpload !== 'boolean' ||
      typeof cap.inPageNewChat !== 'boolean' ||
      typeof cap.snapshotStitch !== 'boolean'
    ) {
      errors.push(
        `Provider "${id || '<unnamed>'}": capabilities must specify boolean imageUpload, inPageNewChat, and snapshotStitch`
      );
    }
  }

  return errors;
}

/**
 * Validates a collection of descriptors, enforcing unique provider IDs and
 * unique frameRule IDs across the collection.
 *
 * @param {unknown[]} descriptors
 * @returns {string[]}
 */
export function validateProviderDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) {
    return ['Descriptors must be an array'];
  }
  const seenIds = new Set();
  const seenFrameRuleIds = new Set();
  const errors = [];

  for (const descriptor of descriptors) {
    errors.push(
      ...validateProviderDescriptor(descriptor, { seenIds, seenFrameRuleIds })
    );
  }

  return errors;
}

/**
 * Pure factory that builds an immutable, Map-backed provider registry.
 * Throws if any descriptor is invalid or if provider IDs / frameRule IDs collide.
 *
 * @param {object[]} descriptors
 * @returns {{ list: () => object[], get: (id: unknown) => object | undefined, has: (id: unknown) => boolean }}
 */
export function createProviderRegistry(descriptors) {
  const errors = validateProviderDescriptors(descriptors);
  if (errors.length > 0) {
    throw new Error(`Invalid provider descriptors: ${errors.join('; ')}`);
  }

  const byId = new Map();
  for (const rawDescriptor of descriptors) {
    const frozen = frozenDescriptors.has(rawDescriptor)
      ? rawDescriptor
      : freezeDescriptor(rawDescriptor);
    byId.set(frozen.id, frozen);
  }

  const ordered = Object.freeze([...byId.values()]);

  return Object.freeze({
    list() {
      return [...ordered];
    },
    get(id) {
      return typeof id === 'string' ? byId.get(id) : undefined;
    },
    has(id) {
      return typeof id === 'string' && byId.has(id);
    }
  });
}

export const BUILTIN_PROVIDER_DESCRIPTORS = Object.freeze([
  freezeDescriptor({
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    topLevelUrl: 'https://chatgpt.com/',
    icon: '/icons/providers/chatgpt.png',
    iconDark: '/icons/providers/dark/chatgpt.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://chatgpt.com', 'https://chat.openai.com'],
    allowedHosts: ['chatgpt.com', 'chat.openai.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: {
      url: 'https://chatgpt.com/?temporary-chat=true',
      normalUrl: 'https://chatgpt.com/',
      retry: false
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'claude',
    name: 'Claude',
    url: 'https://claude.ai',
    topLevelUrl: 'https://claude.ai/new',
    icon: '/icons/providers/claude.png',
    iconDark: '/icons/providers/dark/claude.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://claude.ai'],
    allowedHosts: ['claude.ai'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: {
      url: 'https://claude.ai/new?incognito',
      normalUrl: 'https://claude.ai/new',
      retry: false
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    topLevelUrl: 'https://gemini.google.com/app',
    icon: '/icons/providers/gemini.png',
    iconDark: '/icons/providers/dark/gemini.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://gemini.google.com'],
    allowedHosts: ['gemini.google.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: {
      url: null,
      normalUrl: 'https://gemini.google.com/',
      retry: true
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'grok',
    name: 'Grok',
    url: 'https://grok.com',
    topLevelUrl: 'https://grok.com/',
    icon: '/icons/providers/grok.png',
    iconDark: '/icons/providers/dark/grok.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://grok.com'],
    allowedHosts: ['grok.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: {
      url: 'https://grok.com/c#private',
      normalUrl: 'https://grok.com/',
      retry: true
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    topLevelUrl: 'https://chat.deepseek.com/',
    icon: '/icons/providers/deepseek.png',
    iconDark: '/icons/providers/dark/deepseek.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://chat.deepseek.com'],
    allowedHosts: ['chat.deepseek.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'kimi',
    name: 'Kimi',
    url: 'https://www.kimi.com',
    topLevelUrl: 'https://www.kimi.com/',
    icon: '/icons/providers/kimi.png',
    iconDark: '/icons/providers/dark/kimi.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://www.kimi.com', 'https://kimi.com'],
    allowedHosts: ['www.kimi.com', 'kimi.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'google',
    name: 'Google',
    url: 'https://www.google.com/search?udm=50',
    topLevelUrl: 'https://www.google.com/search?udm=50',
    icon: '/icons/providers/google.png',
    iconDark: '/icons/providers/dark/google.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://www.google.com', 'https://google.com'],
    allowedHosts: ['www.google.com', 'google.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'doubao',
    name: 'Doubao',
    url: 'https://www.doubao.com/chat/',
    topLevelUrl: 'https://www.doubao.com/chat/',
    icon: '/icons/providers/doubao.png',
    iconDark: '/icons/providers/dark/doubao.png',
    enabled: true,
    access: 'builtin',
    frameOrigins: ['https://www.doubao.com', 'https://doubao.com'],
    allowedHosts: ['www.doubao.com', 'doubao.com'],
    permissionOrigins: null,
    contentScript: null,
    frameRule: null,
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'qwen-cn',
    name: 'Qwen (China)',
    url: 'https://www.qianwen.com/',
    topLevelUrl: 'https://www.qianwen.com/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://www.qianwen.com'],
    allowedHosts: ['www.qianwen.com'],
    permissionOrigins: ['https://www.qianwen.com/*'],
    contentScript: createOptionalContentScriptSpec(
      'https://www.qianwen.com/*',
      'content-scripts/enter-behavior-qwen-cn.js'
    ),
    frameRule: {
      id: 1001,
      urlFilter: 'https://www.qianwen.com/*'
    },
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'qwen-global',
    name: 'Qwen (Global)',
    url: 'https://chat.qwen.ai/',
    topLevelUrl: 'https://chat.qwen.ai/',
    icon: '/icons/providers/qwen.png',
    iconDark: '/icons/providers/dark/qwen.png',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://chat.qwen.ai'],
    allowedHosts: ['chat.qwen.ai'],
    permissionOrigins: ['https://chat.qwen.ai/*', 'https://auth.qwen.ai/*'],
    contentScript: createOptionalContentScriptSpec(
      'https://chat.qwen.ai/*',
      'content-scripts/enter-behavior-qwen-global.js'
    ),
    frameRule: {
      id: 1002,
      urlFilter: 'https://chat.qwen.ai/*'
    },
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'chatglm',
    name: 'Zhipu (China)',
    url: 'https://chatglm.cn/',
    topLevelUrl: 'https://chatglm.cn/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://chatglm.cn'],
    allowedHosts: ['chatglm.cn'],
    permissionOrigins: ['https://chatglm.cn/*'],
    contentScript: createOptionalContentScriptSpec(
      'https://chatglm.cn/*',
      'content-scripts/enter-behavior-chatglm.js'
    ),
    frameRule: {
      id: 1003,
      urlFilter: 'https://chatglm.cn/*'
    },
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'zai-global',
    name: 'Z.ai (Global)',
    url: 'https://chat.z.ai/',
    topLevelUrl: 'https://chat.z.ai/',
    icon: '/icons/providers/zhipu.svg',
    iconDark: '/icons/providers/dark/zhipu.svg',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://chat.z.ai'],
    allowedHosts: ['chat.z.ai'],
    permissionOrigins: ['https://chat.z.ai/*'],
    contentScript: createOptionalContentScriptSpec(
      'https://chat.z.ai/*',
      'content-scripts/enter-behavior-zai-global.js'
    ),
    frameRule: {
      id: 1004,
      urlFilter: 'https://chat.z.ai/*'
    },
    tempChat: null,
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'yuanbao',
    name: 'Yuanbao',
    url: YUANBAO_DEFAULT_URL,
    topLevelUrl: YUANBAO_DEFAULT_URL,
    icon: '/icons/providers/yuanbao.png',
    iconDark: '/icons/providers/dark/yuanbao.png',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://yuanbao.tencent.com'],
    allowedHosts: ['yuanbao.tencent.com'],
    permissionOrigins: ['https://yuanbao.tencent.com/*'],
    contentScript: createOptionalContentScriptSpec(
      'https://yuanbao.tencent.com/*',
      'content-scripts/enter-behavior-yuanbao.js'
    ),
    frameRule: null,
    tempChat: {
      url: null,
      normalUrl: YUANBAO_DEFAULT_URL,
      retry: true
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  }),
  freezeDescriptor({
    id: 'aistudio',
    name: 'Google AI Studio',
    // Explicit opt-out: AI Studio keeps temporary mode sticky after ?temporary=true.
    url: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
    topLevelUrl: 'https://aistudio.google.com/prompts/new_chat',
    icon: '/icons/providers/aistudio.svg',
    iconDark: '/icons/providers/dark/aistudio.svg',
    enabled: true,
    access: 'optional',
    frameOrigins: ['https://aistudio.google.com'],
    allowedHosts: ['aistudio.google.com'],
    permissionOrigins: [
      'https://aistudio.google.com/*',
      'https://alkalimakersuite-pa.clients6.google.com/*'
    ],
    contentScript: createOptionalContentScriptSpec(
      'https://aistudio.google.com/*',
      'content-scripts/enter-behavior-aistudio.js'
    ),
    frameRule: {
      id: 1005,
      urlFilter: 'https://aistudio.google.com/*'
    },
    tempChat: {
      url: 'https://aistudio.google.com/prompts/new_chat?temporary=true',
      normalUrl: 'https://aistudio.google.com/prompts/new_chat?temporary=false',
      retry: false
    },
    capabilities: DEFAULT_BUILTIN_CAPABILITIES
  })
]);

const builtinRegistry = createProviderRegistry(BUILTIN_PROVIDER_DESCRIPTORS);
let customDescriptors = [];
let extraDescriptors = [];
let activeRegistry = builtinRegistry;

function rebuildActiveRegistry(nextCustom, nextExtra) {
  if (nextCustom.length === 0 && nextExtra.length === 0) {
    return builtinRegistry;
  }
  return createProviderRegistry([
    ...BUILTIN_PROVIDER_DESCRIPTORS,
    ...nextCustom,
    ...nextExtra
  ]);
}

export const defaultProviderRegistry = Object.freeze({
  list() {
    return activeRegistry.list();
  },
  get(id) {
    return activeRegistry.get(id);
  },
  has(id) {
    return activeRegistry.has(id);
  }
});

export function listProviderDescriptors() {
  return activeRegistry.list();
}

export function getProviderDescriptor(id) {
  return activeRegistry.get(id);
}

export function hasProviderDescriptor(id) {
  return activeRegistry.has(id);
}

export function isTemporaryChatSupportedProvider(providerId) {
  return Boolean(getProviderDescriptor(providerId)?.tempChat);
}

export function requiresTemporaryChatActivationRetry(providerId) {
  return Boolean(getProviderDescriptor(providerId)?.tempChat?.retry);
}

export function isUrlDrivenTemporaryChatProvider(providerId) {
  return Boolean(getProviderDescriptor(providerId)?.tempChat?.url);
}

export function getTemporaryChatUrl(providerId) {
  return getProviderDescriptor(providerId)?.tempChat?.url || null;
}

export function getTemporaryChatNormalUrl(providerId) {
  return getProviderDescriptor(providerId)?.tempChat?.normalUrl || null;
}

/**
 * Atomically replaces the custom provider descriptor set in the module-level
 * default registry.
 *
 * @param {object[]} descriptors
 */
export function setCustomProviderDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) {
    throw new Error('Custom provider descriptors must be an array');
  }
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== 'object' || descriptor.access !== 'custom') {
      throw new Error(
        'setCustomProviderDescriptors only accepts descriptors with access: "custom"'
      );
    }
  }
  const nextRegistry = rebuildActiveRegistry(descriptors, extraDescriptors);
  const allDescriptors = nextRegistry.list();
  customDescriptors = allDescriptors.slice(
    BUILTIN_PROVIDER_DESCRIPTORS.length,
    BUILTIN_PROVIDER_DESCRIPTORS.length + descriptors.length
  );
  activeRegistry = nextRegistry;
}

/**
 * Merges extra provider descriptors after the built-in and custom descriptors
 * in the module-level default registry.
 *
 * Test-only hook: no shipped product code path may call this function.
 *
 * @param {object[]} descriptors
 */
export function registerExtraProviderDescriptors(descriptors) {
  if (!Array.isArray(descriptors)) {
    throw new Error('Extra provider descriptors must be an array');
  }
  const mergedExtra = [...extraDescriptors, ...descriptors];
  const nextRegistry = rebuildActiveRegistry(customDescriptors, mergedExtra);
  const allDescriptors = nextRegistry.list();
  extraDescriptors = allDescriptors.slice(
    BUILTIN_PROVIDER_DESCRIPTORS.length + customDescriptors.length
  );
  activeRegistry = nextRegistry;
}

/**
 * Removes test-only extra provider descriptors while preserving built-in and
 * hydrated custom descriptors.
 *
 * Test-only hook: no shipped product code path may call this function.
 */
export function resetExtraProviderDescriptors() {
  extraDescriptors = [];
  activeRegistry = rebuildActiveRegistry(customDescriptors, []);
}
