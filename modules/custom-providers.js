import {
  BUILTIN_PROVIDER_DESCRIPTORS,
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  CUSTOM_PROVIDER_ID_PATTERN,
  listProviderDescriptors,
  setCustomProviderDescriptors,
  validateProviderDescriptor
} from './provider-registry.js';

export {
  CUSTOM_FRAME_RULE_ID_MAX,
  CUSTOM_FRAME_RULE_ID_MIN,
  CUSTOM_PROVIDER_ID_PATTERN
};

export const CUSTOM_PROVIDERS_STORAGE_KEY = 'customProviders';
export const MAX_CUSTOM_PROVIDER_NAME_LENGTH = 40;
export const CUSTOM_PROVIDER_ICON = '/icons/providers/custom.svg';
export const CUSTOM_PROVIDER_ICON_DARK = '/icons/providers/dark/custom.svg';
export const CUSTOM_PROVIDER_DRIVER_SCRIPT = 'content-scripts/custom-provider-driver.js';

const CUSTOM_CAPABILITIES = Object.freeze({
  imageUpload: false,
  inPageNewChat: false,
  snapshotStitch: false
});

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
    if (descriptor.access !== 'custom' || descriptor.id === ignoreProviderId) {
      continue;
    }
    for (const frameOrigin of descriptor.frameOrigins) {
      origins.add(frameOrigin);
    }
  }
  return origins;
}

/**
 * Validates and normalizes a raw custom provider URL.
 *
 * @param {unknown} raw
 * @param {{ ignoreProviderId?: string | null, existingCustomOrigins?: Set<string> | string[] | null }} [options]
 * @returns {{ ok: boolean, url: string | null, origin: string | null, reason: string | null }}
 */
export function validateCustomProviderUrl(raw, options = {}) {
  if (typeof raw !== 'string') {
    return { ok: false, url: null, origin: null, reason: 'invalid_url' };
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, url: null, origin: null, reason: 'invalid_url' };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    const authority = trimmed.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0];
    if (authority.includes('@')) {
      return { ok: false, url: null, origin: null, reason: 'credentials_not_allowed' };
    }
    if (
      authority.length === 0 ||
      authority === '[]' ||
      authority.startsWith(':') ||
      authority.startsWith('[]')
    ) {
      return { ok: false, url: null, origin: null, reason: 'empty_host' };
    }
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, url: null, origin: null, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, url: null, origin: null, reason: 'unsupported_scheme' };
  }

  if (!parsed.hostname) {
    return { ok: false, url: null, origin: null, reason: 'empty_host' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, url: null, origin: null, reason: 'credentials_not_allowed' };
  }

  if (!isValidHttpHostname(parsed.hostname)) {
    return { ok: false, url: null, origin: null, reason: 'invalid_url' };
  }

  if (parsed.protocol === 'http:' && !isAllowedHttpHost(parsed.hostname)) {
    return { ok: false, url: null, origin: null, reason: 'insecure_http' };
  }

  parsed.hash = '';
  const normalizedUrl = parsed.toString();
  const { origin } = parsed;

  if (collectReservedNonCustomOrigins().has(origin)) {
    return { ok: false, url: null, origin: null, reason: 'builtin_origin' };
  }

  if (collectExistingCustomOrigins(options).has(origin)) {
    return { ok: false, url: null, origin: null, reason: 'duplicate_custom_origin' };
  }

  return { ok: true, url: normalizedUrl, origin, reason: null };
}

/**
 * Pure transformer from a stored custom provider record to a frozen registry descriptor.
 *
 * @param {{ id: string, name: string, url: string, frameRuleId: number }} record
 */
export function toCustomProviderDescriptor(record) {
  if (!record || typeof record !== 'object') {
    throw new Error('Custom provider record must be an object');
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
 * @param {{ id?: string, name: string, url: string, frameRuleId?: number, createdAt?: number }} record
 * @returns {Promise<{ id: string, name: string, url: string, frameRuleId: number, createdAt: number }>}
 */
export async function addCustomProvider(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw createValidationError('Custom provider record must be an object', 'invalid_record');
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
    ...existingEntries.flatMap(({ descriptor }) => descriptor.frameOrigins),
    ...listProviderDescriptors()
      .filter((descriptor) => descriptor.access === 'custom')
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

  const urlCheck = validateCustomProviderUrl(record.url, { existingCustomOrigins: existingOrigins });
  if (!urlCheck.ok) {
    throw createValidationError(
      `Invalid custom provider URL: ${urlCheck.reason}`,
      urlCheck.reason
    );
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

  const nextRecord = {
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
