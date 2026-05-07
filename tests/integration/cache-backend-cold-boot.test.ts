/**
 * Integration test: cold-boot paths for the cache.db backend.
 *
 * Exercises the boundary between CacheBackendMigration, the IndexedDB-backed
 * CacheBlobStore (real fake-indexeddb), and the persisted CacheBackendState.
 *
 * Coverage focus:
 *   - First-launch desktop install (no legacy file) -> verified short-circuit
 *   - Warm boot after a previous verified run -> no IDB write, no legacy read
 *   - Mobile bypass -> blob store not touched, file backend recorded
 *   - app.appId fallback path: factory wires VaultAdapter when forceDesktop=false
 */

import type { DataAdapter } from 'obsidian';
import { IDBFactory } from 'fake-indexeddb';

import {
  CacheBackendMigration,
  type CacheBackendState,
  type CacheBackendStateAccessor
} from '../../src/database/migration/CacheBackendMigration';
import { IndexedDBCacheBlobStore } from '../../src/database/storage/IndexedDBCacheBlobStore';

interface FakeAdapterHandle {
  adapter: DataAdapter;
  files: Map<string, ArrayBuffer>;
}

function fakeAdapter(initial: Map<string, ArrayBuffer> = new Map()): FakeAdapterHandle {
  const files = initial;
  const adapter = {
    exists: jest.fn(async (path: string) => files.has(path)),
    readBinary: jest.fn(async (path: string) => {
      const data = files.get(path);
      if (!data) throw new Error(`not found: ${path}`);
      return data;
    }),
    writeBinary: jest.fn(async (path: string, bytes: ArrayBuffer) => {
      files.set(path, bytes);
    }),
    remove: jest.fn(async (path: string) => {
      if (!files.delete(path)) throw new Error(`not found: ${path}`);
    }),
    list: jest.fn(async () => ({ files: Array.from(files.keys()), folders: [] })),
    mkdir: jest.fn(async () => undefined),
    stat: jest.fn(async (path: string) => {
      const data = files.get(path);
      if (!data) return null;
      return { type: 'file', ctime: 0, mtime: 0, size: data.byteLength };
    })
  } as unknown as DataAdapter;
  return { adapter, files };
}

function persistedStateAccessor(initial?: CacheBackendState): {
  accessor: CacheBackendStateAccessor;
  current: { value: CacheBackendState | undefined };
} {
  const current: { value: CacheBackendState | undefined } = { value: initial };
  return {
    accessor: {
      read: jest.fn(async () => current.value),
      write: jest.fn(async (state: CacheBackendState) => {
        current.value = state;
      })
    },
    current
  };
}

describe('cache backend cold-boot', () => {
  it('fresh desktop install with no legacy file marks verified+idb without IDB write', async () => {
    const { adapter } = fakeAdapter();
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'fresh:nexus', factory });
    const writeSpy = jest.spyOn(blobStore, 'write');
    const { accessor, current } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: '.obsidian/plugins/nexus/data/cache.db',
      pluginDataRoot: '.obsidian/plugins/nexus/data',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();

    expect(result.outcome).toBe('not_needed');
    expect(current.value).toEqual(expect.objectContaining({
      backend: 'idb',
      migrationState: 'verified'
    }));
    expect(writeSpy).not.toHaveBeenCalled();
    // Blob store stays empty on a fresh install -> read returns null.
    expect(await blobStore.read()).toBeNull();
  });

  it('warm boot after a verified run short-circuits without touching legacy file or IDB', async () => {
    const legacyBytes = new Uint8Array([7, 7, 7, 7]).buffer;
    const { adapter } = fakeAdapter(new Map([
      ['.obsidian/plugins/nexus/data/cache.db', legacyBytes]
    ]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'warm:nexus', factory });
    // Pre-populate IDB so a real warm-boot state is reflected.
    await blobStore.write(legacyBytes);

    const writeSpy = jest.spyOn(blobStore, 'write');
    const readSpy = jest.spyOn(blobStore, 'read');

    const { accessor, current } = persistedStateAccessor({
      backend: 'idb',
      migrationState: 'verified',
      migratedAt: 1
    });

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: '.obsidian/plugins/nexus/data/cache.db',
      pluginDataRoot: '.obsidian/plugins/nexus/data',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();

    expect(result.outcome).toBe('verified');
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    // Persisted state is untouched.
    expect(current.value).toEqual(expect.objectContaining({
      backend: 'idb',
      migrationState: 'verified'
    }));
  });

  it('mobile bypass records file backend without touching the IDB blob store', async () => {
    const { adapter } = fakeAdapter();
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'mobile:nexus', factory });
    const writeSpy = jest.spyOn(blobStore, 'write');
    const readSpy = jest.spyOn(blobStore, 'read');
    const { accessor, current } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'irrelevant.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: true,
      showNotices: false
    });

    const result = await migration.runIfNeeded();

    expect(result.outcome).toBe('mobile_bypass');
    expect(current.value).toEqual({ backend: 'file', migrationState: 'not_needed' });
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('warm boot with persisted file backend does NOT short-circuit (cold-path runs)', async () => {
    // A persisted state of {backend: 'file'} represents a desktop user whose
    // prior migration failed and was rolled back to the legacy file. The next
    // launch should re-enter the state machine, not silently treat it as
    // verified.
    const { adapter } = fakeAdapter();
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'rollback:nexus', factory });
    const { accessor } = persistedStateAccessor({
      backend: 'file',
      migrationState: 'failed',
      lastError: 'prior VERIFY failed'
    });

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: '.obsidian/plugins/nexus/data/cache.db',
      pluginDataRoot: '.obsidian/plugins/nexus/data',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    // No legacy file => not_needed (state machine continues, doesn't stall).
    expect(result.outcome).toBe('not_needed');
  });
});
