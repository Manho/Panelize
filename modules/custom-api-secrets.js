import { CUSTOM_PROVIDER_ID_PATTERN } from './provider-registry.js';

export const CUSTOM_API_SECRETS_DB_NAME = 'PanelizeCustomApiSecretsDB';
export const CUSTOM_API_SECRETS_DB_VERSION = 1;
export const CUSTOM_API_SECRETS_STORE = 'apiSecrets';
export const CUSTOM_API_SECRETS_CHANNEL = 'panelize:custom-api-secrets';
export const MAX_CUSTOM_API_KEY_LENGTH = 4096;

let cachedDb = null;
let secretRevisionCounter = 0;
const localSecretListeners = new Set();
const CHANNEL_SOURCE_ID = `secrets-${Math.random().toString(36).slice(2)}-${Date.now()}`;

function nextSecretRevision() {
  secretRevisionCounter += 1;
  return secretRevisionCounter;
}

/**
 * Subscribes to in-process Custom API secret mutations (`providerId` or `'*'`).
 * Returns an unsubscribe callback.
 *
 * @param {(payload: { providerId: string, revision: number }) => void} listener
 * @returns {() => void}
 */
export function onCustomApiSecretChanged(listener) {
  if (typeof listener !== 'function') {
    return () => {};
  }
  localSecretListeners.add(listener);
  return () => {
    localSecretListeners.delete(listener);
  };
}

function broadcastSecretInvalidation(providerId, revision) {
  for (const listener of [...localSecretListeners]) {
    try {
      listener({ providerId, revision });
    } catch {
      // Isolate listener errors from secret storage operations.
    }
  }

  if (typeof BroadcastChannel !== 'function') {
    return;
  }
  try {
    const channel = new BroadcastChannel(CUSTOM_API_SECRETS_CHANNEL);
    channel.postMessage({
      type: 'SECRET_CHANGED',
      providerId,
      revision,
      sourceId: CHANNEL_SOURCE_ID
    });
    channel.close();
  } catch {
    // Ignore environments where BroadcastChannel is restricted.
  }
}

export { CHANNEL_SOURCE_ID as CUSTOM_API_SECRETS_SOURCE_ID };

function isValidSecretProviderId(providerId) {
  return typeof providerId === 'string' && CUSTOM_PROVIDER_ID_PATTERN.test(providerId);
}

function validateSecretProviderId(providerId) {
  if (!isValidSecretProviderId(providerId)) {
    throw new Error(`Invalid custom provider ID for API secret: "${String(providerId)}"`);
  }
}

function normalizeApiKeyInput(apiKey) {
  if (apiKey === null || apiKey === undefined) {
    return '';
  }
  if (typeof apiKey !== 'string') {
    throw new Error('Custom provider API key must be a string');
  }
  const trimmed = apiKey.trim();
  if (trimmed.length > MAX_CUSTOM_API_KEY_LENGTH) {
    throw new Error(
      `Custom provider API key exceeds maximum length (${MAX_CUSTOM_API_KEY_LENGTH} characters)`
    );
  }
  return trimmed;
}

function getIndexedDbFactory() {
  if (typeof globalThis === 'undefined' || !globalThis.indexedDB?.open) {
    throw new Error('IndexedDB is unavailable in this extension context');
  }
  return globalThis.indexedDB;
}

export function resetCustomApiSecretsDbForTests() {
  if (cachedDb) {
    try {
      cachedDb.close?.();
    } catch {
      // Ignore close errors during test teardown.
    }
  }
  cachedDb = null;
}

async function openSecretsDb() {
  if (cachedDb) {
    try {
      void cachedDb.objectStoreNames;
      return cachedDb;
    } catch {
      cachedDb = null;
    }
  }

  const idb = getIndexedDbFactory();
  return new Promise((resolve, reject) => {
    const request = idb.open(CUSTOM_API_SECRETS_DB_NAME, CUSTOM_API_SECRETS_DB_VERSION);

    request.onerror = () => {
      reject(request.error || new Error('Failed to open custom API secrets database'));
    };

    request.onupgradeneeded = (event) => {
      const database = event?.target?.result || request.result;
      const hasStore = typeof database.objectStoreNames?.contains === 'function'
        ? database.objectStoreNames.contains(CUSTOM_API_SECRETS_STORE)
        : Array.isArray(database.objectStoreNames) &&
          database.objectStoreNames.includes(CUSTOM_API_SECRETS_STORE);

      if (!hasStore) {
        database.createObjectStore(CUSTOM_API_SECRETS_STORE, {
          keyPath: 'providerId'
        });
      }
    };

    request.onsuccess = () => {
      const database = request.result;
      database.onclose = () => {
        if (cachedDb === database) {
          cachedDb = null;
        }
      };
      database.onversionchange = () => {
        try {
          database.close?.();
        } catch {
          // Ignore close errors on version change.
        }
        if (cachedDb === database) {
          cachedDb = null;
        }
      };
      cachedDb = database;
      resolve(database);
    };
  });
}

function runStoreRequest(mode, executor) {
  return openSecretsDb().then(
    (database) =>
      new Promise((resolve, reject) => {
        let settled = false;
        const finishResolve = (value) => {
          if (!settled) {
            settled = true;
            resolve(value);
          }
        };
        const finishReject = (error) => {
          if (!settled) {
            settled = true;
            reject(error || new Error('Custom API secrets IndexedDB transaction failed'));
          }
        };

        let tx;
        let request;
        try {
          tx = database.transaction([CUSTOM_API_SECRETS_STORE], mode);
          const store = tx.objectStore(CUSTOM_API_SECRETS_STORE);
          request = executor(store);
        } catch (error) {
          finishReject(error);
          return;
        }

        request.onsuccess = () => {
          finishResolve(request.result);
        };
        request.onerror = () => {
          finishReject(request.error);
        };
        if (tx) {
          tx.onerror = () => {
            finishReject(tx.error || request.error);
          };
          tx.onabort = () => {
            finishReject(tx.error || new Error('Custom API secrets transaction aborted'));
          };
        }
      })
  );
}

/**
 * Stores or clears the local-only API key for a Custom API provider inside
 * extension-origin IndexedDB (`PanelizeCustomApiSecretsDB`).
 *
 * Passing an empty/whitespace string deletes any stored secret for `providerId`.
 * When `options.endpointUrl` is supplied, the stored credential record is bound
 * to that normalized endpoint URL so concurrent requests captured against a
 * previous endpoint can detect a mismatch and refuse to send the replacement key.
 *
 * @param {string} providerId
 * @param {string | null | undefined} apiKey
 * @param {{ endpointUrl?: string | null }} [options]
 * @returns {Promise<{ hasApiKey: boolean, revision: number }>}
 */
export async function saveCustomApiKey(providerId, apiKey, options = {}) {
  validateSecretProviderId(providerId);
  const normalized = normalizeApiKeyInput(apiKey);

  if (normalized.length === 0) {
    const revision = nextSecretRevision();
    await runStoreRequest('readwrite', (store) => store.delete(providerId));
    broadcastSecretInvalidation(providerId, revision);
    return { hasApiKey: false, revision };
  }

  const endpointUrl =
    typeof options?.endpointUrl === 'string' && options.endpointUrl.trim().length > 0
      ? options.endpointUrl.trim()
      : null;
  const revision = nextSecretRevision();

  await runStoreRequest('readwrite', (store) =>
    store.put({
      providerId,
      apiKey: normalized,
      endpointUrl,
      revision,
      updatedAt: Date.now()
    })
  );
  broadcastSecretInvalidation(providerId, revision);

  return { hasApiKey: true, revision };
}

/**
 * Reads the full local-only API key record (including optional bound `endpointUrl`
 * and `revision` metadata) for a Custom API provider, or `null` if none is stored.
 *
 * @param {string} providerId
 * @returns {Promise<{ apiKey: string, endpointUrl: string | null, revision: number | null, updatedAt: number | null } | null>}
 */
export async function getCustomApiKeyRecord(providerId) {
  if (!isValidSecretProviderId(providerId)) {
    return null;
  }
  const entry = await runStoreRequest('readonly', (store) => store.get(providerId));
  if (typeof entry?.apiKey !== 'string' || entry.apiKey.length === 0) {
    return null;
  }
  return {
    apiKey: entry.apiKey,
    endpointUrl: typeof entry.endpointUrl === 'string' && entry.endpointUrl ? entry.endpointUrl : null,
    revision: Number.isInteger(entry.revision) ? entry.revision : null,
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : null
  };
}

/**
 * Reads the local-only API key for a Custom API provider, or returns `null` if
 * none is stored or `providerId` is invalid.
 *
 * @param {string} providerId
 * @returns {Promise<string | null>}
 */
export async function getCustomApiKey(providerId) {
  const record = await getCustomApiKeyRecord(providerId);
  return record ? record.apiKey : null;
}

/**
 * Deletes any stored API key for `providerId`.
 *
 * @param {string} providerId
 * @returns {Promise<boolean>}
 */
export async function deleteCustomApiKey(providerId) {
  if (!isValidSecretProviderId(providerId)) {
    return false;
  }
  const revision = nextSecretRevision();
  await runStoreRequest('readwrite', (store) => store.delete(providerId));
  broadcastSecretInvalidation(providerId, revision);
  return true;
}

/**
 * Clears all stored Custom API keys from extension-origin IndexedDB.
 *
 * @returns {Promise<void>}
 */
export async function clearAllCustomApiKeys() {
  const revision = nextSecretRevision();
  await runStoreRequest('readwrite', (store) => store.clear());
  broadcastSecretInvalidation('*', revision);
}
