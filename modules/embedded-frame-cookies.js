import { isCustomProviderId, loadCustomProviders } from './custom-providers.js';
import { hasOptionalProviderPermission, supportsScopedFrameRules } from './optional-provider-access.js';
import { getProviderDescriptor, listProviderDescriptors } from './provider-registry.js';

export const EMBEDDED_FRAME_COOKIE_SYNC_ACTION = 'syncEmbeddedFrameCookies';
export const CHATGLM_PROVIDER_ID = 'chatglm';
export const CHATGLM_ORIGIN = 'https://chatglm.cn';
export const CHATGLM_HOSTNAME = 'chatglm.cn';
export const CHATGLM_AUTH_COOKIE_NAMES = Object.freeze([
  'chatglm_token',
  'chatglm_refresh_token'
]);
export const MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY = 'mirroredEmbeddedFrameCookies';

const EXPIRY_TOLERANCE_SECONDS = 2;
const activeSelfPartitionedRemovals = new Set();

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

export function requiresEmbeddedFrameCookieSync(providerId) {
  if (providerId === CHATGLM_PROVIDER_ID) {
    return true;
  }
  if (!isCustomProviderId(providerId)) {
    return false;
  }
  const descriptor = getProviderDescriptor(providerId);
  return Boolean(
    descriptor?.access === 'custom' &&
    descriptor.customKind !== 'api' &&
    typeof descriptor.frameOrigins?.[0] === 'string' &&
    descriptor.frameOrigins[0].startsWith('https://')
  );
}

export function isChatglmGuestJwt(token) {
  if (typeof token !== 'string' || token.length === 0) {
    return false;
  }
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) {
    return false;
  }
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded));
    return decoded?.is_guest === true;
  } catch {
    return false;
  }
}

export function cookieMatchesHostname(cookieDomain, hostOnly, hostname) {
  if (typeof cookieDomain !== 'string' || cookieDomain.length === 0 || typeof hostname !== 'string' || hostname.length === 0) {
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

async function queryHostCookies(hostname, partitionKey = null) {
  if (!chrome?.cookies?.getAll) {
    return [];
  }
  const partitionFilter = partitionKey ? { partitionKey } : {};
  const [byUrl, byDomain] = await Promise.all([
    chrome.cookies.getAll({ url: `https://${hostname}/`, ...partitionFilter }).catch(() => []),
    chrome.cookies.getAll({ domain: hostname, ...partitionFilter }).catch(() => [])
  ]);

  const deduped = new Map();
  for (const cookie of [...(Array.isArray(byUrl) ? byUrl : []), ...(Array.isArray(byDomain) ? byDomain : [])]) {
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

  return [...deduped.values()];
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
      return await chrome.cookies.set({
        ...baseDetails,
        domain: sourceCookie.domain
      });
    } catch {
      // Fall back to a host-only partitioned cookie if superdomain write access is unavailable.
    }
  }

  try {
    return await chrome.cookies.set(baseDetails);
  } catch (error) {
    console.warn(`[EmbeddedCookies] Failed to mirror cookie ${sourceCookie.name} on ${hostname}:`, error);
    return null;
  }
}

async function setUnpartitionedChatglmCookie(sourceCookie) {
  if (!chrome?.cookies?.set) {
    return null;
  }
  const path = sourceCookie.path || '/';
  const details = {
    url: `${CHATGLM_ORIGIN}${path}`,
    name: sourceCookie.name,
    value: sourceCookie.value,
    path,
    secure: false,
    httpOnly: false,
    sameSite: 'lax'
  };
  if (typeof sourceCookie.expirationDate === 'number') {
    details.expirationDate = sourceCookie.expirationDate;
  }
  if (typeof sourceCookie.storeId === 'string' && sourceCookie.storeId.length > 0) {
    details.storeId = sourceCookie.storeId;
  }
  try {
    return await chrome.cookies.set(details);
  } catch (error) {
    console.warn(`[EmbeddedCookies] Failed to sync ChatGLM cookie ${sourceCookie.name} to top-level:`, error);
    return null;
  }
}

async function removePartitionedCookieByKey(serializedKey, hostname, partitionKey) {
  if (!chrome?.cookies?.remove) {
    return;
  }
  const parsed = parseCookieIdentityKey(serializedKey);
  if (!parsed) {
    return;
  }
  const cleanHost = hostname || parsed.domain.replace(/^\.+/, '');
  if (!cleanHost) {
    return;
  }
  const details = {
    url: `https://${cleanHost}${parsed.path}`,
    name: parsed.name,
    partitionKey
  };
  if (parsed.storeId) {
    details.storeId = parsed.storeId;
  }
  activeSelfPartitionedRemovals.add(parsed.name);
  try {
    await chrome.cookies.remove(details).catch(() => {});
  } finally {
    activeSelfPartitionedRemovals.delete(parsed.name);
  }
}

async function loadMirroredCookiesState() {
  if (!chrome?.storage?.local?.get) {
    return {};
  }
  try {
    const stored = await chrome.storage.local.get({ [MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]: {} });
    const raw = stored?.[MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return {};
    }
    const normalized = {};
    for (const [origin, keys] of Object.entries(raw)) {
      if (typeof origin === 'string' && Array.isArray(keys)) {
        normalized[origin] = keys.filter((key) => typeof key === 'string');
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function isSameMirroredState(left, right) {
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

async function saveMirroredCookiesStateIfChanged(previousState, nextState) {
  if (!chrome?.storage?.local?.set || isSameMirroredState(previousState, nextState)) {
    return;
  }
  try {
    await chrome.storage.local.set({ [MIRRORED_EMBEDDED_COOKIES_STORAGE_KEY]: nextState });
  } catch (error) {
    console.warn('[EmbeddedCookies] Failed to persist mirrored cookie keys:', error);
  }
}

async function collectActiveEmbeddedHttpsOrigins(enabledProviderIds, { includeCustom = true } = {}) {
  const enabledSet = new Set(Array.isArray(enabledProviderIds) ? enabledProviderIds : []);
  const activeOrigins = new Map();

  if (enabledSet.has(CHATGLM_PROVIDER_ID) && await hasOptionalProviderPermission(CHATGLM_PROVIDER_ID)) {
    activeOrigins.set(CHATGLM_ORIGIN, CHATGLM_HOSTNAME);
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
        activeOrigins.set(origin, hostname);
      }
    }
  }

  return activeOrigins;
}

async function promoteChatglmLoggedInPanelSessionIfNeeded(
  unpartitionedCookies,
  partitionedCookies,
  previousMirroredRecords = []
) {
  const partToken = partitionedCookies.find((cookie) => cookie.name === 'chatglm_token');
  if (!partToken || !partToken.value || isChatglmGuestJwt(partToken.value)) {
    return unpartitionedCookies;
  }

  const previousTokenDigests = new Set();
  for (const record of previousMirroredRecords) {
    const parsed = parseCookieIdentityKey(record);
    if (parsed?.name === 'chatglm_token' && parsed.valueDigest) {
      previousTokenDigests.add(parsed.valueDigest);
    }
  }
  if (previousTokenDigests.has(computeCookieValueDigest(partToken.value))) {
    return unpartitionedCookies;
  }

  const unpartToken = unpartitionedCookies.find((cookie) => cookie.name === 'chatglm_token');
  if (unpartToken && unpartToken.value && !isChatglmGuestJwt(unpartToken.value)) {
    return unpartitionedCookies;
  }

  const promotedByName = new Map();
  for (const name of CHATGLM_AUTH_COOKIE_NAMES) {
    const partCookie = partitionedCookies.find((cookie) => cookie.name === name);
    if (!partCookie || !partCookie.value) {
      continue;
    }
    const saved = await setUnpartitionedChatglmCookie(partCookie);
    if (saved) {
      promotedByName.set(name, saved);
    }
  }

  if (promotedByName.size === 0) {
    return unpartitionedCookies;
  }

  const retained = unpartitionedCookies.filter((cookie) => !promotedByName.has(cookie.name));
  return [...retained, ...promotedByName.values()];
}

export async function reconcileEmbeddedFrameCookies() {
  if (typeof chrome === 'undefined' || !chrome?.cookies?.getAll || !chrome?.cookies?.set) {
    return;
  }

  const partitionKey = getExtensionPartitionKey();
  if (!partitionKey) {
    return;
  }

  const hydration = await loadCustomProviders();
  const settings = await chrome.storage.sync.get({ enabledProviders: [] });
  const enabledProviderIds = Array.isArray(settings?.enabledProviders)
    ? settings.enabledProviders
    : [];

  const activeOrigins = await collectActiveEmbeddedHttpsOrigins(enabledProviderIds, {
    includeCustom: hydration.ok
  });
  const previousState = await loadMirroredCookiesState();
  const nextState = {};

  for (const [origin, hostname] of activeOrigins.entries()) {
    let [unpartitionedCookies, partitionedCookies] = await Promise.all([
      queryHostCookies(hostname, null),
      queryHostCookies(hostname, partitionKey)
    ]);

    if (origin === CHATGLM_ORIGIN) {
      unpartitionedCookies = await promoteChatglmLoggedInPanelSessionIfNeeded(
        unpartitionedCookies,
        partitionedCookies,
        previousState[origin] || []
      );
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

    const nextRecords = [];
    const nextIdentityKeys = new Set();
    for (const sourceCookie of unpartitionedCookies) {
      if (!isMirrorableUnpartitionedCookie(sourceCookie)) {
        continue;
      }

      const exactKey = cookieIdentityKey(sourceCookie, hostname);
      const fallbackKey = JSON.stringify([
        typeof sourceCookie.storeId === 'string' ? sourceCookie.storeId : '',
        sourceCookie.path || '/',
        sourceCookie.name
      ]);
      const existingMirror =
        partitionedByExactKey.get(exactKey) || partitionedByHostFallbackKey.get(fallbackKey);
      const valueDigest = computeCookieValueDigest(sourceCookie.value);

      if (isUpToDatePartitionedMirror(sourceCookie, existingMirror)) {
        nextIdentityKeys.add(cookieIdentityKey(existingMirror, hostname));
        nextRecords.push(serializeMirroredCookieRecord(existingMirror, hostname, valueDigest));
        continue;
      }

      const written = await setPartitionedMirrorCookie(sourceCookie, hostname, partitionKey);
      const mirrorCookie = written || sourceCookie;
      nextIdentityKeys.add(cookieIdentityKey(mirrorCookie, hostname));
      nextRecords.push(serializeMirroredCookieRecord(mirrorCookie, hostname, valueDigest));
    }

    const previousRecords = previousState[origin] || [];
    for (const oldRecord of previousRecords) {
      const parsedOld = parseCookieIdentityKey(oldRecord);
      if (parsedOld && !nextIdentityKeys.has(parsedOld.identityKey)) {
        await removePartitionedCookieByKey(oldRecord, hostname, partitionKey);
      }
    }

    const uniqueSortedNextRecords = [...new Set(nextRecords)].sort();
    if (uniqueSortedNextRecords.length > 0) {
      nextState[origin] = uniqueSortedNextRecords;
    }
  }

  for (const [origin, previousKeys] of Object.entries(previousState)) {
    if (activeOrigins.has(origin)) {
      continue;
    }
    if (!hydration.ok && origin !== CHATGLM_ORIGIN) {
      nextState[origin] = previousKeys;
      continue;
    }
    let hostname = '';
    try {
      hostname = new URL(origin).hostname;
    } catch {
      hostname = '';
    }
    for (const oldKey of previousKeys) {
      await removePartitionedCookieByKey(oldKey, hostname, partitionKey);
    }
  }

  await saveMirroredCookiesStateIfChanged(previousState, nextState);
}

export async function handleEmbeddedFrameCookieChanged(changeInfo) {
  const cookie = changeInfo?.cookie;
  if (!cookie || typeof cookie.name !== 'string' || cookie.name.length === 0) {
    return false;
  }

  const partitionKey = getExtensionPartitionKey();
  if (!partitionKey) {
    return false;
  }

  // Bidirectional sync for Zhipu (chatglm.cn) auth cookies written or cleared inside the panel.
  if (isSamePartitionKey(cookie.partitionKey, partitionKey)) {
    if (
      !CHATGLM_AUTH_COOKIE_NAMES.includes(cookie.name) ||
      !cookieMatchesHostname(cookie.domain || '', Boolean(cookie.hostOnly), CHATGLM_HOSTNAME)
    ) {
      return false;
    }
    if (changeInfo.removed && (changeInfo.cause === 'overwrite' || activeSelfPartitionedRemovals.has(cookie.name))) {
      return false;
    }

    const settings = await chrome.storage.sync.get({ enabledProviders: [] }).catch(() => ({ enabledProviders: [] }));
    const enabledIds = Array.isArray(settings?.enabledProviders) ? settings.enabledProviders : [];
    if (!enabledIds.includes(CHATGLM_PROVIDER_ID) || !(await hasOptionalProviderPermission(CHATGLM_PROVIDER_ID))) {
      return false;
    }

    const unpartitionedCookies = await queryHostCookies(CHATGLM_HOSTNAME, null);
    const matchingUnpart = unpartitionedCookies.filter((item) => item.name === cookie.name);

    if (!changeInfo.removed) {
      if (matchingUnpart.some((item) => item.value === cookie.value)) {
        return false;
      }
      const unpartAccessToken = unpartitionedCookies.find((item) => item.name === 'chatglm_token');
      const topLevelHasRealUser = Boolean(
        unpartAccessToken?.value && !isChatglmGuestJwt(unpartAccessToken.value)
      );
      if (topLevelHasRealUser) {
        if (cookie.name === 'chatglm_token' && isChatglmGuestJwt(cookie.value)) {
          return true;
        }
        if (cookie.name === 'chatglm_refresh_token') {
          const partCookies = await queryHostCookies(CHATGLM_HOSTNAME, partitionKey);
          const partAccessToken = partCookies.find((item) => item.name === 'chatglm_token');
          if (!partAccessToken?.value || isChatglmGuestJwt(partAccessToken.value)) {
            return true;
          }
        }
      }
      await setUnpartitionedChatglmCookie(cookie);
      return true;
    }

    if (matchingUnpart.length === 0) {
      return false;
    }

    if (chrome.cookies?.remove) {
      for (const item of matchingUnpart) {
        const removeDetails = {
          url: `${CHATGLM_ORIGIN}${item.path || '/'}`,
          name: item.name
        };
        if (typeof item.storeId === 'string' && item.storeId.length > 0) {
          removeDetails.storeId = item.storeId;
        }
        await chrome.cookies.remove(removeDetails).catch(() => {});
      }
    }
    return true;
  }

  if (cookie.partitionKey || cookie.httpOnly) {
    return false;
  }

  return true;
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
        () => ({ success: true }),
        (error) => {
          onError(error);
          return { success: false, error: error?.message || String(error) };
        }
      );
    tail = pendingRun;
    return pendingRun;
  };
}
