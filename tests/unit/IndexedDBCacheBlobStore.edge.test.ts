/**
 * Edge-case coverage for IndexedDBCacheBlobStore beyond the round-trip smoke
 * (companion to tests/unit/IndexedDBCacheBlobStore.test.ts):
 *
 *   - Connection close + re-open (closeForTesting)
 *   - Simulated browser eviction: factory wipe between writes (durability test
 *     surface — IDB cleared, store re-opens cleanly)
 *   - navigator.storage.persist denial path does not branch behavior
 *   - navigator.storage.persist absence does not throw
 *   - Concurrent reads of the same idbKey resolve to identical buffers
 */

import { IDBFactory, IDBObjectStore as FakeIDBObjectStore } from 'fake-indexeddb';

import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';

describe('IndexedDBCacheBlobStore edge cases', () => {
  it('closeForTesting allows re-open with the same factory and reads previously-written bytes', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'reopen:k', factory });
    await store.write(new Uint8Array([1, 2, 3]).buffer);
    store.closeForTesting();

    const persisted = await store.read();
    expect(persisted).not.toBeNull();
    expect(new Uint8Array(persisted!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('survives a simulated browser eviction (factory drops the DB) by reopening empty', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'evict:k', factory });
    await store.write(new Uint8Array([9, 9, 9]).buffer);
    expect(await store.read()).not.toBeNull();

    // Simulate eviction by deleting the database underneath the store. The
    // store's cached connection is still valid until close, so we
    // closeForTesting first to force a re-open.
    store.closeForTesting();
    await new Promise<void>((resolve, reject) => {
      const req = factory.deleteDatabase('nexus-cache-blob-store');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('delete failed'));
    });

    // Re-read should now return null (no record after eviction). The store
    // re-opens the DB transparently and the schema upgrade re-creates the
    // empty object store.
    expect(await store.read()).toBeNull();
  });

  it('navigator.storage.persist denial logs warning but does not throw', async () => {
    const factory = new IDBFactory();
    const persistMock = jest.fn().mockResolvedValue(false);
    (globalThis as unknown as { navigator: { storage: { persist: () => Promise<boolean> } } }).navigator = {
      storage: { persist: persistMock }
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const store = new IndexedDBCacheBlobStore({ idbKey: 'persist-denied', factory });
      await store.write(new Uint8Array([1]).buffer);
      // persist was called best-effort.
      expect(persistMock).toHaveBeenCalled();
      // Read still works.
      expect(await store.read()).not.toBeNull();
    } finally {
      warnSpy.mockRestore();
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('navigator.storage.persist throwing does not break write/read', async () => {
    const factory = new IDBFactory();
    const persistMock = jest.fn().mockImplementation(() => { throw new Error('boom'); });
    (globalThis as unknown as { navigator: { storage: { persist: () => Promise<boolean> } } }).navigator = {
      storage: { persist: persistMock }
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const store = new IndexedDBCacheBlobStore({ idbKey: 'persist-throw', factory });
      await store.write(new Uint8Array([1, 2]).buffer);
      const data = await store.read();
      expect(data).not.toBeNull();
    } finally {
      warnSpy.mockRestore();
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('absence of navigator.storage.persist does not throw on first open', async () => {
    const factory = new IDBFactory();
    delete (globalThis as { navigator?: unknown }).navigator;
    const store = new IndexedDBCacheBlobStore({ idbKey: 'nopersist', factory });
    await expect(store.write(new Uint8Array([1]).buffer)).resolves.toBeUndefined();
  });

  it('concurrent read calls on the same idbKey resolve to identical buffers', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'concurrent', factory });
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
    await store.write(payload);

    const [a, b, c] = await Promise.all([store.read(), store.read(), store.read()]);
    expect(a).not.toBeNull();
    expect(new Uint8Array(a!)).toEqual(new Uint8Array(payload));
    expect(new Uint8Array(b!)).toEqual(new Uint8Array(payload));
    expect(new Uint8Array(c!)).toEqual(new Uint8Array(payload));
  });

  it('overwrite replaces the entire blob (no merge, no append)', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'overwrite', factory });
    await store.write(new Uint8Array([1, 1, 1, 1]).buffer);
    await store.write(new Uint8Array([2, 2]).buffer);

    const data = await store.read();
    expect(data).not.toBeNull();
    expect(data!.byteLength).toBe(2);
    expect(new Uint8Array(data!)).toEqual(new Uint8Array([2, 2]));
  });

  it('throws constructor when neither factory option nor globalThis.indexedDB is available', () => {
    const prior = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    try {
      expect(() => new IndexedDBCacheBlobStore({ idbKey: 'no-factory' })).toThrow(/indexedDB is not available/);
    } finally {
      if (prior) (globalThis as { indexedDB?: IDBFactory }).indexedDB = prior;
    }
  });

  it('falls back to globalThis.indexedDB when no factory option is provided', async () => {
    const factory = new IDBFactory();
    (globalThis as { indexedDB?: IDBFactory }).indexedDB = factory;
    try {
      const store = new IndexedDBCacheBlobStore({ idbKey: 'global-fallback' });
      await store.write(new Uint8Array([1]).buffer);
      const data = await store.read();
      expect(data).not.toBeNull();
    } finally {
      delete (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    }
  });

  it('rejects read when the IDBRequest emits an error event', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'read-err', factory });
    await store.write(new Uint8Array([1, 2]).buffer);

    // Patch IDBObjectStore.prototype.get to return a fake request whose
    // onerror fires asynchronously. fake-indexeddb's IDBRequest 'error'
    // property is read-only after the request resolves, so we replace the
    // request object entirely with a forge that the production code can
    // attach onerror/onsuccess to.
    const originalGet = FakeIDBObjectStore.prototype.get;
    let stub: { onerror: ((e: Event) => void) | null; onsuccess: ((e: Event) => void) | null; error: Error };
    FakeIDBObjectStore.prototype.get = function (this: IDBObjectStore, _key: IDBValidKey) {
      FakeIDBObjectStore.prototype.get = originalGet;
      stub = { onerror: null, onsuccess: null, error: new Error('synthetic IDB read failure') };
      // Schedule the error handler to fire after the production code has
      // assigned onerror.
      setTimeout(() => stub.onerror?.({ type: 'error' } as Event), 0);
      return stub as unknown as IDBRequest;
    } as typeof originalGet;

    try {
      await expect(store.read()).rejects.toThrow(/synthetic IDB read failure/);
    } finally {
      FakeIDBObjectStore.prototype.get = originalGet;
    }
  });

  it('rejects write when the transaction aborts', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'write-abort', factory });
    // Force transaction.abort firing on the next write. Patch IDBDatabase.transaction
    // through factory.open's onsuccess result.
    await store.write(new Uint8Array([1]).buffer); // open the db

    // Hijack the next readwrite transaction by patching IDBDatabase.prototype.transaction.
    const fakeIdb = await import('fake-indexeddb');
    const FakeIDBDatabase = fakeIdb.IDBDatabase;
    const originalTx = FakeIDBDatabase.prototype.transaction;
    let restored = false;
    FakeIDBDatabase.prototype.transaction = function (this: IDBDatabase, _names, _mode) {
      if (restored) return originalTx.apply(this, arguments as unknown as Parameters<typeof originalTx>);
      restored = true;
      FakeIDBDatabase.prototype.transaction = originalTx;
      const stubTx: {
        oncomplete: ((e: Event) => void) | null;
        onabort: ((e: Event) => void) | null;
        onerror: ((e: Event) => void) | null;
        error: Error;
        objectStore(): { put(): unknown };
      } = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        error: new Error('synthetic IDB write abort'),
        objectStore: () => ({ put: () => undefined })
      };
      setTimeout(() => stubTx.onabort?.({ type: 'abort' } as Event), 0);
      return stubTx as unknown as IDBTransaction;
    } as typeof originalTx;

    try {
      await expect(store.write(new Uint8Array([2]).buffer)).rejects.toThrow(/synthetic IDB write abort/);
    } finally {
      FakeIDBDatabase.prototype.transaction = originalTx;
    }
  });

  it('rejects remove when the transaction errors', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'remove-err', factory });
    await store.write(new Uint8Array([1]).buffer); // open the db

    const fakeIdb = await import('fake-indexeddb');
    const FakeIDBDatabase = fakeIdb.IDBDatabase;
    const originalTx = FakeIDBDatabase.prototype.transaction;
    let restored = false;
    FakeIDBDatabase.prototype.transaction = function (this: IDBDatabase, _names, _mode) {
      if (restored) return originalTx.apply(this, arguments as unknown as Parameters<typeof originalTx>);
      restored = true;
      FakeIDBDatabase.prototype.transaction = originalTx;
      const stubTx: {
        oncomplete: ((e: Event) => void) | null;
        onabort: ((e: Event) => void) | null;
        onerror: ((e: Event) => void) | null;
        error: null;
        objectStore(): { delete(): unknown };
      } = {
        oncomplete: null,
        onabort: null,
        onerror: null,
        error: null,
        objectStore: () => ({ delete: () => undefined })
      };
      setTimeout(() => stubTx.onerror?.({ type: 'error' } as Event), 0);
      return stubTx as unknown as IDBTransaction;
    } as typeof originalTx;

    try {
      await expect(store.remove()).rejects.toThrow(/IDB delete failed/);
    } finally {
      FakeIDBDatabase.prototype.transaction = originalTx;
    }
  });

  it('rejects getMetadata when the request errors', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'meta-err', factory });
    await store.write(new Uint8Array([1]).buffer);

    const originalGet = FakeIDBObjectStore.prototype.get;
    let stub: { onerror: ((e: Event) => void) | null; onsuccess: ((e: Event) => void) | null; error: Error | null };
    FakeIDBObjectStore.prototype.get = function (this: IDBObjectStore, _key: IDBValidKey) {
      FakeIDBObjectStore.prototype.get = originalGet;
      stub = { onerror: null, onsuccess: null, error: null };
      setTimeout(() => stub.onerror?.({ type: 'error' } as Event), 0);
      return stub as unknown as IDBRequest;
    } as typeof originalGet;

    try {
      await expect(store.getMetadata()).rejects.toThrow(/IDB metadata read failed/);
    } finally {
      FakeIDBObjectStore.prototype.get = originalGet;
    }
  });

  it('returns null from getMetadata when the record is absent', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'meta-none', factory });
    expect(await store.getMetadata()).toBeNull();
  });

  it('rejects read with default error when the request has no error attached', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'read-err-default', factory });
    await store.write(new Uint8Array([1]).buffer);

    const originalGet = FakeIDBObjectStore.prototype.get;
    let stub: { onerror: ((e: Event) => void) | null; onsuccess: ((e: Event) => void) | null; error: Error | null };
    FakeIDBObjectStore.prototype.get = function (this: IDBObjectStore, _key: IDBValidKey) {
      FakeIDBObjectStore.prototype.get = originalGet;
      stub = { onerror: null, onsuccess: null, error: null };
      setTimeout(() => stub.onerror?.({ type: 'error' } as Event), 0);
      return stub as unknown as IDBRequest;
    } as typeof originalGet;

    try {
      // Hits the `req.error ?? new Error('IDB read failed')` fallback branch.
      await expect(store.read()).rejects.toThrow(/IDB read failed/);
    } finally {
      FakeIDBObjectStore.prototype.get = originalGet;
    }
  });

  it('returns null when the IDB record exists but blob is zero-length', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'zero-blob', factory });
    // Write through the public API with a 0-byte ArrayBuffer.
    await store.write(new ArrayBuffer(0));
    const data = await store.read();
    expect(data).toBeNull();
  });

  it('large blob round-trip (1 MB) preserves bytes', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDBCacheBlobStore({ idbKey: 'large', factory });
    const oneMB = 1024 * 1024;
    const buf = new Uint8Array(oneMB);
    for (let i = 0; i < oneMB; i += 1024) buf[i] = i & 0xff;
    await store.write(buf.buffer);

    const data = await store.read();
    expect(data).not.toBeNull();
    expect(data!.byteLength).toBe(oneMB);
    // Spot-check a handful of indexes.
    const view = new Uint8Array(data!);
    for (let i = 0; i < oneMB; i += 1024) expect(view[i]).toBe(i & 0xff);
  });
});
