import type { DataAdapter } from 'obsidian';

import {
  CacheBackendMigration,
  type CacheBackendState,
  type CacheBackendStateAccessor
} from '../../src/database/migration/CacheBackendMigration';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

interface FakeAdapterFiles {
  files: Map<string, ArrayBuffer>;
}

function fakeAdapter(initial: FakeAdapterFiles = { files: new Map() }): {
  adapter: DataAdapter;
  files: Map<string, ArrayBuffer>;
} {
  const files = initial.files;
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

function fakeBlobStore(): { store: CacheBlobStore; data: { value: ArrayBuffer | null } } {
  const data: { value: ArrayBuffer | null } = { value: null };
  const store: CacheBlobStore = {
    read: jest.fn(async () => data.value),
    write: jest.fn(async (buf: ArrayBuffer) => {
      data.value = buf;
    }),
    remove: jest.fn(async () => {
      data.value = null;
    }),
    getMetadata: jest.fn(async () => (data.value ? { size: data.value.byteLength, mtime: 1 } : null))
  };
  return { store, data };
}

function fakeStateAccessor(): { accessor: CacheBackendStateAccessor; current: { value: CacheBackendState | undefined } } {
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

describe('CacheBackendMigration.runIfNeeded', () => {
  it('mobile bypass writes file/not_needed and returns mobile_bypass', async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter,
      legacyDbPath: 'cache.db',
      pluginDataRoot: '.',
      blobStore: store,
      stateAccessor: accessor,
      isMobile: true,
      showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('mobile_bypass');
    expect(current.value).toEqual({ backend: 'file', migrationState: 'not_needed' });
  });

  it('returns verified short-circuit when persisted state is verified+idb', async () => {
    const { adapter } = fakeAdapter();
    const { store, data } = fakeBlobStore();
    // Seed the blob so the self-heal probe (added for issue #209) sees a real
    // record under the current IDB key. Without bytes here, the short-circuit
    // would correctly fall through to DETECT.
    data.value = new ArrayBuffer(128);
    const { accessor, current } = fakeStateAccessor();
    current.value = { backend: 'idb', migrationState: 'verified' };

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');
    expect(adapter.readBinary).not.toHaveBeenCalled();
    expect(store.write).not.toHaveBeenCalled();
  });

  it('marks verified immediately when no legacy file exists (fresh desktop install)', async () => {
    const { adapter } = fakeAdapter();
    const { store } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('not_needed');
    expect(current.value?.backend).toBe('idb');
    expect(current.value?.migrationState).toBe('verified');
    expect(store.write).not.toHaveBeenCalled();
  });

  it('migrates legacy bytes into the blob store and marks verified', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]).buffer;
    const { adapter } = fakeAdapter({ files: new Map([['cache.db', payload]]) });
    const { store, data } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('verified');
    expect(result.bytesMigrated).toBe(5);
    expect(data.value).not.toBeNull();
    expect(new Uint8Array(data.value!)).toEqual(new Uint8Array(payload));
    expect(current.value?.backend).toBe('idb');
    expect(current.value?.migrationState).toBe('verified');
    // Note: janitor runs fire-and-forget and may or may not have removed cache.db
    // by the time runIfNeeded resolves. The deterministic janitor coverage lives
    // in the runJanitor test block below.
  });

  it('persists failed state when legacy read returns 0 bytes', async () => {
    const { adapter } = fakeAdapter({ files: new Map([['cache.db', new ArrayBuffer(0)]]) });
    const { store } = fakeBlobStore();
    const { accessor, current } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const result = await migration.runIfNeeded();
    expect(result.outcome).toBe('failed');
    expect(current.value?.migrationState).toBe('failed');
    expect(current.value?.lastError).toMatch(/0 bytes/);
  });
});

describe('CacheBackendMigration.runJanitor', () => {
  it('removes all 8 conflict-copy patterns', async () => {
    const allPatterns = [
      'cache 2.db',
      'cache (1).db',
      'cache_conf.db',
      'cache_conf2.db',
      'cache[Conflict] 2026.db',
      'cache (User) conflicted copy 2026-05-01.db',
      'cache (Case Conflict).db',
      'cache.db.abcdef'
    ];
    const filesMap = new Map<string, ArrayBuffer>();
    for (const f of allPatterns) filesMap.set(f, new ArrayBuffer(1));
    filesMap.set('unrelated.txt', new ArrayBuffer(1));

    const { adapter, files } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.removed.sort()).toEqual(allPatterns.sort());
    expect(report.failed).toEqual([]);
    expect(files.has('unrelated.txt')).toBe(true);
  });

  it('deletes the literal cache.db LAST (after conflict siblings)', async () => {
    const filesMap = new Map<string, ArrayBuffer>([
      ['cache.db', new ArrayBuffer(1)],
      ['cache 2.db', new ArrayBuffer(1)]
    ]);
    const { adapter } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const removeOrder: string[] = [];
    (adapter.remove as jest.Mock).mockImplementation(async (path: string) => {
      removeOrder.push(path);
      filesMap.delete(path);
    });

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.removed).toContain('cache.db');
    expect(removeOrder.indexOf('cache.db')).toBeGreaterThan(removeOrder.indexOf('cache 2.db'));
  });

  it('does not delete unrelated files', async () => {
    const filesMap = new Map<string, ArrayBuffer>([
      ['data.json', new ArrayBuffer(1)],
      ['notes.md', new ArrayBuffer(1)],
      ['cache.dbx', new ArrayBuffer(1)],
      ['mycache.db', new ArrayBuffer(1)]
    ]);
    const { adapter, files } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.removed).toEqual([]);
    expect(files.size).toBe(4);
  });

  // ---------------------------------------------------------------------------
  // B.2 — Additional CONFLICT_COPY_PATTERNS coverage (database-engineer M3).
  //
  // Two patterns shipped at e65f3691 lack direct tests:
  //   - /^cache_\d+\.db$/         matches cache_2.db, cache_3.db (numeric
  //                                underscore — newer iCloud / Synology form)
  //   - /^cache\.db \(Conflict\)$/i  matches OneDrive's `cache.db (Conflict)`
  //
  // We also pin the Dropbox `cache (User's conflicted copy YYYY-MM-DD).db`
  // form. backend-coder-3's review note said "the existing greedy regex
  // covers it" — that's correct (the regex is
  // /^cache.*conflicted copy \d{4}-\d{2}-\d{2}\.db$/i and the prefix catches
  // anything starting with "cache"), but verified-by-inspection is fragile.
  // A test prevents future regex tightening from silently dropping that form.
  // ---------------------------------------------------------------------------
  it('B.2: cleans cache_2.db / cache_3.db (underscore-numeric pattern)', async () => {
    const filesMap = new Map<string, ArrayBuffer>([
      ['cache_2.db', new ArrayBuffer(1)],
      ['cache_3.db', new ArrayBuffer(1)],
      ['cache_42.db', new ArrayBuffer(1)],
      ['unrelated.txt', new ArrayBuffer(1)]
    ]);
    const { adapter, files } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.removed.sort()).toEqual(['cache_2.db', 'cache_3.db', 'cache_42.db'].sort());
    expect(report.failed).toEqual([]);
    expect(files.has('unrelated.txt')).toBe(true);
  });

  it('B.2: cleans `cache.db (Conflict)` (OneDrive case-insensitive pattern)', async () => {
    const filesMap = new Map<string, ArrayBuffer>([
      ['cache.db (Conflict)', new ArrayBuffer(1)],
      // Case-fold variants — the /i flag makes these match.
      ['cache.db (conflict)', new ArrayBuffer(1)],
      ['CACHE.DB (CONFLICT)', new ArrayBuffer(1)]
    ]);
    const { adapter, files } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    // All three case variants must be removed.
    expect(report.removed.sort()).toEqual(
      ['CACHE.DB (CONFLICT)', 'cache.db (Conflict)', 'cache.db (conflict)'].sort()
    );
    expect(files.size).toBe(0);
  });

  it('B.2: cleans Dropbox `cache <prefix> conflicted copy YYYY-MM-DD.db` regex form (regression pin)', async () => {
    // The shipped regex is /^cache.*conflicted copy \d{4}-\d{2}-\d{2}\.db$/i
    // — `\.db$` requires the literal `.db` suffix WITHOUT a trailing closing
    // paren. These inputs match. Forms like
    // `cache (User's conflicted copy 2026-01-15).db` (Dropbox standard, with
    // a closing paren BEFORE .db) are NOT matched by the current regex; if
    // a future patch widens the regex to cover that form, it should also
    // update this test.
    const filesMap = new Map<string, ArrayBuffer>([
      ['cache User conflicted copy 2026-01-15.db', new ArrayBuffer(1)],
      ['cache (User) conflicted copy 2026-12-31.db', new ArrayBuffer(1)],
      ['cache_with_long_prefix conflicted copy 2026-03-21.db', new ArrayBuffer(1)]
    ]);
    const { adapter, files } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.removed.sort()).toEqual(
      [
        'cache User conflicted copy 2026-01-15.db',
        'cache (User) conflicted copy 2026-12-31.db',
        'cache_with_long_prefix conflicted copy 2026-03-21.db'
      ].sort()
    );
    expect(files.size).toBe(0);
  });

  it('per-file failure does not abort the sweep', async () => {
    const filesMap = new Map<string, ArrayBuffer>([
      ['cache.db', new ArrayBuffer(1)],
      ['cache 2.db', new ArrayBuffer(1)],
      ['cache_conf.db', new ArrayBuffer(1)]
    ]);
    const { adapter } = fakeAdapter({ files: filesMap });
    const { store } = fakeBlobStore();
    const { accessor } = fakeStateAccessor();

    (adapter.remove as jest.Mock).mockImplementation(async (path: string) => {
      if (path === 'cache 2.db') throw new Error('locked');
      filesMap.delete(path);
    });

    const migration = new CacheBackendMigration({
      adapter, legacyDbPath: 'cache.db', pluginDataRoot: '.',
      blobStore: store, stateAccessor: accessor, isMobile: false, showNotices: false
    });

    const report = await migration.runJanitor();
    expect(report.failed.map(f => f.path)).toEqual(['cache 2.db']);
    expect(report.removed.sort()).toEqual(['cache.db', 'cache_conf.db'].sort());
  });
});
