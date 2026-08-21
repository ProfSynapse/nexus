import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import type {
  SQLiteDatabaseHandle,
  SQLiteWasmBridge,
  SQLiteWasmModule
} from '../../src/database/storage/SQLiteWasmBridge';
import type { CacheBlobStore } from '../../src/database/storage/CacheBlobStore';

interface MockBlobStore extends CacheBlobStore {
  read: jest.Mock<Promise<ArrayBuffer | null>, []>;
  write: jest.Mock<Promise<void>, [ArrayBuffer]>;
  remove: jest.Mock<Promise<void>, []>;
  getMetadata: jest.Mock<Promise<{ size: number; mtime?: number } | null>, []>;
}

function createService() {
  const blobStore: MockBlobStore = {
    read: jest.fn().mockResolvedValue(null),
    write: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    getMetadata: jest.fn().mockResolvedValue(null)
  };

  const db = {
    exec: jest.fn<void, [string]>(),
    prepare: jest.fn(),
    close: jest.fn(),
    changes: jest.fn(),
    selectValue: jest.fn()
  } as unknown as SQLiteDatabaseHandle;

  const bridge = {
    createMemoryDatabase: jest.fn().mockReturnValue(db),
    exec: jest.fn(),
    exportDatabase: jest.fn().mockReturnValue(new ArrayBuffer(8)),
    deserializeDatabase: jest.fn().mockReturnValue(db),
    getIntegrityCheckResult: jest.fn().mockReturnValue('ok')
  } as unknown as SQLiteWasmBridge;

  const sqlite3 = {} as SQLiteWasmModule;

  return {
    service: new SQLitePersistenceService({ blobStore, bridge }),
    blobStore,
    bridge,
    db,
    sqlite3
  };
}

describe('SQLitePersistenceService', () => {
  it('creates a fresh schema database when the blob store has no data', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();
    blobStore.read.mockResolvedValue(null);

    const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

    expect(result).toBe(db);
    expect(bridge.createMemoryDatabase).toHaveBeenCalledWith(sqlite3);
    expect(bridge.exec).toHaveBeenCalledWith(db, 'CREATE TABLE test (id TEXT);');
    expect(bridge.deserializeDatabase).not.toHaveBeenCalled();
  });

  it('writes the exported buffer to the blob store on save', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();

    await service.saveDatabase(sqlite3, db);

    expect(bridge.exportDatabase).toHaveBeenCalledWith(sqlite3, db);
    expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });

  it('recreates the database when integrity check fails', async () => {
    const { service, blobStore, bridge, db, sqlite3 } = createService();
    blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;

    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

      expect(result).toBe(db);
      expect(blobStore.remove).toHaveBeenCalled();
      expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    } finally {
      errSpy.mockRestore();
    }
  });

  // Regression (#209): this recovery ran inside a bare `catch {}`. The cache was
  // discarded and rebuilt with nothing written to the console, so the reporter's
  // log showed only the downstream symptom and the cause stayed invisible for
  // months. The rebuild must announce itself.
  describe('corrupt-cache recovery is observable', () => {
    function messagesFrom(spy: jest.SpyInstance): string {
      return spy.mock.calls
        .map(call => call.map(arg => (arg instanceof Error ? arg.message : String(arg))).join(' '))
        .join('\n');
    }

    it('logs the integrity failure, its cause and the rebuild-from-event-store consequence', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]).buffer);
      bridge.getIntegrityCheckResult = jest.fn()
        .mockReturnValue('*** in database main ***\nPage 3 is never used') as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        expect(errSpy).toHaveBeenCalled();
        const logged = messagesFrom(errSpy);
        expect(logged).toContain('integrity check failed');
        expect(logged).toContain('rebuilding it from scratch');
        // The sqlite integrity_check output must survive into the log — it is
        // the only clue about what actually went wrong.
        expect(logged).toContain('Page 3 is never used');
        // And the user has to be told their data is not gone.
        expect(logged).toContain('event store');
        expect(logged).toContain('5 bytes');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('logs when the integrity check itself throws rather than returning a verdict', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.getIntegrityCheckResult = jest.fn(() => {
        throw new Error('database disk image is malformed');
      }) as typeof bridge.getIntegrityCheckResult;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        const logged = messagesFrom(errSpy);
        expect(logged).toContain('integrity check failed');
        expect(logged).toContain('database disk image is malformed');
        expect(logged).toContain('event store');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('logs when the blob cannot be deserialized at all', async () => {
      const { service, blobStore, bridge, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.deserializeDatabase = jest.fn(() => {
        throw new Error('not a database');
      }) as typeof bridge.deserializeDatabase;

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        const logged = messagesFrom(errSpy);
        expect(logged).toContain('not a database');
        expect(logged).toContain('rebuilding it from scratch');
        expect(logged).toContain('event store');
      } finally {
        errSpy.mockRestore();
      }
    });

    it('warns but still rebuilds when the corrupt blob cannot be deleted', async () => {
      const { service, blobStore, bridge, db, sqlite3 } = createService();
      blobStore.read.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
      bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;
      blobStore.remove.mockRejectedValue(new Error('EPERM: operation not permitted'));

      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

        // Behaviour unchanged: the rebuild still happens.
        expect(result).toBe(db);
        expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));

        const warned = messagesFrom(warnSpy);
        expect(warned).toContain('EPERM: operation not permitted');
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
      }
    });
  });
});
