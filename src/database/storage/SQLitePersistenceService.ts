import { App } from 'obsidian';

import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';

interface SQLitePersistenceServiceOptions {
  app: App;
  dbPath: string;
  bridge: SQLiteWasmBridge;
}

export class SQLitePersistenceService {
  private readonly app: App;
  private dbPath: string;
  private readonly bridge: SQLiteWasmBridge;

  constructor(options: SQLitePersistenceServiceOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.bridge = options.bridge;
  }

  setDbPath(dbPath: string): void {
    this.dbPath = dbPath;
  }

  async loadDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      const data = await this.app.vault.adapter.readBinary(this.dbPath);
      const bytes = new Uint8Array(data);

      if (bytes.length === 0) {
        return this.createFreshDatabase(sqlite3, schemaSql);
      }

      const db = this.bridge.deserializeDatabase(sqlite3, bytes);

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
      console.error('[SQLiteCacheManager] Failed to load from file:', error);
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

      await this.app.vault.adapter.writeBinary(this.dbPath, buffer);
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save to file:', error);
      throw error;
    }
  }

  async recreateCorruptedDatabase(sqlite3: SQLiteWasmModule, schemaSql: string): Promise<SQLiteDatabaseHandle> {
    try {
      await this.app.vault.adapter.remove(this.dbPath);
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
