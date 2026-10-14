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

  // The store lives as long as the plugin. Taking the factory from whichever
  // window had focus at load (a popout, or the Settings window, which is its
  // own window since Obsidian 1.14) breaks every later save once that window
  // closes: in the running app its open() then returns null.
  it('defaults to the main window factory, not the focused window one', async () => {
    const testWindow = (globalThis as unknown as { window: object }).window;
    const mainFactory = freshFactory();
    const focusedFactory = freshFactory();
    const mainOpen = jest.spyOn(mainFactory, 'open');
    const focusedOpen = jest.spyOn(focusedFactory, 'open');
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(testWindow, 'indexedDB');
    const activeWindowDescriptor = Object.getOwnPropertyDescriptor(testWindow, 'activeWindow');
    Object.defineProperty(testWindow, 'indexedDB', { configurable: true, get: () => mainFactory });
    Object.defineProperty(testWindow, 'activeWindow', {
      configurable: true,
      get: () => ({ indexedDB: focusedFactory })
    });

    try {
      const store = new IndexedDBCacheBlobStore({ idbKey: 'vault-A:plugin-X' });
      await store.write(new Uint8Array([1, 2, 3]).buffer);

      expect(mainOpen).toHaveBeenCalled();
      expect(focusedOpen).not.toHaveBeenCalled();
    } finally {
      if (indexedDbDescriptor) Object.defineProperty(testWindow, 'indexedDB', indexedDbDescriptor);
      if (activeWindowDescriptor) Object.defineProperty(testWindow, 'activeWindow', activeWindowDescriptor);
    }
  });
});
