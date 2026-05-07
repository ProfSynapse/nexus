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

    const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

    expect(result).toBe(db);
    expect(blobStore.remove).toHaveBeenCalled();
    expect(blobStore.write).toHaveBeenCalledWith(expect.any(ArrayBuffer));
  });
});
