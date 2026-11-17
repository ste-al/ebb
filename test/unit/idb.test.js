import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';
import { openRepo } from '../../extension/lib/idb.js';

test('the IndexedDB repo stores, queries and prunes records', async () => {
  const repo = openRepo({ indexedDB, IDBKeyRange, name: `ebb-test-${Date.now()}` });
  await repo.put('library', { id: 'a', url: 'https://a.example/', archivedAt: 10, batchId: 'b1', huntId: null });
  await repo.put('library', { id: 'b', url: 'https://b.example/', archivedAt: 20, batchId: 'b1', huntId: 'h' });
  await repo.put('library', { id: 'b', url: 'https://b.example/', archivedAt: 30, batchId: 'b1', huntId: 'h' });
  assert.equal(await repo.count('library'), 2, 'put replaces by id');
  assert.equal((await repo.get('library', 'b')).archivedAt, 30);
  assert.equal(await repo.get('library', 'missing'), null);
  assert.deepEqual((await repo.getAllSince('library', 'archivedAt', 15)).map((r) => r.id), ['b']);

  for (let i = 0; i < 5; i++) await repo.put('ledger', { id: `e${i}`, type: 'rest', at: i * 10 });
  await repo.deleteBefore('ledger', 'at', 25);
  assert.deepEqual((await repo.getAll('ledger')).map((e) => e.at).sort((x, y) => x - y), [30, 40]);

  await repo.delete('library', 'a');
  assert.deepEqual((await repo.getAll('library')).map((r) => r.id), ['b']);
  await repo.put('later', { id: 'l', url: 'https://l.example/', savedAt: 1 });
  await repo.clear('library');
  assert.equal(await repo.count('library'), 0);
  assert.equal(await repo.count('later'), 1, 'clearing one store leaves the others');
});
