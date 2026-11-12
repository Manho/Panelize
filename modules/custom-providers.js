import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  CUSTOM_PROVIDER_ID_PATTERN,
  getProviderDescriptor,
  listProviderDescriptors,
  setCustomProviderDescriptors,
  validateProviderDescriptor
} from './provider-registry.js';
import { resolveChatCompletionsUrl } from './openai-chat-client.js';

export {
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  CUSTOM_PROVIDER_ID_PATTERN
};

export const CUSTOM_PROVIDERS_STORAGE_KEY = 'customProviders';
export const MAX_CUSTOM_PROVIDER_NAME_LENGTH = 40;
export const MAX_CUSTOM_API_MODEL_LENGTH = 200;
export const CUSTOM_PROVIDER_ICON = '/icons/providers/custom.svg';
export const CUSTOM_PROVIDER_ICON_DARK = '/icons/providers/dark/custom.svg';
export const CUSTOM_PROVIDER_DRIVER_SCRIPT = 'content-scripts/custom-provider-driver.js';
export const CUSTOM_API_PANEL_PATH = 'api-panel/api-panel.html';

const CUSTOM_CAPABILITIES = Object.freeze({
  imageUpload: false,
  inPageNewChat: false,
  snapshotStitch: false
});

const CUSTOM_API_CAPABILITIES = Object.freeze({
  imageUpload: true,
  inPageNewChat: true,
  snapshotStitch: true
});

const EXTENSION_ORIGIN_URL_PREFIX = /^(chrome-extension:\/\/[a-z0-9_-]+)(?:\/|$)/i;

function resolveExtensionOrigin(explicitExtensionOrigin = null) {
  if (typeof explicitExtensionOrigin === 'string') {
    const match = EXTENSION_ORIGIN_URL_PREFIX.exec(explicitExtensionOrigin.trim());
    if (match) {
      return match[1];
    }
  }

  if (typeof chrome !== 'undefined' && typeof chrome?.runtime?.getURL === 'function') {
    const runtimeBase = chrome.runtime.getURL('');
    const match = typeof runtimeBase === 'string' ? EXTENSION_ORIGIN_URL_PREFIX.exec(runtimeBase) : null;
    if (match) {
      return match[1];
    }
  }

  if (
    typeof chrome !== 'undefined' &&
    typeof chrome?.runtime?.id === 'string' &&
    /^[a-z0-9_-]+$/i.test(chrome.runtime.id)
  ) {
    return `chrome-extension://${chrome.runtime.id}`;
  }

  return 'chrome-extension://test-extension-id';
}

export function getCustomProviderOrigin(descriptorOrId) {
  const descriptor =
    typeof descriptorOrId === 'string'
      ? getProviderDescriptor(descriptorOrId)
      : descriptorOrId;
  if (!descriptor || descriptor.access !== 'custom') {
    return null;
  }
  if (descriptor.customKind === 'api') {
    return descriptor.apiConfig?.apiOrigin || null;
  }
  return descriptor.frameOrigins?.[0] || null;
}

export function isCustomProviderId(id) {
  return typeof id === 'string' && CUSTOM_PROVIDER_ID_PATTERN.test(id);
}

export function generateCustomProviderId() {
  const bytes = new Uint8Array(5);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `custom-${hex}`;
}

function extractFrameRuleId(entry) {
  if (Number.isInteger(entry)) {
    return entry;
  }
  if (!entry || typeof entry !== 'object') {
    return null;
  }
  if (Number.isInteger(entry.frameRuleId)) {
    return entry.frameRuleId;
  }
  if (Number.isInteger(entry.frameRule?.id)) {
    return entry.frameRule.id;
  }
  if (Number.isInteger(entry.apiOriginRule?.id)) {
    return entry.apiOriginRule.id;
  }
  return null;
}

export function allocateCustomFrameRuleId(existing = null) {
  const source = Array.isArray(existing)
    ? existing
    : listProviderDescriptors().filter((descriptor) => descriptor.access === 'custom');
  const usedIds = new Set();

  for (const item of source) {
    const ruleId = extractFrameRuleId(item);
    if (
      ruleId !== null &&
      ruleId >= CUSTOM_FRAME_RULE_ID_MIN &&
      ruleId <= CUSTOM_FRAME_RULE_ID_MAX
    ) {
      usedIds.add(ruleId);
    }
  }

  for (let candidate = CUSTOM_FRAME_RULE_ID_MIN; candidate <= CUSTOM_FRAME_RULE_ID_MAX; candidate += 1) {
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('Exhausted custom provider frameRule id range (10000..19999)');
}

function parseIpv4Octets(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return null;
  }
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
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

function isAllowedHttpHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') {
    return true;
  }

  const ipv4 = parseIpv4Octets(hostname);
  if (!ipv4) {
    return false;
  }

  const [a, b] = ipv4;
  // Loopback 127.0.0.0/8
  if (a === 127) {
    return true;
  }
  // Private RFC1918 ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }

  return false;
}

function collectReservedNonCustomOrigins() {
  const origins = new Set();
  const nonCustomDescriptors = [
    ...BUILTIN_PROVIDER_DESCRIPTORS,
    ...listProviderDescriptors().filter((descriptor) => descriptor.access !== 'custom')
  ];

  for (const descriptor of nonCustomDescriptors) {
    for (const frameOrigin of descriptor.frameOrigins || []) {
      origins.add(frameOrigin);
    }
    for (const pattern of descriptor.permissionOrigins || []) {
      const origin = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
      origins.add(origin);
    }
  }

  return origins;
}

function collectExistingCustomOrigins({ ignoreProviderId = null, existingCustomOrigins = null } = {}) {
  if (existingCustomOrigins instanceof Set) {
    return existingCustomOrigins;
  }
  if (Array.isArray(existingCustomOrigins)) {
    return new Set(existingCustomOrigins);
  }

  const origins = new Set();
  for (const descriptor of listProviderDescriptors()) {
    if (
      descriptor.access !== 'custom' ||
      descriptor.customKind === 'api' ||
      descriptor.id === ignoreProviderId
    ) {
      continue;
    }
    for (const frameOrigin of descriptor.frameOrigins) {
      origins.add(frameOrigin);
    }
  }
  return origins;
}

function parseAndValidateCustomHttpUrl(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, parsed: null, reason: 'invalid_url' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, parsed: null, reason: 'invalid_url' };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const authority = trimmed.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    if (authority.includes('@')) {
      return { ok: false, parsed: null, reason: 'credentials_not_allowed' };
    }
    if (
      authority.length === 0 ||
      authority === '[]' ||
      authority.startsWith(':') ||
      authority.startsWith('[]')
    ) {
      return { ok: false, parsed: null, reason: 'empty_host' };
    }
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, parsed: null, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, parsed: null, reason: 'unsupported_scheme' };
  }

  if (!parsed.hostname) {
    return { ok: false, parsed: null, reason: 'empty_host' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, parsed: null, reason: 'credentials_not_allowed' };
  }

  if (!isValidHttpHostname(parsed.hostname)) {
    return { ok: false, parsed: null, reason: 'invalid_url' };
  }

  if (parsed.protocol === 'http:' && !isAllowedHttpHost(parsed.hostname)) {
    return { ok: false, parsed: null, reason: 'insecure_http' };
  }

  parsed.hash = '';

  if (collectReservedNonCustomOrigins().has(parsed.origin)) {
    return { ok: false, parsed: null, reason: 'builtin_origin' };
  }

  return { ok: true, parsed, reason: null };
}

/**
 * Validates and normalizes a raw custom provider URL.
 *
 * @param {unknown} raw
 * @param {{ ignoreProviderId?: string | null, existingCustomOrigins?: Set<string> | string[] | null }} [options]
 * @returns {{ ok: boolean, url: string | null, origin: string | null, reason: string | null }}
 */
export function validateCustomProviderUrl(raw, options = {}) {
  const baseCheck = parseAndValidateCustomHttpUrl(raw);
  if (!baseCheck.ok) {
    return { ok: false, url: null, origin: null, reason: baseCheck.reason };
  }

  const normalizedUrl = baseCheck.parsed.toString();
  const { origin } = baseCheck.parsed;

  if (collectExistingCustomOrigins(options).has(origin)) {
    return { ok: false, url: null, origin: null, reason: 'duplicate_custom_origin' };
  }

  return { ok: true, url: normalizedUrl, origin, reason: null };
}

/**
 * Validates and normalizes a raw OpenAI-compatible base or chat completions endpoint URL.
 * Multiple custom API entries may share the same origin (e.g. comparing different models
 * served by the same Ollama, vLLM, or OpenRouter endpoint).
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, endpointUrl: string | null, origin: string | null, reason: string | null }}
 */
export function validateCustomApiEndpointUrl(raw) {
  const baseCheck = parseAndValidateCustomHttpUrl(raw);
  if (!baseCheck.ok) {
    return { ok: false, endpointUrl: null, origin: null, reason: baseCheck.reason };
  }

  let endpointUrl;
  try {
    endpointUrl = resolveChatCompletionsUrl(baseCheck.parsed.toString());
  } catch {
    return { ok: false, endpointUrl: null, origin: null, reason: 'invalid_url' };
  }

  const { origin } = baseCheck.parsed;
  if (new URL(endpointUrl).origin !== origin) {
    return { ok: false, endpointUrl: null, origin: null, reason: 'invalid_url' };
  }

  return { ok: true, endpointUrl, origin, reason: null };
}

/**
 * Pure transformer from a stored custom provider record to a frozen registry descriptor.
 *
 * @param {object} record
 * @param {{ extensionOrigin?: string | null }} [options]
 */
export function toCustomProviderDescriptor(record, { extensionOrigin = null } = {}) {
  if (!record || typeof record !== 'object') {
    throw new Error('Custom provider record must be an object');
  }
  if ('apiKey' in record) {
    throw new Error('Custom provider record must never contain raw apiKey');
  }

  if (record.kind === 'api') {
    const extOrigin = resolveExtensionOrigin(extensionOrigin);
    const endpointUrl = resolveChatCompletionsUrl(record.endpointUrl);
    const apiOrigin = new URL(endpointUrl).origin;
    const matchPattern = `${apiOrigin}/*`;
    const panelUrl = `${extOrigin}/${CUSTOM_API_PANEL_PATH}?providerId=${encodeURIComponent(record.id)}`;

    return Object.freeze({
      id: record.id,
      name: typeof record.name === 'string' ? record.name.trim() : '',
      url: panelUrl,
      topLevelUrl: null,
      icon: CUSTOM_PROVIDER_ICON,
      iconDark: CUSTOM_PROVIDER_ICON_DARK,
      enabled: true,
      access: 'custom',
      customKind: 'api',
      frameOrigins: Object.freeze([extOrigin]),
      allowedHosts: Object.freeze([]),
      permissionOrigins: Object.freeze([matchPattern]),
      contentScript: null,
      frameRule: null,
      apiOriginRule: Object.freeze({
        id: record.frameRuleId,
        urlFilter: `|${apiOrigin}/`
      }),
      apiConfig: Object.freeze({
        endpointUrl,
        apiOrigin,
        model: typeof record.model === 'string' ? record.model.trim() : '',
        hasApiKey: Boolean(record.hasApiKey)
      }),
      tempChat: null,
      capabilities: CUSTOM_API_CAPABILITIES
    });
  }

  const parsed = new URL(record.url);
  parsed.hash = '';
  const normalizedUrl = parsed.toString();
  const { origin } = parsed;
  const matchPattern = `${origin}/*`;

  return Object.freeze({
    id: record.id,
    name: typeof record.name === 'string' ? record.name.trim() : '',
    url: normalizedUrl,
    topLevelUrl: normalizedUrl,
    icon: CUSTOM_PROVIDER_ICON,
    iconDark: CUSTOM_PROVIDER_ICON_DARK,
    enabled: true,
    access: 'custom',
    frameOrigins: Object.freeze([origin]),
    allowedHosts: Object.freeze([]),
    permissionOrigins: Object.freeze([matchPattern]),
    contentScript: Object.freeze({
      matches: Object.freeze([matchPattern]),
      js: Object.freeze([CUSTOM_PROVIDER_DRIVER_SCRIPT])
    }),
    frameRule: Object.freeze({
      id: record.frameRuleId,
      urlFilter: `|${origin}/`
    }),
    tempChat: null,
    capabilities: CUSTOM_CAPABILITIES
  });
}

function validateStoredRecord(record, { seenIds, seenRuleIds, seenOrigins }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { ok: false, reason: 'Record must be a non-null plain object' };
  }
  if ('apiKey' in record) {
    return { ok: false, reason: 'Record must not contain raw apiKey' };
  }
  if (record.kind !== undefined && record.kind !== 'web' && record.kind !== 'api') {
    return { ok: false, reason: `Unsupported custom provider kind: "${String(record.kind)}"` };
  }

  if (!isCustomProviderId(record.id)) {
    return { ok: false, reason: `Invalid custom provider id: "${String(record.id)}"` };
  }
  if (seenIds.has(record.id)) {
    return { ok: false, reason: `Duplicate custom provider id: "${record.id}"` };
  }

  if (typeof record.name !== 'string') {
    return { ok: false, reason: `Provider "${record.id}": name must be a string` };
  }
  const trimmedName = record.name.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    return {
      ok: false,
      reason: `Provider "${record.id}": trimmed name must be 1..${MAX_CUSTOM_PROVIDER_NAME_LENGTH} characters`
    };
  }

  if (
    !Number.isInteger(record.frameRuleId) ||
    record.frameRuleId < CUSTOM_FRAME_RULE_ID_MIN ||
    record.frameRuleId > CUSTOM_FRAME_RULE_ID_MAX
  ) {
    return {
      ok: false,
      reason: `Provider "${record.id}": frameRuleId must be in ${CUSTOM_FRAME_RULE_ID_MIN}..${CUSTOM_FRAME_RULE_ID_MAX}`
    };
  }
  if (seenRuleIds.has(record.frameRuleId)) {
    return { ok: false, reason: `Duplicate custom frameRuleId: ${record.frameRuleId}` };
  }

  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
    return { ok: false, reason: `Provider "${record.id}": createdAt must be a finite number` };
  }

  if (record.kind === 'api') {
    const endpointCheck = validateCustomApiEndpointUrl(record.endpointUrl);
    if (!endpointCheck.ok) {
      return {
        ok: false,
        reason: `Provider "${record.id}": invalid endpointUrl (${endpointCheck.reason})`
      };
    }

    if (typeof record.model !== 'string') {
      return { ok: false, reason: `Provider "${record.id}": model must be a string` };
    }
    const trimmedModel = record.model.trim();
    if (trimmedModel.length === 0 || trimmedModel.length > MAX_CUSTOM_API_MODEL_LENGTH) {
      return {
        ok: false,
        reason: `Provider "${record.id}": trimmed model must be 1..${MAX_CUSTOM_API_MODEL_LENGTH} characters`
      };
    }

    if (record.hasApiKey !== undefined && typeof record.hasApiKey !== 'boolean') {
      return { ok: false, reason: `Provider "${record.id}": hasApiKey must be a boolean` };
    }

    const normalizedApiRecord = {
      id: record.id,
      kind: 'api',
      name: trimmedName,
      endpointUrl: endpointCheck.endpointUrl,
      model: trimmedModel,
      hasApiKey: Boolean(record.hasApiKey),
      frameRuleId: record.frameRuleId,
      createdAt: record.createdAt
    };

    const descriptor = toCustomProviderDescriptor(normalizedApiRecord);
    const descriptorErrors = validateProviderDescriptor(descriptor);
    if (descriptorErrors.length > 0) {
      return { ok: false, reason: descriptorErrors.join('; ') };
    }

    seenIds.add(normalizedApiRecord.id);
    seenRuleIds.add(normalizedApiRecord.frameRuleId);

    return { ok: true, record: normalizedApiRecord, descriptor };
  }

  const urlCheck = validateCustomProviderUrl(record.url, { existingCustomOrigins: seenOrigins });
  if (!urlCheck.ok) {
    return { ok: false, reason: `Provider "${record.id}": invalid URL (${urlCheck.reason})` };
  }

  const normalizedRecord = {
    id: record.id,
    name: trimmedName,
    url: urlCheck.url,
    frameRuleId: record.frameRuleId,
    createdAt: record.createdAt
  };

  const descriptor = toCustomProviderDescriptor(normalizedRecord);
  const descriptorErrors = validateProviderDescriptor(descriptor);
  if (descriptorErrors.length > 0) {
    return { ok: false, reason: descriptorErrors.join('; ') };
  }

  seenIds.add(normalizedRecord.id);
  seenRuleIds.add(normalizedRecord.frameRuleId);
  seenOrigins.add(urlCheck.origin);

  return { ok: true, record: normalizedRecord, descriptor };
}

function parseValidCustomProvidersArray(rawList, { warnOnInvalid = true } = {}) {
  if (rawList === undefined || rawList === null) {
    return [];
  }

  if (!Array.isArray(rawList)) {
    if (warnOnInvalid) {
      console.warn('[CustomProviders] Stored customProviders value is not an array; ignoring');
    }
    return [];
  }

  const seenIds = new Set();
  const seenRuleIds = new Set();
  const seenOrigins = new Set();
  const validEntries = [];

  for (const item of rawList) {
    const result = validateStoredRecord(item, { seenIds, seenRuleIds, seenOrigins });
    if (!result.ok) {
      if (warnOnInvalid) {
        console.warn(`[CustomProviders] Dropping invalid custom provider record: ${result.reason}`);
      }
      continue;
    }
    validEntries.push(result);
  }

  return validEntries;
}

/**
 * Hydrates custom providers from `chrome.storage.local` into the provider registry.
 * Never throws; returns `{ ok: false }` if reading storage itself failed (leaving
 * any currently registered custom descriptors untouched).
 *
 * @returns {Promise<{ ok: boolean }>}
 */
export async function loadCustomProviders() {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local?.get) {
    console.warn('[CustomProviders] chrome.storage.local is unavailable; skipping hydration');
    return { ok: false };
  }

  let stored;
  try {
    stored = await chrome.storage.local.get({ [CUSTOM_PROVIDERS_STORAGE_KEY]: [] });
  } catch (error) {
    console.warn('[CustomProviders] Failed to read customProviders from storage:', error);
    return { ok: false };
  }

  try {
    const rawList = stored ? stored[CUSTOM_PROVIDERS_STORAGE_KEY] : [];
    const validEntries = parseValidCustomProvidersArray(rawList, { warnOnInvalid: true });
    setCustomProviderDescriptors(validEntries.map((entry) => entry.descriptor));
    return { ok: true };
  } catch (error) {
    console.warn('[CustomProviders] Failed to hydrate custom providers:', error);
    return { ok: false };
  }
}

function createValidationError(message, reason) {
  const error = new Error(message);
  error.reason = reason;
  return error;
}

/**
 * Validates and persists a custom provider record in `chrome.storage.local` and
 * updates the in-memory custom provider registry. Does not touch permissions or DNR.
 *
 * @param {object} record
 * @returns {Promise<object>}
 */
export async function addCustomProvider(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createValidationError('Custom provider record must be an object', 'invalid_record');
  }
  if ('apiKey' in record) {
    throw createValidationError(
      'Raw apiKey must not be passed to addCustomProvider; use saveCustomApiKey instead',
      'forbidden_secret_field'
    );
  }
  if (record.kind !== undefined && record.kind !== 'web' && record.kind !== 'api') {
    throw createValidationError(
      `Unsupported custom provider kind: "${String(record.kind)}"`,
      'invalid_kind'
    );
  }

  if (typeof record.name !== 'string') {
    throw createValidationError('Custom provider name must be a string', 'invalid_name');
  }
  const trimmedName = record.name.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    throw createValidationError(
      `Custom provider name must be 1..${MAX_CUSTOM_PROVIDER_NAME_LENGTH} characters`,
      'invalid_name'
    );
  }

  const stored = await chrome.storage.local.get({ [CUSTOM_PROVIDERS_STORAGE_KEY]: [] });
  const existingEntries = parseValidCustomProvidersArray(
    stored ? stored[CUSTOM_PROVIDERS_STORAGE_KEY] : [],
    { warnOnInvalid: false }
  );

  const existingIds = new Set(existingEntries.map(({ record: item }) => item.id));
  const existingRuleIds = new Set(existingEntries.map(({ record: item }) => item.frameRuleId));
  const existingOrigins = new Set([
    ...existingEntries
      .filter(({ descriptor }) => descriptor.customKind !== 'api')
      .flatMap(({ descriptor }) => descriptor.frameOrigins),
    ...listProviderDescriptors()
      .filter((descriptor) => descriptor.access === 'custom' && descriptor.customKind !== 'api')
      .flatMap((descriptor) => descriptor.frameOrigins)
  ]);

  let id = record.id;
  if (id === undefined) {
    do {
      id = generateCustomProviderId();
    } while (existingIds.has(id));
  } else if (!isCustomProviderId(id)) {
    throw createValidationError(
      `Custom provider id must match ${CUSTOM_PROVIDER_ID_PATTERN}`,
      'invalid_id'
    );
  } else if (existingIds.has(id)) {
    throw createValidationError(`Duplicate custom provider id: "${id}"`, 'duplicate_id');
  }

  const isApiKind = record.kind === 'api';
  let urlCheck = null;
  let endpointCheck = null;
  let trimmedModel = '';

  if (isApiKind) {
    endpointCheck = validateCustomApiEndpointUrl(record.endpointUrl);
    if (!endpointCheck.ok) {
      throw createValidationError(
        `Invalid custom API endpoint URL: ${endpointCheck.reason}`,
        endpointCheck.reason
      );
    }
    if (typeof record.model !== 'string') {
      throw createValidationError('Custom API provider model must be a string', 'invalid_model');
    }
    trimmedModel = record.model.trim();
    if (trimmedModel.length === 0 || trimmedModel.length > MAX_CUSTOM_API_MODEL_LENGTH) {
      throw createValidationError(
        `Custom API provider model must be 1..${MAX_CUSTOM_API_MODEL_LENGTH} characters`,
        'invalid_model'
      );
    }
    if (record.hasApiKey !== undefined && typeof record.hasApiKey !== 'boolean') {
      throw createValidationError(
        'Custom API provider hasApiKey must be a boolean',
        'invalid_has_api_key'
      );
    }
  } else {
    urlCheck = validateCustomProviderUrl(record.url, { existingCustomOrigins: existingOrigins });
    if (!urlCheck.ok) {
      throw createValidationError(
        `Invalid custom provider URL: ${urlCheck.reason}`,
        urlCheck.reason
      );
    }
  }

  let frameRuleId = record.frameRuleId;
  if (frameRuleId === undefined) {
    frameRuleId = allocateCustomFrameRuleId(existingEntries.map(({ record: item }) => item));
  } else if (
    !Number.isInteger(frameRuleId) ||
    frameRuleId < CUSTOM_FRAME_RULE_ID_MIN ||
    frameRuleId > CUSTOM_FRAME_RULE_ID_MAX
  ) {
    throw createValidationError(
      `Custom provider frameRuleId must be in ${CUSTOM_FRAME_RULE_ID_MIN}..${CUSTOM_FRAME_RULE_ID_MAX}`,
      'invalid_frame_rule_id'
    );
  } else if (existingRuleIds.has(frameRuleId)) {
    throw createValidationError(
      `Duplicate custom provider frameRuleId: ${frameRuleId}`,
      'duplicate_frame_rule_id'
    );
  }

  const createdAt = record.createdAt === undefined ? Date.now() : record.createdAt;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    throw createValidationError(
      'Custom provider createdAt must be a finite number',
      'invalid_created_at'
    );
  }

  const nextRecord = isApiKind
    ? {
        id,
        kind: 'api',
        name: trimmedName,
        endpointUrl: endpointCheck.endpointUrl,
        model: trimmedModel,
        hasApiKey: Boolean(record.hasApiKey),
        frameRuleId,
        createdAt
      }
    : {
        id,
        name: trimmedName,
        url: urlCheck.url,
        frameRuleId,
        createdAt
      };
  const nextDescriptor = toCustomProviderDescriptor(nextRecord);
  const errors = validateProviderDescriptor(nextDescriptor);
  if (errors.length > 0) {
    throw createValidationError(errors.join('; '), 'invalid_descriptor');
  }

  const nextRecords = [...existingEntries.map(({ record: item }) => item), nextRecord];
  const nextDescriptors = [...existingEntries.map(({ descriptor }) => descriptor), nextDescriptor];

  await chrome.storage.local.set({ [CUSTOM_PROVIDERS_STORAGE_KEY]: nextRecords });
  setCustomProviderDescriptors(nextDescriptors);

  return { ...nextRecord };
}

/**
 * Updates an existing custom provider record in place inside `chrome.storage.local`
 * and updates the in-memory custom provider registry, preserving `id`, `frameRuleId`,
 * `createdAt`, and connection kind (`web` vs `api`). Does not touch permissions or DNR.
 *
 * @param {string} id
 * @param {object} patch
 * @returns {Promise<object>}
 */
export async function updateCustomProvider(id, patch) {
  if (!isCustomProviderId(id)) {
    throw createValidationError(
      `Custom provider id must match ${CUSTOM_PROVIDER_ID_PATTERN}`,
      'invalid_id'
    );
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw createValidationError('Custom provider update must be an object', 'invalid_record');
  }
  if ('apiKey' in patch) {
    throw createValidationError(
      'Raw apiKey must not be passed to updateCustomProvider; use saveCustomApiKey instead',
      'forbidden_secret_field'
    );
  }

  const stored = await chrome.storage.local.get({ [CUSTOM_PROVIDERS_STORAGE_KEY]: [] });
  const existingEntries = parseValidCustomProvidersArray(
    stored ? stored[CUSTOM_PROVIDERS_STORAGE_KEY] : [],
    { warnOnInvalid: false }
  );
  const targetIndex = existingEntries.findIndex(({ record }) => record.id === id);
  if (targetIndex === -1) {
    throw createValidationError(`Custom provider not found: "${id}"`, 'not_found');
  }

  const existingRecord = existingEntries[targetIndex].record;
  const isApiKind = existingRecord.kind === 'api';
  if (
    patch.kind !== undefined &&
    patch.kind !== 'web' &&
    patch.kind !== 'api'
  ) {
    throw createValidationError(
      `Unsupported custom provider kind: "${String(patch.kind)}"`,
      'invalid_kind'
    );
  }
  if (patch.kind !== undefined && (patch.kind === 'api') !== isApiKind) {
    throw createValidationError(
      `Cannot change custom provider kind for "${id}"`,
      'kind_mismatch'
    );
  }

  const rawName = patch.name !== undefined ? patch.name : existingRecord.name;
  if (typeof rawName !== 'string') {
    throw createValidationError('Custom provider name must be a string', 'invalid_name');
  }
  const trimmedName = rawName.trim();
  if (trimmedName.length === 0 || trimmedName.length > MAX_CUSTOM_PROVIDER_NAME_LENGTH) {
    throw createValidationError(
      `Custom provider name must be 1..${MAX_CUSTOM_PROVIDER_NAME_LENGTH} characters`,
      'invalid_name'
    );
  }

  let updatedRecord;
  if (isApiKind) {
    const rawEndpoint =
      patch.endpointUrl !== undefined ? patch.endpointUrl : existingRecord.endpointUrl;
    const endpointCheck = validateCustomApiEndpointUrl(rawEndpoint);
    if (!endpointCheck.ok) {
      throw createValidationError(
        `Invalid custom API endpoint URL: ${endpointCheck.reason}`,
        endpointCheck.reason
      );
    }

    const rawModel = patch.model !== undefined ? patch.model : existingRecord.model;
    if (typeof rawModel !== 'string') {
      throw createValidationError('Custom API provider model must be a string', 'invalid_model');
    }
    const trimmedModel = rawModel.trim();
    if (trimmedModel.length === 0 || trimmedModel.length > MAX_CUSTOM_API_MODEL_LENGTH) {
      throw createValidationError(
        `Custom API provider model must be 1..${MAX_CUSTOM_API_MODEL_LENGTH} characters`,
        'invalid_model'
      );
    }

    const nextHasApiKey =
      patch.hasApiKey !== undefined ? patch.hasApiKey : existingRecord.hasApiKey;
    if (nextHasApiKey !== undefined && typeof nextHasApiKey !== 'boolean') {
      throw createValidationError(
        'Custom API provider hasApiKey must be a boolean',
        'invalid_has_api_key'
      );
    }

    updatedRecord = {
      id: existingRecord.id,
      kind: 'api',
      name: trimmedName,
      endpointUrl: endpointCheck.endpointUrl,
      model: trimmedModel,
      hasApiKey: Boolean(nextHasApiKey),
      frameRuleId: existingRecord.frameRuleId,
      createdAt: existingRecord.createdAt
    };
  } else {
    const otherOrigins = new Set([
      ...existingEntries
        .filter(({ record: item, descriptor }) => item.id !== id && descriptor.customKind !== 'api')
        .flatMap(({ descriptor }) => descriptor.frameOrigins),
      ...listProviderDescriptors()
        .filter(
          (descriptor) =>
            descriptor.access === 'custom' &&
            descriptor.customKind !== 'api' &&
            descriptor.id !== id
        )
        .flatMap((descriptor) => descriptor.frameOrigins)
    ]);

    const rawUrl = patch.url !== undefined ? patch.url : existingRecord.url;
    const urlCheck = validateCustomProviderUrl(rawUrl, {
      ignoreProviderId: id,
      existingCustomOrigins: otherOrigins
    });
    if (!urlCheck.ok) {
      throw createValidationError(
        `Invalid custom provider URL: ${urlCheck.reason}`,
        urlCheck.reason
      );
    }

    updatedRecord = {
      id: existingRecord.id,
      name: trimmedName,
      url: urlCheck.url,
      frameRuleId: existingRecord.frameRuleId,
      createdAt: existingRecord.createdAt
    };
  }

  const updatedDescriptor = toCustomProviderDescriptor(updatedRecord);
  const errors = validateProviderDescriptor(updatedDescriptor);
  if (errors.length > 0) {
    throw createValidationError(errors.join('; '), 'invalid_descriptor');
  }

  const nextRecords = existingEntries.map(({ record: item }, index) =>
    index === targetIndex ? updatedRecord : item
  );
  const nextDescriptors = existingEntries.map(({ descriptor }, index) =>
    index === targetIndex ? updatedDescriptor : descriptor
  );

  await chrome.storage.local.set({ [CUSTOM_PROVIDERS_STORAGE_KEY]: nextRecords });
  setCustomProviderDescriptors(nextDescriptors);

  return { ...updatedRecord };
}

/**
 * Removes a custom provider record from `chrome.storage.local` and updates the
 * in-memory custom provider registry. Does not touch permissions, DNR, or sync lists.
 *
 * @param {string} id
 * @returns {Promise<boolean>} Whether a matching custom provider was removed.
 */
export async function removeCustomProvider(id) {
  if (!isCustomProviderId(id)) {
    return false;
  }

  const stored = await chrome.storage.local.get({ [CUSTOM_PROVIDERS_STORAGE_KEY]: [] });
  const rawList = Array.isArray(stored?.[CUSTOM_PROVIDERS_STORAGE_KEY])
    ? stored[CUSTOM_PROVIDERS_STORAGE_KEY]
    : [];
  const filteredRaw = rawList.filter((item) => item?.id !== id);
  const removedFromStorage = filteredRaw.length !== rawList.length;
  const existedInRegistry = listProviderDescriptors().some(
    (descriptor) => descriptor.access === 'custom' && descriptor.id === id
  );

  const remainingEntries = parseValidCustomProvidersArray(filteredRaw, { warnOnInvalid: false });
  if (removedFromStorage) {
    await chrome.storage.local.set({
      [CUSTOM_PROVIDERS_STORAGE_KEY]: remainingEntries.map(({ record }) => record)
    });
  }
  setCustomProviderDescriptors(remainingEntries.map(({ descriptor }) => descriptor));

  return removedFromStorage || existedInRegistry;
}

/**
 * Subscribes to `chrome.storage.onChanged` for `customProviders` in the `local`
 * storage area, re-hydrating the registry before invoking `onChange`.
 *
 * @param {(result: { ok: boolean }) => void} [onChange]
 * @returns {() => void} Unsubscribe callback.
 */
export function subscribeCustomProvidersChanged(onChange) {
  if (typeof chrome === 'undefined' || !chrome?.storage?.onChanged?.addListener) {
    return () => {};
  }

  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes || !(CUSTOM_PROVIDERS_STORAGE_KEY in changes)) {
      return;
    }

    loadCustomProviders()
      .then((result) => {
        onChange?.(result);
      })
      .catch((error) => {
        console.warn('[CustomProviders] Listener re-hydration failed:', error);
      });
  };

  chrome.storage.onChanged.addListener(listener);
  return () => {
    chrome.storage?.onChanged?.removeListener?.(listener);
  };
}
