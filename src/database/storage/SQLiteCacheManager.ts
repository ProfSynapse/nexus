/**
 * Location: src/database/storage/SQLiteCacheManager.ts
 * Purpose: SQLite cache manager using @dao-xyz/sqlite3-vec WASM for hybrid storage system
 *
 * Provides:
 * - Local cache for fast queries and true pagination
 * - Native vector search via sqlite-vec (compiled into WASM)
 * - Manual file persistence via serialize/deserialize (Obsidian Sync compatible)
 * - Full-text search via FTS4
 * - Transaction support
 * - Event tracking to prevent duplicate processing
 *
 * Relationships:
 * - Used by StorageManager for fast queries
 * - Backed by JSONL files in EventLogManager
 * - Implements IStorageBackend interface
 *
 * Architecture Notes:
 * - Uses WASM build of SQLite with sqlite-vec statically compiled
 * - In-memory database with manual file persistence
 * - sqlite3_js_db_export() to serialize, sqlite3_deserialize() to load
 * - Works in Electron renderer (no native bindings)
 */

import { App } from 'obsidian';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { IStorageBackend, RunResult, DatabaseStats } from '../interfaces/IStorageBackend';
import type { SyncState, ISQLiteCacheManager } from '../sync/SyncCoordinator';
import { SQLiteSearchService } from './SQLiteSearchService';
import { QueryParams } from '../repositories/base/BaseRepository';
import {
  SQLiteWasmBridge,
  SQLiteWasmModule,
  SQLiteDatabaseHandle
} from './SQLiteWasmBridge';
import { SQLiteTransactionCoordinator } from './SQLiteTransactionCoordinator';
import { SQLiteSyncStateStore } from './SQLiteSyncStateStore';
import { SQLitePersistenceService } from './SQLitePersistenceService';
import { SQLiteMaintenanceService, SQLiteMaintenanceStatistics } from './SQLiteMaintenanceService';

// Import schema from TypeScript module (esbuild compatible)
import { SCHEMA_SQL } from '../schema/schema';
import { SchemaMigrator } from '../schema/SchemaMigrator';

export interface SQLiteCacheManagerOptions {
  app: App;
  dbPath: string;  // e.g., '.nexus/cache.db'
  wasmPath?: string;
  autoSaveInterval?: number;  // ms between auto-saves (default: 30000)
}

export interface QueryResult<T> {
  items: T[];
  totalCount?: number;
}

/**
 * Database adapter that wraps raw WASM SQLite database to provide
 * exec() and run() methods for MigratableDatabase interface.
 */
class DatabaseAdapter {
  constructor(
    private readonly bridge: SQLiteWasmBridge,
    private readonly rawDb: SQLiteDatabaseHandle
  ) {}

  exec(sql: string): { values: unknown[][] }[] {
    const results = this.bridge.collectValues(this.rawDb, sql);
    return results.length > 0 ? [{ values: results }] : [];
  }

  run(sql: string, params?: QueryParams): void {
    this.bridge.executeStatement(this.rawDb, sql, params);
  }
}

/**
 * SQLite cache manager using @dao-xyz/sqlite3-vec WASM
 *
 * Features:
 * - SQLite + sqlite-vec via WASM (no native bindings)
 * - Manual file persistence via serialize/deserialize
 * - Native vector search for embeddings
 * - Full-text search with FTS4
 * - Cursor-based pagination
 * - Transaction support
 */
export class SQLiteCacheManager implements IStorageBackend, ISQLiteCacheManager {
  private app: App;
  private dbPath: string;  // Relative path within vault
  private wasmPath?: string;
  private readonly bridge: SQLiteWasmBridge;
  private sqlite3: SQLiteWasmModule | null = null;  // The sqlite3 WASM module
  private db: SQLiteDatabaseHandle | null = null;  // The oo1.DB instance
  private isInitialized = false;
  private searchService: SQLiteSearchService;
  private hasUnsavedData = false;
  private autoSaveInterval: number;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private readonly transactionCoordinator: SQLiteTransactionCoordinator;
  private readonly syncStateStore: SQLiteSyncStateStore;
  private readonly persistenceService: SQLitePersistenceService;
  private maintenanceService?: SQLiteMaintenanceService;

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.wasmPath = options.wasmPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;  // 30 seconds default
    this.bridge = new SQLiteWasmBridge();
    this.transactionCoordinator = new SQLiteTransactionCoordinator();
    this.persistenceService = new SQLitePersistenceService({
      app: this.app,
      dbPath: this.dbPath,
      bridge: this.bridge
    });
    this.syncStateStore = new SQLiteSyncStateStore(
      <T>(sql: string, params?: QueryParams) => this.query<T>(sql, params),
      <T>(sql: string, params?: QueryParams) => this.queryOne<T>(sql, params),
      (sql: string, params?: QueryParams) => this.run(sql, params)
    );
    this.searchService = new SQLiteSearchService(this);
  }

  /**
   * Update the database path before initialization.
   * Must be called before initialize() — has no effect after the DB is open.
   */
  setDbPath(path: string): void {
    if (this.isInitialized) {
      console.warn('[SQLiteCacheManager] setDbPath called after initialization — ignoring');
      return;
    }

    this.dbPath = path;
    this.persistenceService.setDbPath(path);
    if (this.maintenanceService) {
      this.maintenanceService.setDbPath(path);
    }
  }

  private getMaintenanceService(): SQLiteMaintenanceService {
    if (!this.maintenanceService) {
      this.maintenanceService = new SQLiteMaintenanceService({
        app: this.app,
        dbPath: this.dbPath,
        bridge: this.bridge,
        getDb: () => this.getDbOrThrow(),
        queryOne: <T>(sql: string, params?: QueryParams) => this.queryOne<T>(sql, params),
        transaction: <T>(fn: () => Promise<T>) => this.transaction(fn)
      });
    }
    return this.maintenanceService;
  }

  private getSqlite3OrThrow(): SQLiteWasmModule {
    if (!this.sqlite3) {
      throw new Error('SQLite module not initialized');
    }
    return this.sqlite3;
  }

  private getDbOrThrow(): SQLiteDatabaseHandle {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  /**
   * Resolve the sqlite3.wasm path for the currently-installed plugin folder.
   *
   * Nexus supports legacy installs under `.obsidian/plugins/claudesidian-mcp/`
   * as well as the current `.obsidian/plugins/nexus/` folder.
   */
  private async resolveSqliteWasmPath(): Promise<string> {
    if (this.wasmPath) {
      try {
        if (await this.app.vault.adapter.exists(this.wasmPath)) {
          return this.wasmPath;
        }
      } catch {
        // Fall through to legacy candidates.
      }
    }

    const configDir = this.app.vault.configDir;
    const candidatePluginFolders = ['nexus', 'claudesidian-mcp'];
    const candidates = candidatePluginFolders.map(folder => `${configDir}/plugins/${folder}/sqlite3.wasm`);

    for (const candidate of candidates) {
      try {
        if (await this.app.vault.adapter.exists(candidate)) {
          return candidate;
        }
      } catch {
        // Ignore adapter errors and continue trying other candidates.
      }
    }

    throw new Error(
      `[SQLiteCacheManager] sqlite3.wasm not found. Looked in: ${candidates.join(', ')}`
    );
  }

  /**
   * Initialize sqlite3 WASM and create/open database
   * Uses in-memory database with manual file persistence
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Load WASM binary using Obsidian's vault adapter
      // The WASM file is copied to the plugin directory by esbuild
      const wasmPath = await this.resolveSqliteWasmPath();

      // Read WASM binary using Obsidian's API
      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

      const consoleRef = console;
      const originalWarn = consoleRef.warn;
      const originalLog = consoleRef.log;
      const suppressPatterns = [
        /OPFS sqlite3_vfs/,
        /Heap resize call/,
        /instantiateWasm/
      ];
      consoleRef.warn = (...args: unknown[]) => {
        const msg = args[0]?.toString() || '';
        if (!suppressPatterns.some(p => p.test(msg))) {
          originalWarn.apply(console, args);
        }
      };
      consoleRef.log = (...args: unknown[]) => {
        const msg = args[0]?.toString() || '';
        if (!suppressPatterns.some(p => p.test(msg))) {
          originalLog.apply(console, args);
        }
      };

      try {
        this.sqlite3 = await this.bridge.initializeModule(wasmBinary);
      } finally {
        consoleRef.warn = originalWarn;
        consoleRef.log = originalLog;
      }

      // Ensure parent directory exists
      const parentPath = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const parentExists = await this.app.vault.adapter.exists(parentPath);
      if (!parentExists) {
        await this.app.vault.adapter.mkdir(parentPath);
      }

      // Check if database file exists
      const dbExists = await this.app.vault.adapter.exists(this.dbPath);

      if (dbExists) {
        // Load existing database from file
        await this.loadFromFile();
      } else {
        const sqlite3 = this.getSqlite3OrThrow();
        const db = this.persistenceService.createFreshDatabase(sqlite3, SCHEMA_SQL);
        this.db = db;
        await this.saveToFile();
      }

      // Run schema migrations for existing databases
      // Wrap raw database in adapter to provide exec() and run() methods
      const dbAdapter = new DatabaseAdapter(this.bridge, this.getDbOrThrow());
      const migrator = new SchemaMigrator(dbAdapter);
      const migrationResult = await migrator.migrate();
      if (migrationResult.applied > 0) {
        await this.saveToFile(); // Save after migrations
      }

      // Fork: Fix vec0 virtual table dimensions if needed (768→384 migration for legacy Nomic era)
      await this.getMaintenanceService().fixVec0TableDimensions();

      // Start auto-save timer
      if (this.autoSaveInterval > 0) {
        this.autoSaveTimer = setInterval(() => {
          if (this.hasUnsavedData) {
            this.saveToFile().catch(err => {
              console.error('[SQLiteCacheManager] Auto-save failed:', err);
            });
          }
        }, this.autoSaveInterval);
      }

      this.isInitialized = true;
    } catch (error) {
      console.error('[SQLiteCacheManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load database from file using sqlite3_deserialize
   * Includes corruption detection and auto-recovery
   */
  private async loadFromFile(): Promise<void> {
    const sqlite3 = this.getSqlite3OrThrow();
    this.db = await this.persistenceService.loadDatabase(sqlite3, SCHEMA_SQL);
    this.hasUnsavedData = false;
  }

  /**
   * Recreate database after corruption detected
   * Deletes corrupt file and creates fresh database
   */
  private async recreateCorruptedDatabase(): Promise<void> {
    const sqlite3 = this.getSqlite3OrThrow();
    if (this.db) {
      try {
        this.bridge.close(this.db);
      } catch {
        void 0;
      }
      this.db = null;
    }

    this.db = await this.persistenceService.recreateCorruptedDatabase(sqlite3, SCHEMA_SQL);
    this.hasUnsavedData = false;
  }

  /**
   * Save database to file using sqlite3_js_db_export
   */
  private async saveToFile(): Promise<void> {
    const db = this.getDbOrThrow();
    const sqlite3 = this.getSqlite3OrThrow();
    await this.persistenceService.saveDatabase(sqlite3, db);
    this.hasUnsavedData = false;
  }

  /**
   * Close the database and save to file
   */
  async close(): Promise<void> {
    try {
      // Stop auto-save timer
      if (this.autoSaveTimer) {
        clearInterval(this.autoSaveTimer);
        this.autoSaveTimer = null;
      }

      // Final save
      if (this.hasUnsavedData) {
        await this.saveToFile();
      }

      if (this.db) {
        this.bridge.close(this.db);
        this.db = null;
      }
      this.isInitialized = false;
    } catch (error) {
      console.error('[SQLiteCacheManager] Error closing database:', error);
      throw error;
    }
  }

  /**
   * Execute raw SQL (for schema creation and multi-statement execution)
   * NOTE: Does not support parameters - use run() or query() for parameterized queries
   */
  exec(sql: string): Promise<void> {
    if (!this.db) return Promise.reject(new Error('Database not initialized'));

    try {
      this.bridge.exec(this.db, sql);
      this.hasUnsavedData = true;
      return Promise.resolve();
    } catch (error) {
      console.error('[SQLiteCacheManager] Exec failed:', error);
      throw error;
    }
  }

  /**
   * Query returning multiple rows
   */
  query<T>(sql: string, params?: QueryParams): Promise<T[]> {
    try {
      const results = this.bridge.query<T>(this.getDbOrThrow(), sql, params);
      return Promise.resolve(results);
    } catch (error) {
      console.error('[SQLiteCacheManager] Query failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Query returning single row
   */
  queryOne<T>(sql: string, params?: QueryParams): Promise<T | null> {
    try {
      const result = this.bridge.queryOne<T>(this.getDbOrThrow(), sql, params);
      return Promise.resolve(result);
    } catch (error) {
      console.error('[SQLiteCacheManager] QueryOne failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Run a statement (INSERT, UPDATE, DELETE)
   * Returns changes count and last insert rowid
   */
  run(sql: string, params?: QueryParams): Promise<RunResult> {
    try {
      const db = this.getDbOrThrow();
      const sqlite3 = this.getSqlite3OrThrow();
      const { changes, lastInsertRowid } = this.bridge.run(db, sqlite3, sql, params);

      this.hasUnsavedData = true;
      return Promise.resolve({ changes, lastInsertRowid });
    } catch (error) {
      console.error('[SQLiteCacheManager] Run failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Begin a transaction
   */
  beginTransaction(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'BEGIN TRANSACTION');
    return Promise.resolve();
  }

  /**
   * Commit a transaction
   */
  commit(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'COMMIT');
    this.hasUnsavedData = true;
    return Promise.resolve();
  }

  /**
   * Rollback a transaction
   */
  rollback(): Promise<void> {
    this.bridge.exec(this.getDbOrThrow(), 'ROLLBACK');
    return Promise.resolve();
  }

  /**
   * Execute a function within a transaction
   * Handles concurrent access via lock and nested transactions via depth tracking
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.transactionCoordinator.run(
      () => this.beginTransaction(),
      () => this.commit(),
      () => this.rollback(),
      fn
    );
  }

  // ==================== Higher-level query methods ====================

  /**
   * Get paginated results with offset-based pagination
   */
  async queryPaginated<T>(
    baseQuery: string,
    countQuery: string,
    options: PaginationParams = {},
    params: QueryParams = []
  ): Promise<PaginatedResult<T>> {
    const page = options.page ?? 0;
    const pageSize = Math.min(options.pageSize ?? 25, 200);
    const offset = page * pageSize;

    // Get total count
    const countResult = await this.queryOne<{ count: number }>(countQuery, params);
    const totalItems = countResult?.count ?? 0;
    const totalPages = Math.ceil(totalItems / pageSize);

    // Get paginated results
    const paginatedQuery = `${baseQuery} LIMIT ? OFFSET ?`;
    const items = await this.query<T>(paginatedQuery, [...params, pageSize, offset]);

    return {
      items,
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages - 1,
      hasPreviousPage: page > 0
    };
  }

  // ==================== Event tracking ====================

  /**
   * Check if an event has already been applied
   */
  async isEventApplied(eventId: string): Promise<boolean> {
    return this.syncStateStore.isEventApplied(eventId);
  }

  /**
   * Mark an event as applied
   */
  async markEventApplied(eventId: string): Promise<void> {
    await this.syncStateStore.markEventApplied(eventId);
  }

  /**
   * Get list of applied event IDs after a timestamp
   */
  async getAppliedEventsAfter(timestamp: number): Promise<string[]> {
    return this.syncStateStore.getAppliedEventsAfter(timestamp);
  }

  // ==================== Sync state ====================

  /**
   * Get sync state for a device
   */
  async getSyncState(deviceId: string): Promise<SyncState | null> {
    return this.syncStateStore.getSyncState(deviceId);
  }

  /**
   * Update sync state for a device
   */
  async updateSyncState(deviceId: string, lastEventTimestamp: number, fileTimestamps: Record<string, number>): Promise<void> {
    await this.syncStateStore.updateSyncState(deviceId, lastEventTimestamp, fileTimestamps);
  }

  // ==================== Data management ====================

  async clearAllData(): Promise<void> {
    await this.getMaintenanceService().clearAllData();
  }

  async rebuildFTSIndexes(): Promise<void> {
    await this.getMaintenanceService().rebuildFTSIndexes();
  }

  async vacuum(): Promise<void> {
    await this.getMaintenanceService().vacuum();
    this.hasUnsavedData = true;
  }

  // ==================== Full-text search ====================
  // Delegated to SQLiteSearchService for single responsibility

  /**
   * Search workspaces using FTS4
   */
  async searchWorkspaces(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchWorkspaces(query, limit);
  }

  /**
   * Search conversations using FTS4
   */
  async searchConversations(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchConversations(query, limit);
  }

  /**
   * Search messages using FTS4
   */
  async searchMessages(query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchMessages(query, limit);
  }

  /**
   * Search messages within a specific conversation using FTS4
   */
  async searchMessagesInConversation(conversationId: string, query: string, limit = 50): Promise<unknown[]> {
    return this.searchService.searchMessagesInConversation(conversationId, query, limit);
  }

  // ==================== Statistics ====================

  /**
   * Get database statistics
   */
  async getStatistics(): Promise<SQLiteMaintenanceStatistics> {
    return this.getMaintenanceService().getStatistics();
  }

  // ==================== Utilities ====================

  /**
   * Check if database is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.db !== null;
  }

  /**
   * Get database path (relative)
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Force save to file
   */
  async save(): Promise<void> {
    await this.saveToFile();
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return this.hasUnsavedData;
  }

  // ==================== IStorageBackend interface methods ====================

  /**
   * Check if database is open and ready (IStorageBackend requirement)
   */
  isOpen(): boolean {
    return this.isReady();
  }

  /**
   * Get database path (IStorageBackend requirement)
   */
  getDatabasePath(): string | null {
    return this.dbPath;
  }

  /**
   * Get database statistics (IStorageBackend requirement)
   */
  async getStats(): Promise<DatabaseStats> {
    return this.getMaintenanceService().getStats();
  }
}
