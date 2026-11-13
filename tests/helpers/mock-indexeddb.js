/**
 * Lightweight in-memory IndexedDB mock for Vitest unit suites.
 */

export function createMockIndexedDB({ failPutError = null } = {}) {
  const databases = new Map();

  function asyncDispatch(fn) {
    queueMicrotask(fn);
  }

  function createRequest(executor) {
    const req = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null
    };
    asyncDispatch(() => executor(req));
    return req;
  }

  function makeObjectStore(storeMap, tx) {
    return {
      put(value) {
        return createRequest((req) => {
          if (failPutError) {
            req.error = failPutError;
            tx.error = failPutError;
            req.onerror?.({ target: req });
            tx.onerror?.({ target: tx });
            return;
          }
          const cloned = JSON.parse(JSON.stringify(value));
          storeMap.set(cloned.providerId, cloned);
          req.result = cloned.providerId;
          req.onsuccess?.({ target: req });
          asyncDispatch(() => tx.oncomplete?.({ target: tx }));
        });
      },
      get(key) {
        return createRequest((req) => {
          const val = storeMap.get(key);
          req.result = val ? JSON.parse(JSON.stringify(val)) : undefined;
          req.onsuccess?.({ target: req });
          asyncDispatch(() => tx.oncomplete?.({ target: tx }));
        });
      },
      getAll() {
        return createRequest((req) => {
          req.result = [...storeMap.values()].map((val) => JSON.parse(JSON.stringify(val)));
          req.onsuccess?.({ target: req });
          asyncDispatch(() => tx.oncomplete?.({ target: tx }));
        });
      },
      delete(key) {
        return createRequest((req) => {
          storeMap.delete(key);
          req.result = undefined;
          req.onsuccess?.({ target: req });
          asyncDispatch(() => tx.oncomplete?.({ target: tx }));
        });
      },
      clear() {
        return createRequest((req) => {
          storeMap.clear();
          req.result = undefined;
          req.onsuccess?.({ target: req });
          asyncDispatch(() => tx.oncomplete?.({ target: tx }));
        });
      }
    };
  }

  return {
    databases,
    open(name, version = 1) {
      return createRequest((req) => {
        let entry = databases.get(name);
        const isUpgrade = !entry || entry.version < version;
        if (!entry) {
          entry = { version, stores: new Map() };
          databases.set(name, entry);
        } else if (isUpgrade) {
          entry.version = version;
        }

        const db = {
          name,
          version: entry.version,
          objectStoreNames: {
            contains: (storeName) => entry.stores.has(storeName)
          },
          createObjectStore(storeName) {
            if (!entry.stores.has(storeName)) {
              entry.stores.set(storeName, new Map());
            }
            return {};
          },
          transaction(storeName) {
            const tx = {
              error: null,
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore(targetName) {
                const map = entry.stores.get(targetName);
                if (!map) {
                  throw new Error(`Object store "${targetName}" not found`);
                }
                return makeObjectStore(map, tx);
              }
            };
            return tx;
          },
          close() {}
        };

        req.result = db;
        if (isUpgrade) {
          req.onupgradeneeded?.({ target: req });
        }
        req.onsuccess?.({ target: req });
      });
    }
  };
}
