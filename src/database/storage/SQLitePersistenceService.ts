import type { CacheBlobStore } from './CacheBlobStore';
import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';

interface SQLitePersistenceServiceOptions {
  blobStore: CacheBlobStore;
  bridge: SQLiteWasmBridge;
}

export class SQLitePersistenceService {
  private readonly bridge: SQLiteWasmBridge;
  private readonly blobStore: CacheBlobStore;

  constructor(options: SQLitePersistenceServiceOptions) {
    this.blobStore = options.blobStore;
    this.bridge = options.bridge;
  }

  async loadDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      const data = await this.blobStore.read();

      if (!data || data.byteLength === 0) {
        return this.createFreshDatabase(sqlite3, schemaSql);
      }

      const db = this.bridge.deserializeDatabase(sqlite3, new Uint8Array(data));

      try {
        const integrityResult = this.bridge.getIntegrityCheckResult(db);
        if (integrityResult !== 'ok') {
          const integrityMessage = typeof integrityResult === 'string'
            ? integrityResult
            : JSON.stringify(integrityResult) ?? 'unknown';
          throw new Error(`Database integrity check failed: ${integrityMessage}`);
        }
      } catch {
        return this.recreateCorruptedDatabase(sqlite3, schemaSql);
      }

      return db;
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to load from blob store:', error);
      return this.recreateCorruptedDatabase(sqlite3, schemaSql);
    }
  }

  async saveDatabase(sqlite3: SQLiteWasmModule, db: SQLiteDatabaseHandle): Promise<void> {
    try {
      const consoleRef = console;
      const originalLog = consoleRef.log;
      consoleRef.log = () => undefined;

      let buffer: ArrayBuffer;
      try {
        buffer = this.bridge.exportDatabase(sqlite3, db);
      } finally {
        consoleRef.log = originalLog;
      }

      await this.blobStore.write(buffer);
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save to blob store:', error);
      throw error;
    }
  }

  async recreateCorruptedDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      await this.blobStore.remove();
    } catch {
      void 0;
    }

    const db = this.createFreshDatabase(sqlite3, schemaSql);
    await this.saveDatabase(sqlite3, db);
    return db;
  }

  createFreshDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): SQLiteDatabaseHandle {
    const db = this.bridge.createMemoryDatabase(sqlite3);
    this.bridge.exec(db, schemaSql);
    return db;
  }
}
