import { isCustomProviderId, loadCustomProviders } from './custom-providers.js';
import {
  hasOptionalProviderCompanionCookiePermission,
  hasOptionalProviderPermission,
  supportsScopedFrameRules
} from './optional-provider-access.js';
import { getProviderDescriptor, listProviderDescriptors } from './provider-registry.js';

export const EMBEDDED_FRAME_COOKIE_SYNC_ACTION = 'syncEmbeddedFrameCookies';
export const CHATGLM_PROVIDER_ID = 'chatglm';
export const CHATGLM_ORIGIN = 'https://chatglm.cn';
export const CHATGLM_HOSTNAME = 'chatglm.cn';
export const MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY = 'mirroredEmbeddedFrameCookies';
export const PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY = 'pendingEmbeddedFrameCookieCleanups';

const EXPIRY_TOLERANCE_SECONDS = 2;

export function computeCookieValueDigest(value) {
  const text = typeof value === 'string' ? value : '';
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193);
    djb = (Math.imul(djb, 33) ^ code) | 0;
  }
  return `${(fnv >>> 0).toString(16).padStart(8, '0')}:${(djb >>> 0).toString(16).padStart(8, '0')}`;
}

export function getExtensionPartitionKey() {
  if (
    typeof chrome === 'undefined' ||
    typeof chrome?.runtime?.id !== 'string' ||
    !/^[a-z0-9_-]+$/i.test(chrome.runtime.id)
  ) {
    return null;
  }
  return { topLevelSite: `chrome-extension://${chrome.runtime.id}` };
}

export function getEmbeddedFrameCookieSyncOrigin(providerId) {
  if (providerId === CHATGLM_PROVIDER_ID) {
    return CHATGLM_ORIGIN;
  }
  if (!isCustomProviderId(providerId)) {
    return null;
  }
  const descriptor = getProviderDescriptor(providerId);
  if (
    descriptor?.access === 'custom' &&
    descriptor.customKind !== 'api' &&
    typeof descriptor.frameOrigins?.[0] === 'string' &&
    descriptor.frameOrigins[0].startsWith('https://')
  ) {
    return descriptor.frameOrigins[0];
  }
  return null;
}

export function requiresEmbeddedFrameCookieSync(providerId) {
  return getEmbeddedFrameCookieSyncOrigin(providerId) !== null;
}

export function hasPendingEmbeddedCookieCleanupForProvider(providerId, syncResult) {
  if (!syncResult || typeof syncResult !== 'object') {
    return false;
  }
  const origin = getEmbeddedFrameCookieSyncOrigin(providerId);
  if (
    origin &&
    syncResult.pendingCleanupsByOrigin &&
    typeof syncResult.pendingCleanupsByOrigin === 'object'
  ) {
    return Number(syncResult.pendingCleanupsByOrigin[origin]) > 0;
  }
  return Boolean(
    syncResult.hasPendingCleanup ||
    (syncResult.ok === false && Number(syncResult.pendingCleanupCount) > 0)
  );
}

export function cookieMatchesHostname(cookieDomain, hostOnly, hostname) {
  if (
    typeof cookieDomain !== 'string' ||
    cookieDomain.length === 0 ||
    typeof hostname !== 'string' ||
    hostname.length === 0
  ) {
    return false;
  }
  const targetHost = hostname.toLowerCase();
  if (hostOnly) {
    return cookieDomain.toLowerCase() === targetHost;
  }
  const cleanDomain = cookieDomain.replace(/^\.+/, '').toLowerCase();
  if (!cleanDomain) {
    return false;
  }
  return targetHost === cleanDomain || targetHost.endsWith(`.${cleanDomain}`);
}

/**
 * Strictly one-way filter for `chrome.cookies.onChanged`: only unpartitioned
 * top-level non-HttpOnly cookie changes may schedule reconciliation into the
 * extension's CHIPS partition. Partitioned panel events (including self-writes
 * and Chrome evictions/expirations) are always ignored.
 *
 * @param {chrome.cookies.CookieChangeInfo | null | undefined} changeInfo
 * @returns {boolean}
 */
export function isEmbeddedFrameTopLevelCookieChange(changeInfo) {
  const cookie = changeInfo?.cookie;
  if (!cookie || typeof cookie.name !== 'string' || cookie.name.length === 0) {
    return false;
  }
  if (cookie.partitionKey || cookie.httpOnly) {
    return false;
  }
  if (changeInfo.removed && changeInfo.cause === 'overwrite') {
    return false;
  }
  return true;
}

function isSamePartitionKey(cookiePartitionKey, expectedPartitionKey) {
  return Boolean(
    cookiePartitionKey &&
    expectedPartitionKey &&
    cookiePartitionKey.topLevelSite === expectedPartitionKey.topLevelSite
  );
}

function cookieIdentityTuple(cookie, fallbackHost) {
  const storeId = typeof cookie?.storeId === 'string' ? cookie.storeId : '';
  const hostOnly = cookie?.hostOnly ? 1 : 0;
  const domain = typeof cookie?.domain === 'string' && cookie.domain.length > 0
    ? cookie.domain.toLowerCase()
    : fallbackHost.toLowerCase();
  const path = typeof cookie?.path === 'string' && cookie.path.length > 0 ? cookie.path : '/';
  const name = typeof cookie?.name === 'string' ? cookie.name : '';
  return [storeId, hostOnly, domain, path, name];
}

function cookieIdentityKey(cookie, fallbackHost) {
  return JSON.stringify(cookieIdentityTuple(cookie, fallbackHost));
}

function serializeMirroredCookieRecord(cookie, fallbackHost, valueDigest) {
  return JSON.stringify([...cookieIdentityTuple(cookie, fallbackHost), valueDigest]);
}

function parseCookieIdentityKey(serializedKey) {
  if (typeof serializedKey !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(serializedKey);
    if (!Array.isArray(parsed) || (parsed.length !== 5 && parsed.length !== 6)) {
      return null;
    }
    const [storeId, hostOnly, domain, path, name, valueDigest] = parsed;
    if (typeof name !== 'string' || name.length === 0) {
      return null;
    }
    const normalizedStoreId = typeof storeId === 'string' ? storeId : '';
    const normalizedHostOnly = hostOnly === 1;
    const normalizedDomain = typeof domain === 'string' ? domain : '';
    const normalizedPath = typeof path === 'string' && path.length > 0 ? path : '/';
    return {
      storeId: normalizedStoreId,
      hostOnly: normalizedHostOnly,
      domain: normalizedDomain,
      path: normalizedPath,
      name,
      valueDigest: typeof valueDigest === 'string' && valueDigest.length > 0 ? valueDigest : null,
      identityKey: JSON.stringify([
        normalizedStoreId,
        normalizedHostOnly ? 1 : 0,
        normalizedDomain,
        normalizedPath,
        name
      ])
    };
  } catch {
    return null;
  }
}

function isMirrorableUnpartitionedCookie(cookie) {
  return Boolean(
    cookie &&
    typeof cookie.name === 'string' &&
    cookie.name.length > 0 &&
    typeof cookie.value === 'string' &&
    !cookie.httpOnly &&
    !cookie.partitionKey &&
    (cookie.sameSite !== 'no_restriction' || !cookie.secure)
  );
}

function hasEquivalentExpiry(leftExpirationDate, rightExpirationDate) {
  const leftIsNumber = typeof leftExpirationDate === 'number';
  const rightIsNumber = typeof rightExpirationDate === 'number';
  if (leftIsNumber !== rightIsNumber) {
    return false;
  }
  if (!leftIsNumber) {
    return true;
  }
  return Math.abs(leftExpirationDate - rightExpirationDate) <= EXPIRY_TOLERANCE_SECONDS;
}

function isUpToDatePartitionedMirror(sourceCookie, candidateCookie) {
  return Boolean(
    candidateCookie &&
    candidateCookie.name === sourceCookie.name &&
    candidateCookie.value === sourceCookie.value &&
    (candidateCookie.path || '/') === (sourceCookie.path || '/') &&
    candidateCookie.secure === true &&
    candidateCookie.httpOnly === false &&
    candidateCookie.sameSite === 'no_restriction' &&
    hasEquivalentExpiry(sourceCookie.expirationDate, candidateCookie.expirationDate)
  );
}

async function hasOriginCookiePermission(origin) {
  if (typeof origin !== 'string' || !origin.startsWith('https://')) {
    return false;
  }
  if (!chrome?.permissions?.contains) {
    return false;
  }
  try {
    return Boolean(await chrome.permissions.contains({ origins: [`${origin}/*`] }));
  } catch {
    return false;
  }
}

async function queryHostCookiesStrict(hostname, partitionKey = null) {
  if (!chrome?.cookies?.getAll || !hostname) {
    return { ok: false, cookies: [] };
  }
  const partitionFilter = partitionKey ? { partitionKey } : {};
  let byUrl;
  let byDomain;
  try {
    [byUrl, byDomain] = await Promise.all([
      chrome.cookies.getAll({ url: `https://${hostname}/`, ...partitionFilter }),
      chrome.cookies.getAll({ domain: hostname, ...partitionFilter })
    ]);
  } catch {
    return { ok: false, cookies: [] };
  }

  const deduped = new Map();
  for (const cookie of [
    ...(Array.isArray(byUrl) ? byUrl : []),
    ...(Array.isArray(byDomain) ? byDomain : [])
  ]) {
    if (!cookie || typeof cookie.name !== 'string' || cookie.name.length === 0) {
      continue;
    }
    if (partitionKey) {
      if (!isSamePartitionKey(cookie.partitionKey, partitionKey)) {
        continue;
      }
    } else if (cookie.partitionKey) {
      continue;
    }
    if (!cookieMatchesHostname(cookie.domain || hostname, Boolean(cookie.hostOnly), hostname)) {
      continue;
    }
    deduped.set(cookieIdentityKey(cookie, hostname), cookie);
  }

  return { ok: true, cookies: [...deduped.values()] };
}

async function setPartitionedMirrorCookie(sourceCookie, hostname, partitionKey) {
  if (!chrome?.cookies?.set) {
    return null;
  }
  const path = sourceCookie.path || '/';
  const baseDetails = {
    url: `https://${hostname}${path}`,
    name: sourceCookie.name,
    value: sourceCookie.value,
    path,
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    partitionKey
  };
  if (typeof sourceCookie.expirationDate === 'number') {
    baseDetails.expirationDate = sourceCookie.expirationDate;
  }
  if (typeof sourceCookie.storeId === 'string' && sourceCookie.storeId.length > 0) {
    baseDetails.storeId = sourceCookie.storeId;
  }

  const preserveDomain = (
    !sourceCookie.hostOnly &&
    typeof sourceCookie.domain === 'string' &&
    sourceCookie.domain.length > 0 &&
    !/^\s*__Host-/i.test(sourceCookie.name)
  );

  if (preserveDomain) {
    try {
      const result = await chrome.cookies.set({
        ...baseDetails,
        domain: sourceCookie.domain
      });
      if (result) {
        return result;
      }
    } catch {
      // Fall back to a host-only partitioned cookie if superdomain write access is unavailable.
    }
  }

  try {
    return (await chrome.cookies.set(baseDetails)) || null;
  } catch (error) {
    console.warn(`[EmbeddedCookies] Failed to mirror cookie ${sourceCookie.name} on ${hostname}:`, error);
    return null;
  }
}

/**
 * Expires one exact CHIPS partitioned cookie via `chrome.cookies.set` instead
 * of `chrome.cookies.remove`.
 *
 * In Chromium, `chrome.cookies.remove({ url, name, partitionKey })` leaves
 * `partitioned_state_only` unset in `CookieDeletionInfo`, so `CookieMonster`
 * also visits the unpartitioned store and deletes matching top-level browser
 * cookies (as well as other same-name cookies whose path prefixes `url`).
 * Writing an exact-identity expired cookie (`expirationDate: 1`) scoped to the
 * extension's `partitionKey` only deletes that exact canonical CHIPS cookie.
 */
async function expirePartitionedCookieByKey(serializedKey, hostname, partitionKey) {
  if (!chrome?.cookies?.set || !chrome?.cookies?.getAll) {
    return false;
  }
  const parsed = parseCookieIdentityKey(serializedKey);
  if (!parsed) {
    return false;
  }
  const cleanHost = parsed.hostOnly
    ? (parsed.domain || hostname || '').replace(/^\.+/, '')
    : (hostname || parsed.domain.replace(/^\.+/, ''));
  if (!cleanHost) {
    return false;
  }
  const normalizedPath = parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`;
  const details = {
    url: `https://${cleanHost}${normalizedPath}`,
    name: parsed.name,
    value: '',
    path: normalizedPath,
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: 1,
    partitionKey
  };
  if (
    !parsed.hostOnly &&
    parsed.domain &&
    !/^\s*__Host-/i.test(parsed.name)
  ) {
    details.domain = parsed.domain;
  }
  if (parsed.storeId) {
    details.storeId = parsed.storeId;
  }
  try {
    await chrome.cookies.set(details);
  } catch {
    return false;
  }

  try {
    const verifyFilter = {
      url: `https://${cleanHost}${normalizedPath}`,
      name: parsed.name,
      partitionKey
    };
    if (parsed.storeId) {
      verifyFilter.storeId = parsed.storeId;
    }
    const remaining = await chrome.cookies.getAll(verifyFilter);
    const stillPresent = (Array.isArray(remaining) ? remaining : []).some(
      (cookie) =>
        isSamePartitionKey(cookie.partitionKey, partitionKey) &&
        cookieIdentityKey(cookie, cleanHost) === parsed.identityKey
    );
    return !stillPresent;
  } catch {
    return false;
  }
}

function normalizeOriginRecordMap(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const normalized = {};
  for (const [origin, keys] of Object.entries(raw)) {
    if (typeof origin === 'string' && Array.isArray(keys)) {
      const validKeys = [...new Set(keys.filter((key) => typeof key === 'string'))].sort();
      if (validKeys.length > 0) {
        normalized[origin] = validKeys;
      }
    }
  }
  return normalized;
}

async function loadCookieTrackingState() {
  if (!chrome?.storage?.local?.get) {
    return { mirrored: {}, pendingCleanups: {} };
  }
  try {
    const stored = await chrome.storage.local.get({
      [MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]: {},
      [PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]: {}
    });
    return {
      mirrored: normalizeOriginRecordMap(stored?.[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]),
      pendingCleanups: normalizeOriginRecordMap(
        stored?.[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY]
      )
    };
  } catch {
    return { mirrored: {}, pendingCleanups: {} };
  }
}

function isSameOriginRecordMap(left, right) {
  const leftOrigins = Object.keys(left).sort();
  const rightOrigins = Object.keys(right).sort();
  if (leftOrigins.length !== rightOrigins.length) {
    return false;
  }
  for (let i = 0; i < leftOrigins.length; i += 1) {
    const origin = leftOrigins[i];
    if (origin !== rightOrigins[i]) {
      return false;
    }
    const leftKeys = left[origin] || [];
    const rightKeys = right[origin] || [];
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (let j = 0; j < leftKeys.length; j += 1) {
      if (leftKeys[j] !== rightKeys[j]) {
        return false;
      }
    }
  }
  return true;
}

async function saveCookieTrackingStateIfChanged(previousState, nextState) {
  if (!chrome?.storage?.local?.set) {
    return;
  }
  const updates = {};
  if (!isSameOriginRecordMap(previousState.mirrored, nextState.mirrored)) {
    updates[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY] = nextState.mirrored;
  }
  if (!isSameOriginRecordMap(previousState.pendingCleanups, nextState.pendingCleanups)) {
    updates[PENDING_EMBEDDED_COOKIE_CLEANUPS_STORAGE_KEY] = nextState.pendingCleanups;
  }
  if (Object.keys(updates).length === 0) {
    return;
  }
  try {
    await chrome.storage.local.set(updates);
  } catch (error) {
    console.warn('[EmbeddedCookies] Failed to persist mirrored cookie tracking state:', error);
  }
}

async function collectActiveEmbeddedHttpsOrigins(enabledProviderIds, { includeCustom = true } = {}) {
  const enabledSet = new Set(Array.isArray(enabledProviderIds) ? enabledProviderIds : []);
  const activeOrigins = new Map();

  if (
    enabledSet.has(CHATGLM_PROVIDER_ID) &&
    await hasOptionalProviderPermission(CHATGLM_PROVIDER_ID)
  ) {
    activeOrigins.set(CHATGLM_ORIGIN, {
      hostname: CHATGLM_HOSTNAME,
      hasNonSecureCookieAccess: await hasOptionalProviderCompanionCookiePermission(
        CHATGLM_PROVIDER_ID
      )
    });
  }

  if (includeCustom && supportsScopedFrameRules()) {
    for (const descriptor of listProviderDescriptors()) {
      if (
        descriptor.access !== 'custom' ||
        descriptor.customKind === 'api' ||
        !enabledSet.has(descriptor.id)
      ) {
        continue;
      }
      const origin = descriptor.frameOrigins?.[0];
      if (typeof origin !== 'string' || !origin.startsWith('https://')) {
        continue;
      }
      let hostname = '';
      try {
        hostname = new URL(origin).hostname;
      } catch {
        continue;
      }
      if (!hostname) {
        continue;
      }
      if (await hasOptionalProviderPermission(descriptor.id)) {
        activeOrigins.set(origin, {
          hostname,
          hasNonSecureCookieAccess: await hasOptionalProviderCompanionCookiePermission(
            descriptor.id
          )
        });
      }
    }
  }

  return activeOrigins;
}

/**
 * Cleans up stale mirrored partitioned cookies for an origin, verifying that
 * host permission is currently held and that each cookie's current digest still
 * matches the last mirrored digest (never deleting fresh panel-owned sessions).
 * Records whose expiration cannot be verified (e.g., permission revoked
 * externally or `chrome.cookies.set` failure) are returned as `remainingPending`.
 */
async function cleanupStalePartitionedRecords(
  records,
  origin,
  hostname,
  partitionKey,
  { existingPartitionedResult = null } = {}
) {
  const uniqueRecords = [...new Set(Array.isArray(records) ? records : [])].filter(
    (record) => typeof record === 'string' && parseCookieIdentityKey(record) !== null
  );
  if (uniqueRecords.length === 0) {
    return { remainingPending: [], removedIdentityKeys: new Set() };
  }

  if (!hostname || !(await hasOriginCookiePermission(origin))) {
    return { remainingPending: uniqueRecords, removedIdentityKeys: new Set() };
  }

  const partResult =
    existingPartitionedResult || (await queryHostCookiesStrict(hostname, partitionKey));
  if (!partResult.ok) {
    return { remainingPending: uniqueRecords, removedIdentityKeys: new Set() };
  }

  const partByIdentity = new Map(
    partResult.cookies.map((cookie) => [cookieIdentityKey(cookie, hostname), cookie])
  );
  const remainingPending = [];
  const removedIdentityKeys = new Set();

  for (const record of uniqueRecords) {
    const parsed = parseCookieIdentityKey(record);
    if (!parsed) {
      continue;
    }
    const currentCookie = partByIdentity.get(parsed.identityKey);
    if (!currentCookie) {
      // Verified absent while host permission is held -> cleanup complete.
      continue;
    }
    if (currentCookie.httpOnly) {
      // Never delete a server-set HttpOnly cookie.
      continue;
    }
    if (!parsed.valueDigest || computeCookieValueDigest(currentCookie.value) !== parsed.valueDigest) {
      // Partitioned cookie was rotated/replaced inside the panel -> preserve panel-owned session.
      continue;
    }
    const expired = await expirePartitionedCookieByKey(record, hostname, partitionKey);
    if (expired) {
      removedIdentityKeys.add(parsed.identityKey);
      partByIdentity.delete(parsed.identityKey);
    } else {
      remainingPending.push(record);
    }
  }

  return { remainingPending, removedIdentityKeys };
}

function buildReconcileResult(nextPendingCleanups = {}) {
  const pendingCleanupsByOrigin = {};
  let pendingCleanupCount = 0;
  for (const [origin, records] of Object.entries(nextPendingCleanups)) {
    if (Array.isArray(records) && records.length > 0) {
      pendingCleanupsByOrigin[origin] = records.length;
      pendingCleanupCount += records.length;
    }
  }
  const hasPendingCleanup = pendingCleanupCount > 0;
  return {
    ok: !hasPendingCleanup,
    success: !hasPendingCleanup,
    hasPendingCleanup,
    pendingCleanupCount,
    pendingCleanupsByOrigin
  };
}

export async function reconcileEmbeddedFrameCookies() {
  if (typeof chrome === 'undefined' || !chrome?.cookies?.getAll || !chrome?.cookies?.set) {
    return buildReconcileResult();
  }

  const partitionKey = getExtensionPartitionKey();
  if (!partitionKey) {
    return buildReconcileResult();
  }

  const hydration = await loadCustomProviders();
  const settings = await chrome.storage.sync.get({ enabledProviders: [] });
  const enabledProviderIds = Array.isArray(settings?.enabledProviders)
    ? settings.enabledProviders
    : [];

  const activeOrigins = await collectActiveEmbeddedHttpsOrigins(enabledProviderIds, {
    includeCustom: hydration.ok
  });
  const previousState = await loadCookieTrackingState();
  const nextMirrored = {};
  const nextPendingCleanups = {};

  for (const [origin, { hostname, hasNonSecureCookieAccess }] of activeOrigins.entries()) {
    const previousRecords = previousState.mirrored[origin] || [];
    const pendingForOrigin = previousState.pendingCleanups[origin] || [];

    const partResult = await queryHostCookiesStrict(hostname, partitionKey);
    let remainingPendingForOrigin = pendingForOrigin;
    let partitionedCookies = partResult.cookies;

    if (pendingForOrigin.length > 0) {
      const flushed = await cleanupStalePartitionedRecords(
        pendingForOrigin,
        origin,
        hostname,
        partitionKey,
        { existingPartitionedResult: partResult }
      );
      remainingPendingForOrigin = flushed.remainingPending;
      if (flushed.removedIdentityKeys.size > 0) {
        partitionedCookies = partitionedCookies.filter(
          (cookie) => !flushed.removedIdentityKeys.has(cookieIdentityKey(cookie, hostname))
        );
      }
    }

    const unpartResult = await queryHostCookiesStrict(hostname, null);
    if (!partResult.ok || !unpartResult.ok) {
      if (previousRecords.length > 0) {
        nextMirrored[origin] = previousRecords;
      }
      if (remainingPendingForOrigin.length > 0) {
        nextPendingCleanups[origin] = [...new Set(remainingPendingForOrigin)].sort();
      }
      continue;
    }

    const partitionedByExactKey = new Map(
      partitionedCookies.map((cookie) => [cookieIdentityKey(cookie, hostname), cookie])
    );
    const partitionedByHostFallbackKey = new Map(
      partitionedCookies
        .filter((cookie) => cookie.hostOnly)
        .map((cookie) => [
          JSON.stringify([
            typeof cookie.storeId === 'string' ? cookie.storeId : '',
            cookie.path || '/',
            cookie.name
          ]),
          cookie
        ])
    );

    const previousByIdentity = new Map();
    for (const rawRecord of previousRecords) {
      const parsed = parseCookieIdentityKey(rawRecord);
      if (parsed) {
        previousByIdentity.set(parsed.identityKey, { parsed, raw: rawRecord });
      }
    }

    const nextRecords = [];
    const handledPreviousIdentityKeys = new Set();
    const overwrittenIdentityKeys = new Set();

    for (const sourceCookie of unpartResult.cookies) {
      if (!isMirrorableUnpartitionedCookie(sourceCookie)) {
        continue;
      }
      // Non-Secure cookies are gated on the companion http://<hostname>/* grant.
      if (!sourceCookie.secure && !hasNonSecureCookieAccess) {
        continue;
      }

      const exactKey = cookieIdentityKey(sourceCookie, hostname);
      const fallbackKey = JSON.stringify([
        typeof sourceCookie.storeId === 'string' ? sourceCookie.storeId : '',
        sourceCookie.path || '/',
        sourceCookie.name
      ]);
      const hostFallbackIdentityKey = cookieIdentityKey(
        {
          ...sourceCookie,
          domain: hostname,
          hostOnly: true
        },
        hostname
      );
      const existingMirror =
        partitionedByExactKey.get(exactKey) || partitionedByHostFallbackKey.get(fallbackKey);
      const existingMirrorKey = existingMirror
        ? cookieIdentityKey(existingMirror, hostname)
        : null;
      const existingMirrorPreviousEntry = existingMirrorKey
        ? previousByIdentity.get(existingMirrorKey) || null
        : null;
      const previousEntry =
        existingMirrorPreviousEntry ||
        previousByIdentity.get(exactKey) ||
        previousByIdentity.get(hostFallbackIdentityKey) ||
        null;

      const sourceDigest = computeCookieValueDigest(sourceCookie.value);
      const lastMirroredDigest = existingMirrorPreviousEntry?.parsed?.valueDigest || null;
      const existingMirrorDigest = existingMirror
        ? computeCookieValueDigest(existingMirror.value)
        : null;

      if (existingMirror?.httpOnly) {
        continue;
      }

      if (existingMirror) {
        // Only maintain or overwrite a pre-existing partitioned cookie when we
        // already hold a verified mirror record whose digest matches it. When
        // tracking is empty (e.g., upgrade/fresh storage) or the panel rotated
        // the cookie to a different value, leave the panel-owned cookie
        // untouched and never adopt ownership of it.
        const ownedByMirror =
          lastMirroredDigest !== null && existingMirrorDigest === lastMirroredDigest;
        if (!ownedByMirror) {
          if (existingMirrorPreviousEntry) {
            handledPreviousIdentityKeys.add(existingMirrorPreviousEntry.parsed.identityKey);
          }
          continue;
        }

        if (isUpToDatePartitionedMirror(sourceCookie, existingMirror)) {
          handledPreviousIdentityKeys.add(existingMirrorPreviousEntry.parsed.identityKey);
          nextRecords.push(serializeMirroredCookieRecord(existingMirror, hostname, sourceDigest));
          overwrittenIdentityKeys.add(existingMirrorKey);
          continue;
        }
      }

      const written = await setPartitionedMirrorCookie(sourceCookie, hostname, partitionKey);
      if (written) {
        const writtenIdentityKey = cookieIdentityKey(written, hostname);
        if (previousEntry && previousEntry.parsed.identityKey === writtenIdentityKey) {
          handledPreviousIdentityKeys.add(previousEntry.parsed.identityKey);
        }
        nextRecords.push(serializeMirroredCookieRecord(written, hostname, sourceDigest));
        overwrittenIdentityKeys.add(writtenIdentityKey);
      } else if (existingMirrorPreviousEntry) {
        // Write failed: do not record the unwritten digest; retain the last verified mirror record.
        handledPreviousIdentityKeys.add(existingMirrorPreviousEntry.parsed.identityKey);
        nextRecords.push(existingMirrorPreviousEntry.raw);
      }
    }

    const staleRecords = previousRecords.filter((rawRecord) => {
      const parsed = parseCookieIdentityKey(rawRecord);
      return parsed && !handledPreviousIdentityKeys.has(parsed.identityKey);
    });

    const staleCleanup = await cleanupStalePartitionedRecords(
      staleRecords,
      origin,
      hostname,
      partitionKey,
      { existingPartitionedResult: { ok: true, cookies: partitionedCookies } }
    );

    const combinedPending = [
      ...remainingPendingForOrigin.filter((rawRecord) => {
        const parsed = parseCookieIdentityKey(rawRecord);
        return parsed && !overwrittenIdentityKeys.has(parsed.identityKey);
      }),
      ...staleCleanup.remainingPending
    ];

    const uniqueSortedPending = [...new Set(combinedPending)].sort();
    if (uniqueSortedPending.length > 0) {
      nextPendingCleanups[origin] = uniqueSortedPending;
    }

    const uniqueSortedNextRecords = [...new Set(nextRecords)].sort();
    if (uniqueSortedNextRecords.length > 0) {
      nextMirrored[origin] = uniqueSortedNextRecords;
    }
  }

  const inactiveOrigins = new Set([
    ...Object.keys(previousState.mirrored),
    ...Object.keys(previousState.pendingCleanups)
  ]);

  for (const origin of inactiveOrigins) {
    if (activeOrigins.has(origin)) {
      continue;
    }
    const previousKeys = previousState.mirrored[origin] || [];
    const previousPending = previousState.pendingCleanups[origin] || [];

    if (!hydration.ok && origin !== CHATGLM_ORIGIN) {
      if (previousKeys.length > 0) {
        nextMirrored[origin] = previousKeys;
      }
      if (previousPending.length > 0) {
        nextPendingCleanups[origin] = previousPending;
      }
      continue;
    }

    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = '';
    }

    const cleanupResult = await cleanupStalePartitionedRecords(
      [...previousKeys, ...previousPending],
      origin,
      hostname,
      partitionKey
    );
    const uniqueSortedPending = [...new Set(cleanupResult.remainingPending)].sort();
    if (uniqueSortedPending.length > 0) {
      nextPendingCleanups[origin] = uniqueSortedPending;
    }
  }

  await saveCookieTrackingStateIfChanged(previousState, {
    mirrored: nextMirrored,
    pendingCleanups: nextPendingCleanups
  });

  return buildReconcileResult(nextPendingCleanups);
}

export function createEmbeddedFrameCookieReconcileScheduler(reconcile, onError = () => {}) {
  let tail = Promise.resolve();
  let pendingRun = null;

  return function scheduleReconcile() {
    if (pendingRun) {
      return pendingRun;
    }

    pendingRun = tail
      .then(() => {
        pendingRun = null;
        return reconcile();
      })
      .then(
        (result) => {
          if (result && typeof result === 'object') {
            const pendingCleanupCount =
              typeof result.pendingCleanupCount === 'number' ? result.pendingCleanupCount : 0;
            const hasPendingCleanup = Boolean(result.hasPendingCleanup || pendingCleanupCount > 0);
            const ok = result.ok !== undefined ? Boolean(result.ok) : !hasPendingCleanup;
            return {
              ...result,
              ok,
              success: result.success !== undefined ? Boolean(result.success) : ok,
              hasPendingCleanup,
              pendingCleanupCount,
              pendingCleanupsByOrigin:
                result.pendingCleanupsByOrigin && typeof result.pendingCleanupsByOrigin === 'object'
                  ? result.pendingCleanupsByOrigin
                  : {}
            };
          }
          return { success: true };
        },
        (error) => {
          onError(error);
          return {
            ok: false,
            success: false,
            hasPendingCleanup: false,
            pendingCleanupCount: 0,
            pendingCleanupsByOrigin: {},
            error: error?.message || String(error)
          };
        }
      );
    tail = pendingRun;
    return pendingRun;
  };
}
