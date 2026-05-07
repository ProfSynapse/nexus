/**
 * Edge-case coverage for CacheBackendMigration beyond the smoke level
 * (companion to tests/unit/CacheBackendMigration.test.ts):
 *
 *   - Janitor stays fire-and-forget under slow disks (does not block return)
 *   - Migration failure recovery: literal cache.db is NOT deleted on VERIFY failure
 *   - VERIFY one-shot retry per spec §5.2
 *   - Fresh-install short-circuit also writes 'idb' state when persisted state
 *     was previously 'failed'
 */

import type { DataAdapter } from 'obsidian';

import {
  CacheBackendMigration,
  type CacheBackendState,
  type CacheBackendStateAccessor
} from '../../src/database/migration/CacheBackendMigration';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

interface FakeAdapterHandle {
  adapter: DataAdapter;
  files: Map<string, ArrayBuffer>;
  removeOrder: string[];
}

function fakeAdapter(initial: Map<string, ArrayBuffer> = new Map()): FakeAdapterHandle {
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

function fakeBlobStore(): { store: CacheBlobStore; data: { value: ArrayBuffer | null } } {
  const data: { value: ArrayBuffer | null } = { value: null };
  const store: CacheBlobStore = {
    read: jest.fn(async () => data.value),
    write: jest.fn(async (buf: ArrayBuffer) => { data.value = buf; }),
    remove: jest.fn(async () => { data.value = null; }),
    getMetadata: jest.fn(async () => (data.value ? { size: data.value.byteLength, mtime: 1 } : null))
  };
  return { store, data };
}

function fakeStateAccessor(initial?: CacheBackendState): {
  accessor: CacheBackendStateAccessor;
  current: { value: CacheBackendState | undefined };
} {
  const current: { value: CacheBackendState | undefined } = { value: initial };
  return {
    accessor: {
      read: jest.fn(async () => current.value),
      write: jest.fn(async (state: CacheBackendState) => { current.value = state; })
    },
    current
  };
}

describe('CacheBackendMigration edge cases', () => {
  it('janitor under a slow disk does not delay runIfNeeded return', async () => {
    const blob = new Uint8Array(1024).fill(0xab).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([
      ['cache.db', blob],
      ['cache 2.db', new ArrayBuffer(1)]
    ]));
    // Simulate a 200ms disk on every remove.
    (adapter.remove as jest.Mock).mockImplementation(async (path: string) => {
      await new Promise(resolve => setTimeout(resolve, 200));
      // Don't actually remove — we just want to demonstrate that the slow
      // remove does not delay runIfNeeded's resolution.
      void path;
    });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const startedAt = Date.now();
    const result = await migration.runIfNeeded();
    const elapsedMs = Date.now() - startedAt;

    expect(result.outcome).toBe('verified');
    // The slow janitor should NOT have delayed migration return. With a 200ms
    // per-remove latency on 2 files (literal + 1 conflict), a serialized run
    // would take ~400ms. We allow 150ms slack for CI variance.
    expect(elapsedMs).toBeLessThan(150);
  });

  it('does NOT delete the literal cache.db when WRITE_IDB fails (recovery invariant)', async () => {
    const blob = new Uint8Array(1024).buffer;
    const { adapter, files } = fakeAdapter(new Map<string, ArrayBuffer>([
      ['cache.db', blob],
      ['cache 2.db', new ArrayBuffer(1)]
    ]));
    const { store } = fakeBlobStore();
    (store.write as jest.Mock).mockRejectedValue(new Error('IDB quota exceeded'));
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('failed');
    expect(current.value?.migrationState).toBe('failed');

    // Recovery invariant: literal cache.db must still exist after a failed
    // run so the next launch can re-read it.
    expect(files.has('cache.db')).toBe(true);
    // Janitor was never invoked because MARK_VERIFIED never landed.
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('does NOT delete the literal cache.db when VERIFY fails twice (after one-shot retry)', async () => {
    const blob = new Uint8Array(1024).buffer;
    const { adapter, files } = fakeAdapter(new Map<string, ArrayBuffer>([
      ['cache.db', blob]
    ]));
    const { store } = fakeBlobStore();
    // Force VERIFY to always fail by making metadata report wrong size and
    // read returning a buffer of the wrong byteLength.
    (store.getMetadata as jest.Mock).mockResolvedValue({ size: 0, mtime: 0 });
    (store.read as jest.Mock).mockResolvedValue(new ArrayBuffer(0));
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/VERIFY failed after retry/);
    expect(current.value?.migrationState).toBe('failed');
    expect(files.has('cache.db')).toBe(true);
    // Two writes happened (initial + retry), but no remove.
    expect(store.write).toHaveBeenCalledTimes(2);
    expect(adapter.remove).not.toHaveBeenCalled();
  });

  it('VERIFY one-shot retry: succeeds after the second WRITE_IDB lands correct metadata', async () => {
    const blob = new Uint8Array(1024).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([['cache.db', blob]]));
    const { store, data } = fakeBlobStore();
    let metaCallCount = 0;
    // First metadata call returns wrong size; subsequent calls (after retry)
    // return real size.
    (store.getMetadata as jest.Mock).mockImplementation(async () => {
      metaCallCount += 1;
      if (metaCallCount === 1) return { size: 0, mtime: 0 };
      return data.value ? { size: data.value.byteLength, mtime: 1 } : null;
    });
    // Force first read fallback to return wrong buffer too.
    let readCallCount = 0;
    (store.read as jest.Mock).mockImplementation(async () => {
      readCallCount += 1;
      if (readCallCount === 1) return new ArrayBuffer(0);
      return data.value;
    });
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');
    expect(store.write).toHaveBeenCalledTimes(2);
  });

  it('runs the showNotices=true sticky+success path without throwing', async () => {
    // Notice is a real mock class; we can't easily spy on its constructor.
    // This test exercises the showNotices=true success branch (lines 175-178)
    // and asserts the outcome shape; Notice instantiation is exercised by code
    // execution alone.
    const blob = new Uint8Array(1024).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([['cache.db', blob]]));
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: true
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');
  });

  it('runs the showNotices=true failure path without throwing', async () => {
    // Failure-branch counterpart (lines 191-198).
    const blob = new Uint8Array(1024).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([['cache.db', blob]]));
    const { store } = fakeBlobStore();
    (store.write as jest.Mock).mockRejectedValue(new Error('IDB quota exceeded'));
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: true
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('failed');
  });

  it('reports a janitor list failure as a single failed entry under the root path', async () => {
    const blob = new Uint8Array(1024).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([['cache.db', blob]]));
    (adapter.list as jest.Mock).mockRejectedValue(new Error('EACCES'));
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');

    // Drain microtasks so fire-and-forget janitor lands.
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(result.janitor).toBeDefined();
    expect(result.janitor!.removed).toEqual([]);
    expect(result.janitor!.failed).toHaveLength(1);
    expect(result.janitor!.failed[0]).toEqual(expect.objectContaining({
      path: '.',
      error: expect.stringMatching(/list failed: EACCES/)
    }));
  });

  it('records per-file failures in the janitor report when remove() throws on the literal cache.db', async () => {
    const blob = new Uint8Array(1024).buffer;
    const { adapter } = fakeAdapter(new Map<string, ArrayBuffer>([
      ['cache.db', blob],
      ['cache 2.db', new ArrayBuffer(1)]
    ]));
    // Conflict deletion succeeds; literal deletion throws.
    (adapter.remove as jest.Mock).mockImplementation(async (path: string) => {
      if (path === 'cache.db') throw new Error('EBUSY');
      return undefined;
    });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    for (let i = 0; i < 8; i++) await Promise.resolve();

    expect(result.outcome).toBe('verified');
    expect(result.janitor!.removed).toContain('cache 2.db');
    expect(result.janitor!.failed).toEqual([
      expect.objectContaining({ path: 'cache.db', error: expect.stringMatching(/EBUSY/) })
    ]);
  });

  it('treats adapter.exists throw as legacy-absent (fresh-install short-circuit)', async () => {
    const { adapter } = fakeAdapter();
    (adapter.exists as jest.Mock).mockRejectedValue(new Error('I/O fault'));
    const { store } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('not_needed');
    expect(current.value?.backend).toBe('idb');
    expect(current.value?.migrationState).toBe('verified');
  });

  it('overrides prior failed state with verified+idb on a fresh-install short-circuit', async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor({
      backend: 'file',
      migrationState: 'failed',
      lastError: 'prior'
    });

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: false,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('not_needed');
    expect(current.value?.backend).toBe('idb');
    expect(current.value?.migrationState).toBe('verified');
    expect(current.value?.lastError).toBeUndefined();
  });
});
