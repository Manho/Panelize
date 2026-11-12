import { CUSTOM_PROVIDER_ID_PATTERN } from './provider-registry.js';

export const CUSTOM_API_SECRETS_DB_NAME = 'PanelizeCustomApiSecretsDB';
export const CUSTOM_API_SECRETS_DB_VERSION = 1;
export const CUSTOM_API_SECRETS_STORE = 'apiSecrets';
export const MAX_CUSTOM_API_KEY_LENGTH = 4096;

let cachedDb = null;

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
 *
 * @param {string} providerId
 * @param {string | null | undefined} apiKey
 * @returns {Promise<{ hasApiKey: boolean }>}
 */
export async function saveCustomApiKey(providerId, apiKey) {
  validateSecretProviderId(providerId);
  const normalized = normalizeApiKeyInput(apiKey);

  if (normalized.length === 0) {
    await deleteCustomApiKey(providerId);
    return { hasApiKey: false };
  }

  await runStoreRequest('readwrite', (store) =>
    store.put({
      providerId,
      apiKey: normalized,
      updatedAt: Date.now()
    })
  );

  return { hasApiKey: true };
}

/**
 * Reads the local-only API key for a Custom API provider, or returns `null` if
 * none is stored or `providerId` is invalid.
 *
 * @param {string} providerId
 * @returns {Promise<string | null>}
 */
export async function getCustomApiKey(providerId) {
  if (!isValidSecretProviderId(providerId)) {
    return null;
  }
  const entry = await runStoreRequest('readonly', (store) => store.get(providerId));
  return typeof entry?.apiKey === 'string' && entry.apiKey.length > 0 ? entry.apiKey : null;
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
  await runStoreRequest('readwrite', (store) => store.delete(providerId));
  return true;
}

/**
 * Clears all stored Custom API keys from extension-origin IndexedDB.
 *
 * @returns {Promise<void>}
 */
export async function clearAllCustomApiKeys() {
  await runStoreRequest('readwrite', (store) => store.clear());
}
