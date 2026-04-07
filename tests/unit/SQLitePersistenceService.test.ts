import type { App } from 'obsidian';

import { SQLitePersistenceService } from '../../src/database/storage/SQLitePersistenceService';
import type {
  SQLiteDatabaseHandle,
  SQLiteWasmBridge,
  SQLiteWasmModule
} from '../../src/database/storage/SQLiteWasmBridge';

interface MockAdapter {
  readBinary: jest.Mock<Promise<ArrayBuffer>, [string]>;
  writeBinary: jest.Mock<Promise<void>, [string, ArrayBuffer]>;
  remove: jest.Mock<Promise<void>, [string]>;
}

function createService() {
  const adapter: MockAdapter = {
    readBinary: jest.fn(),
    writeBinary: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined)
  };

  const app = {
    vault: {
      adapter
    }
  } as unknown as App;

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
    service: new SQLitePersistenceService({
      app,
      dbPath: '.nexus/cache.db',
      bridge
    }),
    adapter,
    bridge,
    db,
    sqlite3
  };
}

describe('SQLitePersistenceService', () => {
  it('creates a fresh schema database when the file is empty', async () => {
    const { service, adapter, bridge, db, sqlite3 } = createService();
    adapter.readBinary.mockResolvedValue(new ArrayBuffer(0));

    const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

    expect(result).toBe(db);
    expect(bridge.createMemoryDatabase).toHaveBeenCalledWith(sqlite3);
    expect(bridge.exec).toHaveBeenCalledWith(db, 'CREATE TABLE test (id TEXT);');
    expect(bridge.deserializeDatabase).not.toHaveBeenCalled();
  });

  it('exports the database buffer to the vault adapter on save', async () => {
    const { service, adapter, bridge, db, sqlite3 } = createService();

    await service.saveDatabase(sqlite3, db);

    expect(bridge.exportDatabase).toHaveBeenCalledWith(sqlite3, db);
    expect(adapter.writeBinary).toHaveBeenCalledWith('.nexus/cache.db', expect.any(ArrayBuffer));
  });

  it('recreates the database when integrity check fails', async () => {
    const { service, adapter, bridge, db, sqlite3 } = createService();
    adapter.readBinary.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
    bridge.getIntegrityCheckResult = jest.fn().mockReturnValue('corrupt') as typeof bridge.getIntegrityCheckResult;

    const result = await service.loadDatabase(sqlite3, 'CREATE TABLE test (id TEXT);');

    expect(result).toBe(db);
    expect(adapter.remove).toHaveBeenCalledWith('.nexus/cache.db');
    expect(adapter.writeBinary).toHaveBeenCalledWith('.nexus/cache.db', expect.any(ArrayBuffer));
  });
});
