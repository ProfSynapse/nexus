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
import { SQLiteMaintenanceService, SQLiteMaintenanceStatistics, SQLiteObjectPageUsage } from './SQLiteMaintenanceService';
import type { CacheBlobStore } from './CacheBlobStore';
import { createCacheBlobStore, computeIdbKey } from './CacheBlobStoreFactory';
import { resolveActivePluginFolderName } from './PluginStoragePathResolver';

// Import schema from TypeScript module (esbuild compatible)
import { SCHEMA_SQL } from '../schema/schema';
import { SchemaMigrator } from '../schema/SchemaMigrator';

import type { Plugin } from 'obsidian';

export interface SQLiteCacheManagerOptions {
  app: App;
  dbPath: string;  // plugin-scoped cache path used by VaultAdapter backend on mobile
  wasmPath?: string;
  autoSaveInterval?: number;  // ms between auto-saves (default: 30000)
  /**
   * Plugin used to compute the IDB key (manifest dir). Required when
   * `blobStore` is omitted so the factory can build the desktop store with a
   * stable per-install key. Tests can pass a pre-built `blobStore` instead.
   */
  plugin?: Plugin;
  /**
   * Pre-built backing store. When provided, the cache manager uses it directly
   * instead of constructing one via the factory. Also enables migration code
   * in HybridStorageAdapter to share the same store instance.
   */
  blobStore?: CacheBlobStore;
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
  /**
   * Monotonic count of writes applied to this handle.
   *
   * A boolean dirty flag cannot tell "dirty because of the writes the running
   * save is writing" from "dirty because of a write that landed after that
   * save took its snapshot", because it is already true in both cases.
   * Clearing it after the write therefore marks rows clean that are in no
   * snapshot anywhere, and they are dropped at close() with nothing logged.
   * That is section 6a of docs/plans/sqlite-cache-persistence-plan.md. A save
   * captures this number before its export and clears the flag afterwards only
   * if it has not moved.
   */
  private writeGeneration = 0;
  /** The save that is currently exporting or writing, if there is one. */
  private saveInFlight: Promise<void> | null = null;
  /** The write generation the in-flight save captured before its export. */
  private inFlightGeneration = 0;
  /** The one coalesced save scheduled to follow the in-flight one, if any. */
  private pendingSave: Promise<void> | null = null;
  /** Set by stopAutoSave() and close() to cancel a scheduled follow-up. */
  private followUpCancelled = false;
  /**
   * How big the cache is, in bytes, as far as anything here knows: the size of
   * the blob loaded at startup, then the byte count of the last successful
   * save. Both numbers are already in hand, so reading this costs nothing,
   * which is the point. The save cadence in CacheSavePolicy is driven off it,
   * and a cadence on a hot path may not run a query to find its own inputs.
   */
  private lastSavedBytes: number | null = null;
  private autoSaveInterval: number;
  private autoSaveTimer: number | null = null;
  private readonly transactionCoordinator: SQLiteTransactionCoordinator;
  private readonly syncStateStore: SQLiteSyncStateStore;
  private readonly persistenceService: SQLitePersistenceService;
  private readonly blobStore: CacheBlobStore;
  private maintenanceService?: SQLiteMaintenanceService;
  /**
   * Set when a schema migration ran that cannot fix existing rows in place.
   * Consumed once by the adapter's startup path, because `initialize()` is
   * re-entered by rebuildCache() and a stale flag would rebuild twice.
   */
  private pendingSchemaRebuild = false;

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.wasmPath = options.wasmPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;  // 30 seconds default
    this.bridge = new SQLiteWasmBridge();
    this.transactionCoordinator = new SQLiteTransactionCoordinator();
    this.blobStore = options.blobStore ?? this.buildDefaultBlobStore(options);
    this.persistenceService = new SQLitePersistenceService({
      blobStore: this.blobStore,
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
   * Expose the underlying sync-state store so `ReconcilePipeline` can read
   * the cursor table directly. The store handles its own SQL; this getter
   * is the only seam the pipeline needs to touch SQLite.
   */
  getSyncStateStore(): SQLiteSyncStateStore {
    return this.syncStateStore;
  }

  /**
   * Expose the blob store so HybridStorageAdapter.rebuildCache() and the
   * migration runner can share the same instance the cache manager uses.
   */
  getBlobStore(): CacheBlobStore {
    return this.blobStore;
  }

  private buildDefaultBlobStore(options: SQLiteCacheManagerOptions): CacheBlobStore {
    const pluginDir = options.plugin
      ? resolveActivePluginFolderName(options.plugin)
      : 'nexus';
    return createCacheBlobStore({
      app: options.app,
      vaultRelativePath: options.dbPath,
      idbKey: computeIdbKey(options.app, pluginDir)
    });
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
    // persistenceService no longer tracks path — owned by CacheBlobStore now.
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
        transaction: <T>(fn: () => Promise<T>) => this.transaction(fn),
        blobStore: this.blobStore
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

    // A previous close() latched this to stop a follow-up writing after the
    // handle went away. Rebuild Cache reopens the same instance, so clear it
    // or the reopened handle would never run a coalesced save again.
    this.followUpCancelled = false;

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

      // Ensure parent directory exists. Required regardless of backend
      // because legacy migration reads/writes through this path on first
      // launch, and the VaultAdapter mobile backend writes here in steady
      // state. Cheap idempotent op when the dir is already present.
      const parentPath = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const parentExists = await this.app.vault.adapter.exists(parentPath);
      if (!parentExists) {
        await this.app.vault.adapter.mkdir(parentPath);
      }

      // Ask the blob store directly — getMetadata returns null when the blob
      // is absent. This works uniformly across IDB (desktop) and the
      // vault.adapter file path (mobile) without leaking which backend is in
      // use into the cache manager.
      const meta = await this.blobStore.getMetadata();
      const dbExists = meta !== null && meta.size > 0;
      if (dbExists) {
        this.lastSavedBytes = meta.size;
      }

      if (dbExists) {
        // Load existing database from blob store
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
      // Hand the signal to the caller rather than dropping it: the result object
      // used to die in this scope, so `needsRebuild` could never mean anything.
      this.pendingSchemaRebuild = migrationResult.needsRebuild;

      // Start auto-save timer
      if (this.autoSaveInterval > 0) {
        this.autoSaveTimer = window.setInterval(() => {
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
   * Whether the schema migration that just ran needs the cache replayed from
   * JSONL, clearing the flag as it reports it. Consume-once so the second
   * `initialize()` that rebuildCache() performs does not rebuild again.
   */
  consumeSchemaRebuildRequest(): boolean {
    const pending = this.pendingSchemaRebuild;
    this.pendingSchemaRebuild = false;
    return pending;
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
   * Save the database to the blob store, with at most one export alive.
   *
   * Every export allocates one contiguous buffer the full size of the database
   * and the backing store copies it again, so two overlapping saves are two of
   * those at once. Before this guard existed the 30 s autosave timer started
   * exactly that on every queue-driven save, because the dirty flag stays true
   * until a save finishes and so the timer never skipped.
   *
   * Three outcomes, and no fourth:
   * - nothing in flight: export now;
   * - in flight and nothing written since its export: join it, because that
   *   export already holds everything this caller wants persisted;
   * - in flight and something written since: one follow-up, shared by however
   *   many callers ask for it.
   */
  private saveToFile(): Promise<void> {
    if (this.saveInFlight) {
      if (this.writeGeneration === this.inFlightGeneration) {
        return this.saveInFlight;
      }
      return this.scheduleFollowUpSave();
    }
    return this.startSave();
  }

  /**
   * Export and write, holding the lock for the whole round trip.
   */
  private startSave(): Promise<void> {
    // Captured BEFORE saveDatabase is called, not inside it: that method
    // exports the database as the first thing it does, so every write after
    // this line is newer than the bytes about to be written.
    const generation = this.writeGeneration;
    this.inFlightGeneration = generation;

    const save = async (): Promise<void> => {
      const db = this.getDbOrThrow();
      const sqlite3 = this.getSqlite3OrThrow();
      await this.persistenceService.saveDatabase(sqlite3, db);
      this.lastSavedBytes = this.persistenceService.getLastSavedBytes() ?? this.lastSavedBytes;
      // Only the writes this snapshot contains are clean. Anything that landed
      // during the write bumped the counter and stays dirty, so the autosave
      // timer and close() still see work outstanding.
      if (this.writeGeneration === generation) {
        this.hasUnsavedData = false;
      }
    };

    const inFlight = save().finally(() => {
      if (this.saveInFlight === inFlight) {
        this.saveInFlight = null;
      }
    });
    this.saveInFlight = inFlight;
    return inFlight;
  }

  /**
   * Schedule exactly one save to run after the in-flight one.
   *
   * Every caller that asks while a save is running gets this same promise, so
   * however many ask, one follow-up export happens and never two at once.
   *
   * The follow-up re-checks before exporting, and does nothing when
   * stopAutoSave() or close() cancelled it. That check is what keeps a
   * coalesced save from resurrecting a blob that Rebuild Cache has just
   * removed: StorageMaintenanceService.rebuildCache calls stopAutoSave(), then
   * close(), then blobStore.remove(), and a follow-up landing after the remove
   * would write the old database straight back.
   */
  private scheduleFollowUpSave(): Promise<void> {
    if (this.pendingSave) {
      return this.pendingSave;
    }

    const precedingSave = this.saveInFlight;
    this.followUpCancelled = false;

    const pending = (async (): Promise<void> => {
      // Wait for the running export to be done with, whatever its outcome: its
      // failure belongs to the caller that asked for it, not to this one.
      await precedingSave?.then(() => undefined, () => undefined);
      this.pendingSave = null;
      if (this.followUpCancelled || this.db === null || !this.hasUnsavedData) {
        return;
      }
      await this.saveToFile();
    })();

    this.pendingSave = pending;
    return pending;
  }

  /**
   * Close the database and save to file
   */
  async close(): Promise<void> {
    try {
      // Stop auto-save timer
      if (this.autoSaveTimer) {
        window.clearInterval(this.autoSaveTimer);
        this.autoSaveTimer = null;
      }

      // Cancel any scheduled follow-up. The final save below covers everything
      // it would have written, and nothing may reach the blob store after
      // close() returns: Rebuild Cache removes the blob on the next line.
      this.followUpCancelled = true;

      // Let an export that is already running finish before starting another,
      // so closing never puts a second full-size buffer alongside it. Its
      // outcome belongs to whoever asked for it; what matters here is the
      // dirty flag it leaves behind.
      if (this.saveInFlight) {
        await this.saveInFlight.then(() => undefined, () => undefined);
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
      this.markDirty();
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

      this.markDirty();
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
    this.markDirty();
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
   * Serializes concurrent access through SQLiteTransactionCoordinator.
   * Nested calls are not supported; callers should keep one transaction boundary
   * around the complete operation instead of opening a transaction from inside one.
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
    this.markDirty();
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

  /**
   * Per-table byte breakdown of the persisted database, from `dbstat`.
   *
   * On-demand only: it walks every page, so it is not part of getStatistics()
   * and does not belong on any startup or save path. Returns null when dbstat
   * is not available. See SQLiteMaintenanceService.getObjectPageUsage.
   */
  async getObjectPageUsage(): Promise<SQLiteObjectPageUsage[] | null> {
    return this.getMaintenanceService().getObjectPageUsage();
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
   * Stop the auto-save timer without closing the database. Used by the
   * Rebuild Cache flow to suspend writes before clearing the blob store.
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      window.clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    // Stopping the timer is not enough on its own: a coalesced follow-up is
    // already scheduled independently of it, and it would export after the
    // caller believes writes have stopped.
    this.followUpCancelled = true;
  }

  /**
   * Record that the database changed: set the flag and move the generation on.
   *
   * Both, always. The flag answers "is there anything to save" and the
   * generation answers "is what the running save exported still current", and
   * a save clears the flag only when the answer to the second is yes.
   */
  private markDirty(): void {
    this.hasUnsavedData = true;
    this.writeGeneration++;
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return this.hasUnsavedData;
  }

  /**
   * Bytes written by the most recent successful save, or the size of the blob
   * that was loaded at startup, or null when neither has happened yet.
   *
   * Free to call: both figures are recorded as they go past, so this is a
   * field read with no query, no pragma and no blob store round trip. That is
   * what makes it usable from the indexers' per-item loop, where
   * getStatistics() would not be and getObjectPageUsage() emphatically would
   * not be, since the latter walks every page.
   */
  getLastSavedBytes(): number | null {
    return this.lastSavedBytes;
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
