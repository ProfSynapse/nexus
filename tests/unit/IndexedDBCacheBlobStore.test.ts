import { IDBFactory } from 'fake-indexeddb';

import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';

function freshFactory(): IDBFactory {
  return new IDBFactory();
}

describe('IndexedDBCacheBlobStore', () => {
  it('returns null when no record has been written yet', async () => {
    const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory: freshFactory() });
    expect(await store.read()).toBeNull();
    expect(await store.getMetadata()).toBeNull();
  });

  it('round-trips a written buffer', async () => {
    const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory: freshFactory() });
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;

    await store.write(payload);

    const read = await store.read();
    expect(read).not.toBeNull();
    expect(new Uint8Array(read!)).toEqual(new Uint8Array(payload));

    const meta = await store.getMetadata();
    expect(meta?.size).toBe(4);
    expect(typeof meta?.mtime).toBe('number');
  });

  it('returns null after remove', async () => {
    const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory: freshFactory() });
    await store.write(new Uint8Array([9, 9, 9]).buffer);
    await store.remove();
    expect(await store.read()).toBeNull();
  });

  it('treats remove as idempotent when no record exists', async () => {
    const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory: freshFactory() });
    await expect(store.remove()).resolves.toBeUndefined();
  });

  it('isolates blobs by idbKey', async () => {
    const factory = freshFactory();
    const storeA = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory });
    const storeB = new IndexedDBCacheBlobStore({ idbKey: 'vault-B:plugin-X', factory });

    await storeA.write(new Uint8Array([1]).buffer);

    expect(await storeA.read()).not.toBeNull();
    expect(await storeB.read()).toBeNull();
  });

  it('treats a 0-byte blob as absent', async () => {
    const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X', factory: freshFactory() });
    await store.write(new ArrayBuffer(0));
    expect(await store.read()).toBeNull();
  });

  it('throws when indexedDB is unavailable in the environment', () => {
    expect(
      () => new IndexedDBCacheBlobStore({ idbKey: 'k', factory: undefined as unknown as IDBFactory })
    ).toThrow(/indexedDB is not available/);
  });
});
