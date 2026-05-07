/**
 * Integration test: end-to-end DETECT -> READ_LEGACY -> WRITE_IDB -> VERIFY ->
 * MARK_VERIFIED -> JANITOR through CacheBackendMigration with the REAL
 * IndexedDBCacheBlobStore (fake-indexeddb factory) and a synthesized small
 * SQLite-shaped blob (16 KB).
 *
 * Coverage focus:
 *   - Real round-trip: bytes written to IDB == bytes read from legacy file
 *   - VERIFY uses metadata-fast-path AND read-fallback
 *   - MARK_VERIFIED happens BEFORE janitor begins
 *   - Janitor deletes literal cache.db LAST and survives partial failure
 *   - Idempotent re-run: second runIfNeeded short-circuits
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
  removeOrder: string[];
}

function fakeAdapterWithRemoveOrder(initial: Map<string, ArrayBuffer> = new Map()): FakeAdapterHandle {
  const files = initial;
  const removeOrder: string[] = [];
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
      removeOrder.push(path);
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
  return { adapter, files, removeOrder };
}

function persistedStateAccessor(): {
  accessor: CacheBackendStateAccessor;
  current: { value: CacheBackendState | undefined };
} {
  const current: { value: CacheBackendState | undefined } = { value: undefined };
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

/**
 * Build a small SQLite-shaped blob: header magic ("SQLite format 3\0", 16 bytes)
 * followed by deterministic 0x00..0xFF page bytes, total ~16 KB. Real enough
 * for size-based VERIFY without requiring a sqlite3 wasm engine.
 */
function synthSqliteBlob(): ArrayBuffer {
  const magic = new TextEncoder().encode('SQLite format 3\0');
  const totalBytes = 16 * 1024;
  const out = new Uint8Array(totalBytes);
  out.set(magic, 0);
  for (let i = magic.length; i < totalBytes; i++) out[i] = i & 0xff;
  return out.buffer;
}

async function awaitJanitor(): Promise<void> {
  // Janitor is fire-and-forget — flush the microtask queue so the spawned
  // promise gets a turn before we assert on the adapter.
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe('cache backend migration: end-to-end with real IDB blob store', () => {
  it('round-trips a synthesized SQLite blob from legacy file -> IDB byte-for-byte', async () => {
    const blob = synthSqliteBlob();
    const dataRoot = '.obsidian/plugins/nexus/data';
    const legacy = `${dataRoot}/cache.db`;

    const { adapter } = fakeAdapterWithRemoveOrder(new Map([[legacy, blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'e2e:nexus', factory });
    const { accessor, current } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: legacy,
      pluginDataRoot: dataRoot,
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();

    expect(result.outcome).toBe('verified');
    expect(result.bytesMigrated).toBe(blob.byteLength);
    expect(typeof result.totalMs).toBe('number');

    const persisted = await blobStore.read();
    expect(persisted).not.toBeNull();
    expect(new Uint8Array(persisted!)).toEqual(new Uint8Array(blob));
    expect(current.value?.backend).toBe('idb');
    expect(current.value?.migrationState).toBe('verified');
    expect(typeof current.value?.migratedAt).toBe('number');
  });

  it('VERIFY uses metadata fast-path when blob store reports correct size', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map([['cache.db', blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'meta:nexus', factory });
    const readSpy = jest.spyOn(blobStore, 'read');
    const metaSpy = jest.spyOn(blobStore, 'getMetadata');
    const { accessor } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');
    expect(metaSpy).toHaveBeenCalled();
    // read() is only used as the slower verify fallback.
    expect(readSpy).not.toHaveBeenCalled();
  });

  it('VERIFY falls back to a full read when metadata reports wrong size', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map([['cache.db', blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'badmeta:nexus', factory });
    // Lie about the metadata to force fallback path.
    jest.spyOn(blobStore, 'getMetadata').mockResolvedValue({ size: 1, mtime: 1 });
    const readSpy = jest.spyOn(blobStore, 'read');
    const { accessor } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    // Fallback read confirms byteLength matches -> verify succeeds.
    expect(result.outcome).toBe('verified');
    expect(readSpy).toHaveBeenCalled();
  });

  it('persists failed state when WRITE_IDB throws and never touches MARK_VERIFIED', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map([['cache.db', blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'fail:nexus', factory });
    jest.spyOn(blobStore, 'write').mockRejectedValue(new Error('IDB quota exceeded'));
    const { accessor, current } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();

    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/quota/i);
    expect(current.value?.migrationState).toBe('failed');
    expect(current.value?.backend).toBe('file');
    expect(current.value?.lastError).toMatch(/quota/i);
  });

  it('idempotent: second runIfNeeded after a verified run skips legacy read entirely', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map([['cache.db', blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'idem:nexus', factory });
    const { accessor } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const first = await migration.runIfNeeded();
    expect(first.outcome).toBe('verified');

    (adapter.readBinary as jest.Mock).mockClear();
    const writeSpy = jest.spyOn(blobStore, 'write').mockClear();

    const second = await migration.runIfNeeded();
    expect(second.outcome).toBe('verified');
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('janitor deletes literal cache.db LAST after MARK_VERIFIED (recovery invariant)', async () => {
    const blob = synthSqliteBlob();
    const dataRoot = '.';
    const { adapter, removeOrder } = fakeAdapterWithRemoveOrder(new Map<string, ArrayBuffer>([
      ['cache.db', blob],
      ['cache 2.db', new ArrayBuffer(2)],
      ['cache (1).db', new ArrayBuffer(2)],
      ['cache_conf.db', new ArrayBuffer(2)],
      ['cache.db.abcdef', new ArrayBuffer(2)]
    ]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'janitor:nexus', factory });
    const { accessor } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: dataRoot,
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');

    await awaitJanitor();

    const literalIdx = removeOrder.indexOf('cache.db');
    expect(literalIdx).toBeGreaterThanOrEqual(0);
    const conflictIndices = removeOrder
      .filter(p => p !== 'cache.db')
      .map(p => removeOrder.indexOf(p));
    for (const cidx of conflictIndices) {
      expect(literalIdx).toBeGreaterThan(cidx);
    }
  });

  it('janitor partial failure does not roll back MARK_VERIFIED', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map<string, ArrayBuffer>([
      ['cache.db', blob],
      ['cache 2.db', new ArrayBuffer(2)]
    ]));
    // Make remove fail for the conflict, but succeed for cache.db.
    (adapter.remove as jest.Mock).mockImplementation(async (path: string) => {
      if (path === 'cache 2.db') throw new Error('locked');
    });
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'partial:nexus', factory });
    const { accessor, current } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    await awaitJanitor();

    // Even with a janitor failure, persisted state stays verified.
    expect(result.outcome).toBe('verified');
    expect(current.value?.migrationState).toBe('verified');
  });

  it('synthesized 16 KB blob round-trips header bytes intact (SQLite-format-magic preserved)', async () => {
    const blob = synthSqliteBlob();
    const { adapter } = fakeAdapterWithRemoveOrder(new Map([['cache.db', blob]]));
    const factory = new IDBFactory();
    const blobStore = new IndexedDBCacheBlobStore({ idbKey: 'magic:nexus', factory });
    const { accessor } = persistedStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    await migration.runIfNeeded();
    const persisted = await blobStore.read();
    expect(persisted).not.toBeNull();
    const decoded = new TextDecoder().decode(persisted!.slice(0, 15));
    expect(decoded).toBe('SQLite format 3');
  });
});
