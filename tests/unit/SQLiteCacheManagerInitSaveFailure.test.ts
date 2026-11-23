jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import type { App } from 'obsidian';

import { SQLiteCacheManager, isAllocationFailure } from '../../src/database/storage/SQLiteCacheManager';
import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import { CURRENT_SCHEMA_VERSION } from '../../src/database/schema/SchemaMigrator';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';
import { HybridStorageAdapter } from '../../src/database/adapters/HybridStorageAdapter';
import { StartupHydrationController } from '../../src/database/adapters/lifecycle/StartupHydrationController';
import { InitLifecycleController } from '../../src/database/adapters/lifecycle/InitLifecycleController';

/**
 * The shape sqlite3_js_db_export really throws when the WASM heap cannot hold
 * the serialized database: an SQLite3Error whose resultCode is the generic
 * SQLITE_ERROR (1), because the export passes the code as a string, and whose
 * message is the only place SQLITE_NOMEM appears.
 */
class FakeSQLite3Error extends Error {
  resultCode = 1;
  constructor(message: string) {
    super(message);
    this.name = 'SQLite3Error';
  }
}

function exportNomem(): Error {
  return new FakeSQLite3Error('Database serialization failed with code SQLITE_NOMEM');
}

interface InitHarness {
  manager: SQLiteCacheManager;
  exportAttempts(): number;
  exportCount(): number;
  failNextExports(error: Error, count: number): void;
  dispose(): void;
}

/**
 * A cache manager on a fake WASM bridge, built WITHOUT calling initialize(),
 * so a test can make the saves inside initialize() fail.
 *
 * existingBlobBytes > 0 opens an existing cache instead of creating one;
 * schemaVersion below CURRENT_SCHEMA_VERSION makes the migrator apply the
 * pending migrations, which is the path that triggers the post-migration save.
 */
function createInitHarness(options: {
  autoSaveInterval?: number;
  existingBlobBytes?: number;
  schemaVersion?: number;
} = {}): InitHarness {
  let attempts = 0;
  let exported = 0;
  let exportFailure: Error | null = null;
  let failuresRemaining = 0;
  const schemaVersion = options.schemaVersion ?? CURRENT_SCHEMA_VERSION;

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
    isAutocommit: jest.fn(() => true),
    exportDatabase: jest.fn(() => {
      attempts++;
      if (exportFailure && failuresRemaining > 0) {
        failuresRemaining--;
        throw exportFailure;
      }
      exported++;
      return new ArrayBuffer(4096);
    }),
    exec: jest.fn(),
    executeStatement: jest.fn(),
    collectValues: jest.fn((_db: unknown, sql: string) => {
      if (sql.includes("name='schema_version'")) return [['schema_version']];
      if (sql.includes('MAX(version)')) return [[schemaVersion]];
      return [];
    }),
    query: jest.fn(() => []),
    queryOne: jest.fn(() => null),
    run: jest.fn(() => ({ changes: 1, lastInsertRowid: 1 })),
    getIntegrityCheckResult: jest.fn(() => 'ok'),
    close: jest.fn()
  };

  const existingBlobBytes = options.existingBlobBytes ?? 0;
  const blobStore = {
    read: jest.fn(async () => (existingBlobBytes > 0 ? new ArrayBuffer(existingBlobBytes) : null)),
    write: jest.fn(async () => undefined),
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
  const internals = manager as unknown as {
    bridge: unknown;
    persistenceService: SQLitePersistenceService;
  };
  internals.bridge = bridge;
  internals.persistenceService = new SQLitePersistenceService({
    blobStore: blobStore as unknown as CacheBlobStore,
    bridge: bridge as unknown as ConstructorParameters<typeof SQLitePersistenceService>[0]['bridge']
  });

  return {
    manager,
    exportAttempts: () => attempts,
    exportCount: () => exported,
    failNextExports: (error, count) => {
      exportFailure = error;
      failuresRemaining = count;
    },
    dispose: () => manager.stopAutoSave()
  };
}

describe('SQLiteCacheManager initialize when its own save fails', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  it('stays usable when the fresh-database save runs out of WASM memory', async () => {
    const harness = createInitHarness();
    try {
      harness.failNextExports(exportNomem(), 1);
      await expect(harness.manager.initialize()).resolves.toBeUndefined();
      expect(harness.manager.isReady()).toBe(true);
      // Nothing was persisted, so the cache must still count as unsaved.
      expect(harness.manager.hasUnsavedChanges()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('stays usable when the save after migrating an existing cache runs out of WASM memory', async () => {
    const harness = createInitHarness({
      existingBlobBytes: 8192,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1
    });
    try {
      harness.failNextExports(exportNomem(), 1);
      await expect(harness.manager.initialize()).resolves.toBeUndefined();
      expect(harness.exportAttempts()).toBe(1);
      expect(harness.manager.isReady()).toBe(true);
      // The migration changed the database and that change is not on disk.
      expect(harness.manager.hasUnsavedChanges()).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  it('persists the migrated database on the next save that succeeds', async () => {
    const harness = createInitHarness({
      existingBlobBytes: 8192,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1
    });
    try {
      harness.failNextExports(exportNomem(), 1);
      await harness.manager.initialize();
      await harness.manager.save();
      expect(harness.exportCount()).toBe(1);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('leaves nothing unsaved when the post-migration save succeeds', async () => {
    const harness = createInitHarness({
      existingBlobBytes: 8192,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1
    });
    try {
      await harness.manager.initialize();
      // The post-migration save went through, so nothing is outstanding.
      expect(harness.exportCount()).toBe(1);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('does not let auto-save retry the export before the allocation back-off elapses', async () => {
    jest.useFakeTimers();
    const harness = createInitHarness({
      autoSaveInterval: 1000,
      existingBlobBytes: 8192,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1
    });
    try {
      harness.failNextExports(exportNomem(), 1);
      await harness.manager.initialize();
      expect(harness.exportAttempts()).toBe(1);

      // First back-off step is two minutes; ticks before it must not export.
      await jest.advanceTimersByTimeAsync(119000);
      expect(harness.exportAttempts()).toBe(1);

      await jest.advanceTimersByTimeAsync(2000);
      expect(harness.exportAttempts()).toBe(2);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('backs off auto-save after an SQLITE_NOMEM export failure at runtime', async () => {
    jest.useFakeTimers();
    const harness = createInitHarness({ autoSaveInterval: 1000 });
    try {
      await harness.manager.initialize();
      harness.failNextExports(exportNomem(), 1);
      await harness.manager.run('INSERT INTO memory_traces (id) VALUES (?)', ['t1']);

      await jest.advanceTimersByTimeAsync(1000);
      const afterFailure = harness.exportAttempts();
      expect(harness.manager.hasUnsavedChanges()).toBe(true);

      await jest.advanceTimersByTimeAsync(118000);
      expect(harness.exportAttempts()).toBe(afterFailure);

      await jest.advanceTimersByTimeAsync(2000);
      expect(harness.exportAttempts()).toBe(afterFailure + 1);
      expect(harness.manager.hasUnsavedChanges()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('leaves the storage adapter query-ready when the cache could not save during startup', async () => {
    const harness = createInitHarness({
      existingBlobBytes: 8192,
      schemaVersion: CURRENT_SCHEMA_VERSION - 1
    });
    try {
      harness.failNextExports(exportNomem(), 1);
      const adapter = Object.create(HybridStorageAdapter.prototype) as HybridStorageAdapter & {
        hydration: StartupHydrationController;
        initLifecycle: InitLifecycleController;
      };
      adapter.hydration = new StartupHydrationController();
      adapter.initLifecycle = new InitLifecycleController();
      // The adapter's own startup awaits the cache's initialize() inside its
      // lifecycle; a rejection there is what left the adapter failed for good.
      void adapter.initLifecycle
        .run(() => harness.manager.initialize(), { blocking: false })
        .catch(() => undefined);

      await expect(adapter.waitForQueryReady(1000)).resolves.toBe(true);
      expect(adapter.isQueryReady()).toBe(true);
    } finally {
      harness.dispose();
    }
  });
});

describe('isAllocationFailure', () => {
  it('recognises both shapes an out-of-memory export takes', () => {
    expect(isAllocationFailure(new RangeError('Array buffer allocation failed'))).toBe(true);
    expect(isAllocationFailure(exportNomem())).toBe(true);
    expect(isAllocationFailure(Object.assign(new Error('out of memory'), { resultCode: 7 }))).toBe(true);
  });

  it('leaves other failures to the normal cadence', () => {
    expect(isAllocationFailure(new RangeError('Invalid array length'))).toBe(false);
    expect(isAllocationFailure(new FakeSQLite3Error('Database serialization failed with code SQLITE_IOERR'))).toBe(false);
    expect(isAllocationFailure(new Error('disk full'))).toBe(false);
    expect(isAllocationFailure(undefined)).toBe(false);
  });
});
