// A small promise wrapper over IndexedDB for the Library, the Later lane and the ledger.
// Everything stays on this device.

const DB_NAME = 'ebb';
const DB_VERSION = 1;

function upgrade(db) {
  if (!db.objectStoreNames.contains('library')) {
    const s = db.createObjectStore('library', { keyPath: 'id' });
    s.createIndex('archivedAt', 'archivedAt');
    s.createIndex('url', 'url');
    s.createIndex('batchId', 'batchId');
    s.createIndex('huntId', 'huntId');
  }
  if (!db.objectStoreNames.contains('later')) {
    const s = db.createObjectStore('later', { keyPath: 'id' });
    s.createIndex('savedAt', 'savedAt');
  }
  if (!db.objectStoreNames.contains('ledger')) {
    const s = db.createObjectStore('ledger', { keyPath: 'id' });
    s.createIndex('at', 'at');
  }
}

const result = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const done = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });

/**
 * @param {{indexedDB?: IDBFactory, IDBKeyRange?: typeof IDBKeyRange, name?: string}} env
 */
export function openRepo({ indexedDB = globalThis.indexedDB, IDBKeyRange = globalThis.IDBKeyRange, name = DB_NAME } = {}) {
  let opening = null;

  const db = () =>
    (opening ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => upgrade(request.result);
      request.onsuccess = () => {
        const d = request.result;
        d.onversionchange = () => {
          d.close();
          opening = null;
        };
        d.onclose = () => {
          opening = null;
        };
        resolve(d);
      };
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    }));

  const store = async (name, mode = 'readonly') => {
    const tx = (await db()).transaction(name, mode);
    return { tx, os: tx.objectStore(name) };
  };

  return {
    async put(name, value) {
      const { tx, os } = await store(name, 'readwrite');
      os.put(value);
      await done(tx);
    },
    async get(name, key) {
      const { os } = await store(name);
      return (await result(os.get(key))) ?? null;
    },
    async getAll(name) {
      const { os } = await store(name);
      return result(os.getAll());
    },
    async delete(name, key) {
      const { tx, os } = await store(name, 'readwrite');
      os.delete(key);
      await done(tx);
    },
    async clear(name) {
      const { tx, os } = await store(name, 'readwrite');
      os.clear();
      await done(tx);
    },
    async count(name) {
      const { os } = await store(name);
      return result(os.count());
    },
    /** Records whose `index` value is at least `since`. */
    async getAllSince(name, index, since) {
      const { os } = await store(name);
      return result(os.index(index).getAll(IDBKeyRange.lowerBound(since)));
    },
    /** Delete records whose `index` value is below `before`. */
    async deleteBefore(name, index, before) {
      const { tx, os } = await store(name, 'readwrite');
      const request = os.index(index).openCursor(IDBKeyRange.upperBound(before, true));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        }
      };
      await done(tx);
    },
  };
}
