// A small promise wrapper over IndexedDB for the Library, the Later lane and the ledger.
// Everything stays on this device.

import { normalizeUrl } from './util.js';

const DB_NAME = 'ebb';
const DB_VERSION = 3;

/**
 * Stores
 *   library    closed tabs; `key` is the normalized URL, so the same page is kept once
 *   later      links waiting to be read
 *   ledger     one event per action, for the weekly numbers
 *   snapshots  text snippets of open pages, by normalized URL (kept out of the hot state)
 */
function upgrade(db, tx, oldVersion) {
  const library = db.objectStoreNames.contains('library')
    ? tx.objectStore('library')
    : db.createObjectStore('library', { keyPath: 'id' });
  for (const index of ['archivedAt', 'url', 'batchId', 'huntId', 'key']) {
    if (!library.indexNames.contains(index)) library.createIndex(index, index);
  }
  if (oldVersion > 0 && oldVersion < 3) {
    // Creating an index does not populate the missing key property on version 1 Library items.
    const request = library.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value;
      const key = normalizeUrl(item.url);
      if (key && item.key !== key) cursor.update({ ...item, key });
      cursor.continue();
    };
  }
  if (!db.objectStoreNames.contains('later')) {
    const s = db.createObjectStore('later', { keyPath: 'id' });
    s.createIndex('savedAt', 'savedAt');
  }
  if (!db.objectStoreNames.contains('ledger')) {
    const s = db.createObjectStore('ledger', { keyPath: 'id' });
    s.createIndex('at', 'at');
  }
  if (!db.objectStoreNames.contains('snapshots')) {
    db.createObjectStore('snapshots', { keyPath: 'id' });
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
      request.onupgradeneeded = (event) => upgrade(request.result, request.transaction, event.oldVersion);
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
    /** Write a record and remove any copies it replaces in the same transaction. */
    async put(name, value, replacedIds = []) {
      const { tx, os } = await store(name, 'readwrite');
      os.put(value);
      for (const id of replacedIds) os.delete(id);
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
    /** Records whose `index` value equals `value`. */
    async findBy(name, index, value) {
      const { os } = await store(name);
      return result(os.index(index).getAll(value));
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
