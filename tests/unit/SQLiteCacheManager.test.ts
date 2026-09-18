import type { App } from 'obsidian';

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import { CURRENT_SCHEMA_VERSION } from '../../src/database/schema/SchemaMigrator';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';
import { SQLiteTransactionCoordinator } from '../../src/database/storage/SQLiteTransactionCoordinator';
import { SQLiteSyncStateStore } from '../../src/database/storage/SQLiteSyncStateStore';
import type { QueryParams } from '../../src/database/repositories/base/BaseRepository';

interface DatabaseLike {
  exec: jest.Mock<void, [string]>;
}

interface MutableSQLiteCacheManager extends SQLiteCacheManager {
  app: App & {
    vault: {
      adapter: {
        exists: jest.Mock<Promise<boolean>, [string]>;
        stat: jest.Mock<Promise<{ size?: number } | null>, [string]>;
      };
    };
  };
  bridge: {
    exec(db: DatabaseLike, sql: string): void;
  };
  transactionCoordinator: SQLiteTransactionCoordinator;
  syncStateStore: SQLiteSyncStateStore;
  db: DatabaseLike | null;
  hasUnsavedData: boolean;
  beginTransaction: jest.Mock<Promise<void>, []>;
  commit: jest.Mock<Promise<void>, []>;
  rollback: jest.Mock<Promise<void>, []>;
  queryOne: jest.Mock<Promise<unknown>, [string, QueryParams?]>;
  query: jest.Mock<Promise<unknown[]>, [string, QueryParams?]>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
}

function createManager(): MutableSQLiteCacheManager {
  const manager = Object.create(SQLiteCacheManager.prototype) as MutableSQLiteCacheManager;
  manager.bridge = {
    exec(db: DatabaseLike, sql: string) {
      db.exec(sql);
    }
  };
  manager.app = {
    vault: {
      adapter: {
        exists: jest.fn(),
        stat: jest.fn()
      }
    }
  } as unknown as MutableSQLiteCacheManager['app'];
  manager.transactionCoordinator = new SQLiteTransactionCoordinator();
  manager.db = null;
  manager.hasUnsavedData = false;
  manager.beginTransaction = jest.fn().mockResolvedValue(undefined);
  manager.commit = jest.fn().mockResolvedValue(undefined);
  manager.rollback = jest.fn().mockResolvedValue(undefined);
  manager.queryOne = jest.fn();
  manager.query = jest.fn();
  manager.syncStateStore = new SQLiteSyncStateStore(
    <T>(sql: string, params?: QueryParams) => manager.query(sql, params) as Promise<T[]>,
    <T>(sql: string, params?: QueryParams) => manager.queryOne(sql, params) as Promise<T | null>,
    async () => ({ changes: 0, lastInsertRowid: 0 })
  );
  return manager;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SQLiteCacheManager', () => {
  describe('transaction', () => {
    it('serializes concurrent top-level transactions', async () => {
      const manager = createManager();
      const firstGate = createDeferred<void>();
      const order: string[] = [];

      manager.beginTransaction.mockImplementation(async () => {
        order.push('begin');
      });
      manager.commit.mockImplementation(async () => {
        order.push('commit');
      });

      const first = manager.transaction(async () => {
        order.push('first-start');
        await firstGate.promise;
        order.push('first-end');
        return 'first';
      });

      const second = manager.transaction(async () => {
        order.push('second-start');
        return 'second';
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(order).toEqual(['begin', 'first-start']);

      firstGate.resolve();
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');

      expect(order).toEqual([
        'begin',
        'first-start',
        'first-end',
        'commit',
        'begin',
        'second-start',
        'commit'
      ]);
      expect(manager.beginTransaction).toHaveBeenCalledTimes(2);
      expect(manager.commit).toHaveBeenCalledTimes(2);
      expect(manager.rollback).not.toHaveBeenCalled();
    });

    it('serializes a transaction that starts after the first body has entered', async () => {
      const manager = createManager();
      const firstGate = createDeferred<void>();
      const firstStarted = createDeferred<void>();
      const order: string[] = [];

      manager.beginTransaction.mockImplementation(async () => {
        order.push('begin');
      });
      manager.commit.mockImplementation(async () => {
        order.push('commit');
      });

      const first = manager.transaction(async () => {
        order.push('first-start');
        firstStarted.resolve();
        await firstGate.promise;
        order.push('first-end');
      });

      await firstStarted.promise;

      const second = manager.transaction(async () => {
        order.push('second-start');
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(order).toEqual(['begin', 'first-start']);

      firstGate.resolve();
      await Promise.all([first, second]);

      expect(order).toEqual([
        'begin',
        'first-start',
        'first-end',
        'commit',
        'begin',
        'second-start',
        'commit'
      ]);
      expect(manager.beginTransaction).toHaveBeenCalledTimes(2);
      expect(manager.commit).toHaveBeenCalledTimes(2);
      expect(manager.rollback).not.toHaveBeenCalled();
    });

    it('rolls back when the transaction body throws', async () => {
      const manager = createManager();

      await expect(
        manager.transaction(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(manager.beginTransaction).toHaveBeenCalledTimes(1);
      expect(manager.commit).not.toHaveBeenCalled();
      expect(manager.rollback).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSyncState', () => {
    it('parses sync-state JSON and keeps only finite numeric timestamps', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue({
        deviceId: 'desktop',
        lastEventTimestamp: 123,
        syncedFilesJson: JSON.stringify({
          'workspaces/a.jsonl': 50,
          'conversations/b.jsonl': 'bad',
          'tasks/c.jsonl': Number.POSITIVE_INFINITY,
          'tasks/d.jsonl': 75
        })
      });

      const result = await manager.getSyncState('desktop');

      expect(manager.queryOne).toHaveBeenCalledWith(
        'SELECT deviceId, lastEventTimestamp, syncedFilesJson FROM sync_state WHERE deviceId = ?',
        ['desktop']
      );
      expect(result).toEqual({
        deviceId: 'desktop',
        lastEventTimestamp: 123,
        fileTimestamps: {
          'workspaces/a.jsonl': 50,
          'tasks/d.jsonl': 75
        }
      });
    });

    it('returns null when no sync-state row exists', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue(null);

      await expect(manager.getSyncState('desktop')).resolves.toBeNull();
    });
  });

  describe('queryPaginated', () => {
    it('computes pagination metadata and appends limit/offset params', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue({ count: 53 });
      manager.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

      const result = await manager.queryPaginated<{ id: string }>(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt',
        'SELECT COUNT(*) as count FROM messages WHERE conversationId = ?',
        { page: 1, pageSize: 25 },
        ['conv-1']
      );

      expect(manager.queryOne).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM messages WHERE conversationId = ?',
        ['conv-1']
      );
      expect(manager.query).toHaveBeenCalledWith(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt LIMIT ? OFFSET ?',
        ['conv-1', 25, 25]
      );
      expect(result).toEqual({
        items: [{ id: 'a' }, { id: 'b' }],
        page: 1,
        pageSize: 25,
        totalItems: 53,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true
      });
    });
  });

  describe('maintenance operations', () => {
    it('clearAllData deletes domain tables and recreates vector tables inside a transaction', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };
      const transactionSpy = jest
        .spyOn(manager, 'transaction')
        .mockImplementation(async <T>(fn: () => Promise<T>) => fn());

      await manager.clearAllData();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(dbExec).toHaveBeenCalledTimes(5);
      expect(dbExec.mock.calls[0][0]).toContain('DELETE FROM task_note_links;');
      expect(dbExec.mock.calls[0][0]).toContain('DELETE FROM sync_state;');
      expect(dbExec.mock.calls[1][0]).toBe('DROP TABLE IF EXISTS conversation_embeddings');
      expect(dbExec.mock.calls[2][0]).toBe('CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(embedding float[384])');
      expect(dbExec.mock.calls[3][0]).toBe('DELETE FROM conversation_embedding_metadata');
      expect(dbExec.mock.calls[4][0]).toBe('DELETE FROM embedding_backfill_state');
    });

    it('rebuildFTSIndexes issues rebuild statements inside a transaction', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };
      const transactionSpy = jest
        .spyOn(manager, 'transaction')
        .mockImplementation(async <T>(fn: () => Promise<T>) => fn());

      await manager.rebuildFTSIndexes();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(dbExec).toHaveBeenCalledTimes(3);
      expect(dbExec.mock.calls[0][0]).toContain("INSERT INTO workspace_fts(workspace_fts) VALUES ('rebuild');");
      expect(dbExec.mock.calls[1][0]).toContain("INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');");
      expect(dbExec.mock.calls[2][0]).toContain("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
    });

    it('vacuum marks the database dirty and executes VACUUM', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };

      await manager.vacuum();

      expect(dbExec).toHaveBeenCalledWith('VACUUM');
      expect(manager.hasUnsavedData).toBe(true);
    });
  });

  describe('statistics', () => {
    /**
     * One mock for both tests, matching on the exact table name rather than a
     * substring: `notes` and `note_properties` are now both counted, and a
     * loose `sql.includes('notes')` would answer for either and make the
     * assertion measure the mock.
     */
    function stubCounts(manager: MutableSQLiteCacheManager, counts: Record<string, number>): void {
      manager.queryOne.mockImplementation(async (sql: string) => {
        const pragma = /^PRAGMA (\w+)$/.exec(sql.trim());
        if (pragma) {
          const value = counts[`pragma:${pragma[1]}`];
          return value === undefined ? null : { [pragma[1]]: value };
        }
        if (sql.includes('sqlite_master')) return { count: counts.tables ?? 0 };
        const table = /FROM (\w+)/.exec(sql)?.[1];
        if (table && table in counts) return { count: counts[table] };
        return null;
      });
    }

    const baseCounts: Record<string, number> = {
      workspaces: 1,
      sessions: 2,
      states: 3,
      memory_traces: 4,
      conversations: 5,
      messages: 6,
      applied_events: 7,
      conversation_embedding_metadata: 8,
      notes: 9,
      note_properties: 10,
      embedding_metadata: 11,
      trace_embedding_metadata: 12,
      tables: 12,
      'pragma:page_count': 4000,
      'pragma:freelist_count': 250,
      'pragma:page_size': 4096
    };

    it('getStatistics returns row counts, page accounting and db file size', async () => {
      const manager = createManager();
      stubCounts(manager, baseCounts);
      manager.app.vault.adapter.exists.mockResolvedValue(true);
      manager.app.vault.adapter.stat.mockResolvedValue({ size: 4096 });

      await expect(manager.getStatistics()).resolves.toEqual({
        workspaces: 1,
        sessions: 2,
        states: 3,
        traces: 4,
        conversations: 5,
        messages: 6,
        appliedEvents: 7,
        conversationEmbeddings: 8,
        // Phase 0 size measurement: the tables section 6c of
        // docs/plans/sqlite-cache-persistence-plan.md says to look at first.
        notes: 9,
        noteProperties: 10,
        noteEmbeddings: 11,
        traceEmbeddings: 12,
        dbSizeBytes: 4096,
        pageCount: 4000,
        freelistCount: 250,
        pageSizeBytes: 4096
      });
    });

    // Diagnostics must never be the reason a startup path throws.
    // HybridStorageAdapter.shouldBlockStartupHydration calls getStatistics()
    // during init, and the notes tables arrived in migration v14, so a cache
    // opened before that migration runs does not have them.
    it('getStatistics survives tables and pragmas that are not there', async () => {
      const manager = createManager();
      manager.queryOne.mockImplementation(async (sql: string) => {
        if (/FROM (notes|note_properties)/.test(sql)) {
          throw new Error('no such table: notes');
        }
        if (sql.trim().startsWith('PRAGMA')) {
          throw new Error('unknown pragma');
        }
        return { count: 1 };
      });
      manager.app.vault.adapter.exists.mockResolvedValue(false);

      const stats = await manager.getStatistics();

      expect(stats.notes).toBe(0);
      expect(stats.noteProperties).toBe(0);
      expect(stats.pageCount).toBeNull();
      expect(stats.freelistCount).toBeNull();
      expect(stats.pageSizeBytes).toBeNull();
      // The counts that did answer still come through.
      expect(stats.workspaces).toBe(1);
    });

    it('getStats returns file stats and row totals', async () => {
      const manager = createManager();
      stubCounts(manager, baseCounts);
      manager.app.vault.adapter.exists.mockResolvedValue(true);
      manager.app.vault.adapter.stat.mockResolvedValue({ size: 4096 });

      await expect(manager.getStats()).resolves.toEqual({
        fileSize: 4096,
        tableCount: 12,
        totalRows: 1 + 2 + 3 + 4 + 5 + 6,
        tableCounts: {
          workspaces: 1,
          sessions: 2,
          states: 3,
          memory_traces: 4,
          conversations: 5,
          messages: 6,
          applied_events: 7,
          conversation_embedding_metadata: 8,
          notes: 9,
          note_properties: 10,
          embedding_metadata: 11,
          trace_embedding_metadata: 12
        },
        walMode: false
      });
    });

    /**
     * dbstat is the measurement that settles section 6c outright: it says which
     * table is actually holding the pages. `ENABLE_DBSTAT_VTAB` is in the
     * bundled sqlite3.wasm compile options, so this is expected to answer in
     * the real build.
     *
     * It is on its own method and NOT in getStatistics() on purpose: reading
     * dbstat walks every page, and getStatistics() is on a startup path.
     */
    it('getObjectPageUsage returns a per-object byte breakdown, largest first', async () => {
      const manager = createManager();
      manager.db = { exec: jest.fn() };
      manager.queryOne.mockResolvedValue({ page_size: 4096 });
      const bridgeQuery = jest.fn().mockReturnValue([
        { name: 'notes', pages: 20000, bytes: 81_920_000 },
        { name: 'messages', pages: 5000, bytes: 20_480_000 }
      ]);
      (manager as unknown as { bridge: { query: unknown } }).bridge.query = bridgeQuery;

      const usage = await manager.getObjectPageUsage();

      expect(bridgeQuery.mock.calls[0][1]).toContain('FROM dbstat');
      expect(usage).toEqual([
        { name: 'notes', pages: 20000, bytes: 81_920_000 },
        { name: 'messages', pages: 5000, bytes: 20_480_000 }
      ]);
    });

    it('getObjectPageUsage returns null when dbstat is not compiled in', async () => {
      const manager = createManager();
      manager.db = { exec: jest.fn() };
      manager.queryOne.mockResolvedValue({ page_size: 4096 });
      (manager as unknown as { bridge: { query: unknown } }).bridge.query = jest.fn(() => {
        throw new Error('no such table: dbstat');
      });

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await expect(manager.getObjectPageUsage()).resolves.toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});

// Started life as the Phase 0 characterization of the save path in
// docs/plans/sqlite-cache-persistence-plan.md. Phase 1 inverted four of the
// assertions here; each one says on itself what it used to pin and why.
describe('SQLiteCacheManager save path', () => {
  interface SaveHarness {
    manager: SQLiteCacheManager;
    /** Number of full-database exports performed since the harness was armed. */
    exportCount(): number;
    /** Buffers handed to the blob store since the harness was armed. */
    writtenBuffers(): ArrayBuffer[];
    /** Hold every subsequent blob store write open until released. */
    gateWrites(): void;
    /** Let every held write, and any that follow, complete. */
    releaseWrites(): void;
    /** Number of writes currently held open. */
    heldWriteCount(): number;
    dispose(): Promise<void>;
  }

  /** Let queued microtasks run without advancing fake timers. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
  }

  async function createSaveHarness(
    options: { autoSaveInterval?: number; existingBlobBytes?: number } = {}
  ): Promise<SaveHarness> {
    const exportedBuffers: ArrayBuffer[] = [];
    const writtenBuffers: ArrayBuffer[] = [];
    const held: Array<{ resolve: () => void }> = [];
    let gated = false;

    const dbHandle = {
      exec: jest.fn(),
      prepare: jest.fn(),
      close: jest.fn(),
      changes: jest.fn(() => 0),
      selectValue: jest.fn(() => 'ok')
    };

    const sqlite3 = { oo1: {}, wasm: {}, capi: {} };

    const bridge = {
      initializeModule: jest.fn(async () => sqlite3),
      createMemoryDatabase: jest.fn(() => dbHandle),
      deserializeDatabase: jest.fn(() => dbHandle),
      // A distinct buffer per call, so two overlapping saves are two live
      // allocations and not one shared object.
      exportDatabase: jest.fn(() => {
        const buffer = new ArrayBuffer(4096);
        exportedBuffers.push(buffer);
        return buffer;
      }),
      exec: jest.fn(),
      executeStatement: jest.fn(),
      // Answer the migrator that the schema is already current, so initialize()
      // performs exactly one save (the fresh-database one) and no migration save.
      collectValues: jest.fn((_db: unknown, sql: string) => {
        if (sql.includes("name='schema_version'")) return [['schema_version']];
        if (sql.includes('MAX(version)')) return [[CURRENT_SCHEMA_VERSION]];
        return [];
      }),
      query: jest.fn(() => []),
      queryOne: jest.fn(() => null),
      run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
      getIntegrityCheckResult: jest.fn(() => 'ok'),
      close: jest.fn()
    };

    // An existing cache, when the test asks for one, so the size the manager
    // reports at startup is the size the blob store said it was.
    const existingBlobBytes = options.existingBlobBytes ?? 0;
    const blobStore = {
      read: jest.fn(async () => (existingBlobBytes > 0 ? new ArrayBuffer(existingBlobBytes) : null)),
      write: jest.fn((buffer: ArrayBuffer) => {
        writtenBuffers.push(buffer);
        if (!gated) return Promise.resolve();
        return new Promise<void>(resolve => held.push({ resolve }));
      }),
      remove: jest.fn(async () => undefined),
      getMetadata: jest.fn(async () => (existingBlobBytes > 0 ? { size: existingBlobBytes } : null))
    };

    const app = {
      vault: {
        configDir: '.obsidian',
        adapter: {
          exists: jest.fn(async () => true),
          readBinary: jest.fn(async () => new ArrayBuffer(8)),
          mkdir: jest.fn(async () => undefined),
          stat: jest.fn(async () => ({ size: 0 }))
        }
      }
    } as unknown as App;

    const manager = new SQLiteCacheManager({
      app,
      dbPath: '.nexus/data/cache.db',
      autoSaveInterval: options.autoSaveInterval ?? 0,
      blobStore: blobStore as unknown as CacheBlobStore
    });

    // Swap in the fake WASM bridge before anything touches it. The persistence
    // service is rebuilt on the same fake so the export it performs is ours.
    const internals = manager as unknown as {
      bridge: unknown;
      persistenceService: SQLitePersistenceService;
    };
    internals.bridge = bridge;
    internals.persistenceService = new SQLitePersistenceService({
      blobStore: blobStore as unknown as CacheBlobStore,
      bridge: bridge as unknown as ConstructorParameters<typeof SQLitePersistenceService>[0]['bridge']
    });

    await manager.initialize();

    // initialize() performs the fresh-database save. Arm the counters after it
    // so every number below belongs to the test.
    exportedBuffers.length = 0;
    writtenBuffers.length = 0;

    return {
      manager,
      exportCount: () => exportedBuffers.length,
      writtenBuffers: () => writtenBuffers,
      gateWrites: () => { gated = true; },
      releaseWrites: () => {
        gated = false;
        while (held.length > 0) {
          held.shift()?.resolve();
        }
      },
      heldWriteCount: () => held.length,
      dispose: async () => {
        gated = false;
        while (held.length > 0) {
          held.shift()?.resolve();
        }
        manager.stopAutoSave();
      }
    };
  }

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // The save path reports the cache size once a minute; silence it so these
    // tests do not print.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  // PHASE 1 INVERTED THIS. It was pinned as `toBe(2)`: no in-flight guard, so
  // a second save() exported again while the first export's buffer was still
  // held by its pending write, which on a 150 MB cache is 300 MB of contiguous
  // allocation for one logical save. Option A's single-flight guard means the
  // second caller joins the running save instead, because no write has landed
  // since that save exported and its buffer therefore already holds everything
  // the second caller wants persisted.
  it('joins the in-flight save instead of exporting again when nothing has been written since', async () => {
    const harness = await createSaveHarness();
    try {
      harness.gateWrites();

      const first = harness.manager.save();
      await flushMicrotasks();
      expect(harness.exportCount()).toBe(1);

      const second = harness.manager.save();
      await flushMicrotasks();

      expect(harness.exportCount()).toBe(1);
      expect(harness.heldWriteCount()).toBe(1);
      expect(harness.writtenBuffers()).toHaveLength(1);

      harness.releaseWrites();
      await Promise.all([first, second]);

      // Both callers settle on the one save, which is the contract that lets
      // the autosave timer and a queue-driven save share an export.
      expect(harness.exportCount()).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  // The other half of the guard: when a write DID land since the running
  // export, the callers cannot be fobbed off with it, because those rows are
  // not in it. Exactly one follow-up is scheduled however many ask, so there
  // is never a second export alive alongside the first.
  it('schedules exactly one follow-up export however many callers ask during a save', async () => {
    const harness = await createSaveHarness();
    try {
      harness.gateWrites();

      const first = harness.manager.save();
      await flushMicrotasks();
      expect(harness.exportCount()).toBe(1);

      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['during-save']);

      const followers = [
        harness.manager.save(),
        harness.manager.save(),
        harness.manager.save()
      ];
      await flushMicrotasks();

      // Still one export: the follow-up cannot start until the running one has
      // let go of its buffer.
      expect(harness.exportCount()).toBe(1);
      expect(harness.heldWriteCount()).toBe(1);

      harness.releaseWrites();
      await Promise.all([first, ...followers]);
      await flushMicrotasks();

      // One follow-up for all three callers, not three.
      expect(harness.exportCount()).toBe(2);
      expect(harness.writtenBuffers()).toHaveLength(2);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  // The one real correctness risk in Phase 1, and the reason the follow-up is
  // cancellable at all. StorageMaintenanceService.rebuildCache calls
  // stopAutoSave(), then close(), then blobStore.remove(). A follow-up that
  // survived that sequence would write the old database straight back over the
  // rebuild, and the next launch would load a cache the user asked to be gone.
  it('never writes after close(), so a rebuild removing the blob cannot be undone', async () => {
    const harness = await createSaveHarness();
    try {
      harness.gateWrites();

      const first = harness.manager.save();
      await flushMicrotasks();

      // A write lands mid-save, so a follow-up is scheduled rather than the
      // in-flight promise being shared.
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['during-save']);
      const follower = harness.manager.save();
      await flushMicrotasks();

      // What rebuildCache does, in its order.
      harness.manager.stopAutoSave();
      harness.releaseWrites();
      await Promise.all([first, follower]);
      await flushMicrotasks();

      // The cancelled follow-up did not export.
      expect(harness.exportCount()).toBe(1);

      await harness.manager.close();
      // close() is still allowed to persist the outstanding write; that save
      // happens BEFORE the blob is removed, which is the safe order.
      const exportsAfterClose = harness.exportCount();
      expect(exportsAfterClose).toBe(2);

      // Nothing at all after close() returns. This is the assertion that says
      // blobStore.remove() stands.
      await flushMicrotasks();
      expect(harness.exportCount()).toBe(exportsAfterClose);
      expect(harness.writtenBuffers()).toHaveLength(exportsAfterClose);
    } finally {
      await harness.dispose();
    }
  });

  // PHASE 1 INVERTED THIS. It was pinned as a second export: the dirty flag is
  // cleared only after the awaited write returns, so mid-save it is still true
  // and the timer was guaranteed to fire a second full-size export rather than
  // skip. That is the source of the "Auto-save failed" lines interleaved with
  // the queue-path failures in the reported log. The flag still reads true
  // mid-save, deliberately, because there genuinely is unsaved work; what
  // changed is that the timer's save now joins the running one.
  it('does not let the autosave timer start a second export while a save is in flight', async () => {
    jest.useFakeTimers();
    const harness = await createSaveHarness({ autoSaveInterval: 1000 });
    try {
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['t1']);
      harness.gateWrites();

      const inFlight = harness.manager.save();
      await flushMicrotasks();
      expect(harness.exportCount()).toBe(1);

      // The reason the timer does not skip: the flag is still set because
      // saveToFile() only clears it after its await resolves.
      expect(harness.manager.hasUnsavedChanges()).toBe(true);

      jest.advanceTimersByTime(1000);
      await flushMicrotasks();

      expect(harness.exportCount()).toBe(1);
      expect(harness.heldWriteCount()).toBe(1);

      harness.releaseWrites();
      await inFlight;
      await flushMicrotasks();
    } finally {
      await harness.dispose();
    }
  });

  // PHASE 1 INVERTED THE LAST ASSERTION, from `toBe(false)` to `toBe(true)`.
  // This is section 6a of the plan: the lost-update window. saveToFile() used
  // to export, await the write, then clear the flag unconditionally, so a row
  // written during that await was not in the buffer that had just been
  // persisted yet was marked as saved. It was latent only because indexing
  // dirties the database again within milliseconds, and it becomes real data
  // loss the moment Phase 2 lengthens the save interval, which is why Phase 1
  // lands first. The write generation captured before the export and compared
  // after the write is what closes it.
  it('leaves a write that landed during an in-flight save marked as unsaved', async () => {
    const harness = await createSaveHarness();
    try {
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['before-save']);
      harness.gateWrites();

      const inFlight = harness.manager.save();
      await flushMicrotasks();
      const exportsAtSnapshot = harness.exportCount();

      // Lands after the export, before the write resolves. These bytes are in
      // no snapshot anywhere.
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['during-save']);
      expect(harness.manager.hasUnsavedChanges()).toBe(true);
      expect(harness.exportCount()).toBe(exportsAtSnapshot);

      harness.releaseWrites();
      await inFlight;

      // Those bytes are in no snapshot anywhere, so the flag has to keep
      // saying so: the autosave timer and close() both key off it.
      expect(harness.manager.hasUnsavedChanges()).toBe(true);
    } finally {
      await harness.dispose();
    }
  });

  // PHASE 1 INVERTED THIS. It is the consequence of the test above and the
  // reason that one is data loss rather than a curiosity: close() trusts the
  // flag. With the flag wrongly false, the final save was skipped, the rows
  // written during the last in-flight save were discarded when the handle
  // closed, and nothing was logged anywhere. It was pinned as "no extra
  // export"; the generation counter makes close() see the outstanding write
  // and persist it.
  it('performs the final save in close() for a write that landed during an in-flight save', async () => {
    const harness = await createSaveHarness();
    try {
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['before-save']);
      harness.gateWrites();

      const inFlight = harness.manager.save();
      await flushMicrotasks();
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['during-save']);

      harness.releaseWrites();
      await inFlight;

      const exportsBeforeClose = harness.exportCount();
      await harness.manager.close();

      // The row written mid-save is persisted on the way out instead of being
      // dropped in silence.
      expect(harness.exportCount()).toBe(exportsBeforeClose + 1);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
      expect(harness.manager.isReady()).toBe(false);
    } finally {
      await harness.dispose();
    }
  });

  /**
   * Phase 2 needs a size to scale the indexers' save cadence off, and it needs
   * it on a per-item path, so it has to be free. These two say where the
   * number comes from: the metadata initialize() already reads, and the byte
   * count the write already computed. No query, no pragma, no extra read.
   */
  it('reports the size of the blob it opened before anything has been saved', async () => {
    const existingBlobBytes = 8 * 1024 * 1024;
    const harness = await createSaveHarness({ existingBlobBytes });
    try {
      expect(harness.manager.getLastSavedBytes()).toBe(existingBlobBytes);
    } finally {
      await harness.dispose();
    }
  });

  it('reports the byte count of the last successful save once one has happened', async () => {
    const harness = await createSaveHarness({ existingBlobBytes: 8 * 1024 * 1024 });
    try {
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['t1']);
      await harness.manager.save();

      // The fake export is 4096 bytes, which is deliberately not the size the
      // blob store reported at startup, so this cannot pass on the seed.
      expect(harness.manager.getLastSavedBytes()).toBe(4096);
    } finally {
      await harness.dispose();
    }
  });

  it('reports the fresh database it wrote itself when there was no blob to open', async () => {
    const harness = await createSaveHarness();
    try {
      // No blob existed, so initialize() created and saved a fresh database:
      // the number is that save's, not a size invented from nowhere.
      expect(harness.manager.getLastSavedBytes()).toBe(4096);
    } finally {
      await harness.dispose();
    }
  });

  // The other half of the same branch, and the one that must stay true through
  // every phase: when there genuinely is unsaved work, close() saves it.
  it('performs the final save in close() when the flag says there is work outstanding', async () => {
    const harness = await createSaveHarness();
    try {
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['unsaved']);
      expect(harness.manager.hasUnsavedChanges()).toBe(true);

      await harness.manager.close();

      expect(harness.exportCount()).toBe(1);
      expect(harness.writtenBuffers()).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });
});
