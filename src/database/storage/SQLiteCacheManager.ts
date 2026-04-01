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

// Import the raw WASM sqlite3 module (has sqlite-vec compiled in)
// esbuild alias resolves this to index.mjs which exports sqlite3InitModule
import sqlite3InitModule from '@dao-xyz/sqlite3-vec/wasm';

import { App } from 'obsidian';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { IStorageBackend, RunResult, DatabaseStats } from '../interfaces/IStorageBackend';
import type { SyncState, ISQLiteCacheManager } from '../sync/SyncCoordinator';
import { SQLiteSearchService } from './SQLiteSearchService';
import { QueryParams } from '../repositories/base/BaseRepository';

// Import schema from TypeScript module (esbuild compatible)
import { SCHEMA_SQL } from '../schema/schema';
import { SchemaMigrator } from '../schema/SchemaMigrator';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface SQLiteCacheManagerOptions {
  app: App;
  dbPath: string;  // e.g., '.nexus/cache.db'
  autoSaveInterval?: number;  // ms between auto-saves (default: 30000)
}

export interface QueryResult<T> {
  items: T[];
  totalCount?: number;
}

type SQLite3Module = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SQLiteDatabase = InstanceType<SQLite3Module['oo1']['DB']>;

/**
 * Database adapter that wraps raw WASM SQLite database to provide
 * exec() and run() methods for MigratableDatabase interface.
 */
class DatabaseAdapter {
  constructor(private rawDb: SQLiteDatabase) {}

  exec(sql: string): { values: unknown[][] }[] {
    const stmt = this.rawDb.prepare(sql);
    const results: unknown[][] = [];
    while (stmt.step()) {
      results.push(stmt.get([]) as unknown[]);
    }
    stmt.finalize();
    return results.length > 0 ? [{ values: results }] : [];
  }

  run(sql: string, params?: QueryParams): void {
    const stmt = this.rawDb.prepare(sql);
    if (params?.length) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.finalize();
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
  private sqlite3: SQLite3Module | null = null;  // The sqlite3 WASM module
  private db: SQLiteDatabase | null = null;  // The oo1.DB instance
  private isInitialized = false;
  private searchService: SQLiteSearchService;
  private hasUnsavedData = false;
  private autoSaveInterval: number;
  private autoSaveTimer: NodeJS.Timeout | null = null;

  // Transaction management - prevent nested transactions
  private transactionDepth = 0;
  private transactionLock: Promise<void> = Promise.resolve();

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;  // 30 seconds default
    this.searchService = new SQLiteSearchService(this);
  }

  private getSqlite3OrThrow(): SQLite3Module {
    if (!this.sqlite3) {
      throw new Error('SQLite module not initialized');
    }
    return this.sqlite3;
  }

  private getDbOrThrow(): SQLiteDatabase {
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
        // External library types are incomplete - instantiateWasm is a valid option but not in InitOptions type
        // Cast to unknown first to bypass strict type checking for the extended options
        const initOptions = {
          instantiateWasm: (imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) => {
            WebAssembly.instantiate(wasmBinary, imports)
              .then(result => {
                successCallback(result.instance);
              })
              .catch(err => {
                console.error('[SQLiteCacheManager] WASM instantiation failed:', err);
              });
            return {};
          },
          print: () => undefined,
          printErr: (msg: string) => console.error('[SQLite]', msg)
        } as unknown as Parameters<typeof sqlite3InitModule>[0];
        this.sqlite3 = await sqlite3InitModule(initOptions);
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
        const db = new sqlite3.oo1.DB(':memory:');
        this.db = db;
        db.exec(SCHEMA_SQL);
        await this.saveToFile();
      }

      // Run schema migrations for existing databases
      // Wrap raw database in adapter to provide exec() and run() methods
      const dbAdapter = new DatabaseAdapter(this.getDbOrThrow());
      const migrator = new SchemaMigrator(dbAdapter);
      const migrationResult = await migrator.migrate();
      if (migrationResult.applied > 0) {
        await this.saveToFile(); // Save after migrations
      }

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
    try {
      // Read binary data from vault
      const data = await this.app.vault.adapter.readBinary(this.dbPath);
      const uint8 = new Uint8Array(data);

      if (uint8.length === 0) {
        // Empty file, create new database
        const sqlite3 = this.getSqlite3OrThrow();
        const db = new sqlite3.oo1.DB(':memory:');
        this.db = db;
        db.exec(SCHEMA_SQL);
        return;
      }

      // Allocate memory for the database bytes
      const sqlite3 = this.getSqlite3OrThrow();
      const ptr = sqlite3.wasm.allocFromTypedArray(uint8);

      // Create empty in-memory database
      this.db = new sqlite3.oo1.DB(':memory:');
      const db = this.getDbOrThrow();

      // Deserialize the data into the database
      const rc = sqlite3.capi.sqlite3_deserialize(
        db,
        'main',
        ptr,
        uint8.byteLength,
        uint8.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
      );

      if (rc !== 0) {
        throw new Error(`sqlite3_deserialize failed with code ${rc}`);
      }

      // Verify database integrity
      try {
        const integrityResult = db.selectValue('PRAGMA integrity_check');
        if (integrityResult !== 'ok') {
          const integrityMessage = typeof integrityResult === 'string'
            ? integrityResult
            : JSON.stringify(integrityResult) ?? 'unknown';
          throw new Error(`Database integrity check failed: ${integrityMessage}`);
        }
      } catch {
        await this.recreateCorruptedDatabase();
        return;
      }

      this.hasUnsavedData = false;
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to load from file:', error);
      await this.recreateCorruptedDatabase();
    }
  }

  /**
   * Recreate database after corruption detected
   * Deletes corrupt file and creates fresh database
   */
  private async recreateCorruptedDatabase(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        void 0;
      }
      this.db = null;
    }

    try {
      await this.app.vault.adapter.remove(this.dbPath);
    } catch {
      void 0;
    }

    const sqlite3 = this.getSqlite3OrThrow();
    const db = new sqlite3.oo1.DB(':memory:');
    this.db = db;
    db.exec(SCHEMA_SQL);
    await this.saveToFile();
  }

  /**
   * Save database to file using sqlite3_js_db_export
   */
  private async saveToFile(): Promise<void> {
    try {
      const db = this.getDbOrThrow();
      const sqlite3 = this.getSqlite3OrThrow();
      // Temporarily suppress console.log during WASM export to avoid "Heap resize" noise
      const consoleRef = console;
      const originalLog = consoleRef.log;
      consoleRef.log = () => undefined;

      let data: { buffer: ArrayBuffer };
      try {
        data = sqlite3.capi.sqlite3_js_db_export(db);
      } finally {
        consoleRef.log = originalLog;
      }

      await this.app.vault.adapter.writeBinary(this.dbPath, data.buffer);

      this.hasUnsavedData = false;
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save to file:', error);
      throw error;
    }
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
        this.db.close();
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
      this.db.exec(sql);
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
      const db = this.getDbOrThrow();
      const stmt = db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        const results: T[] = [];
        while (stmt.step()) {
          results.push(stmt.get({}) as T);
        }
        return Promise.resolve(results);
      } finally {
        stmt.finalize();
      }
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
      const db = this.getDbOrThrow();
      const stmt = db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        if (stmt.step()) {
          return Promise.resolve(stmt.get({}) as T);
        }
        return Promise.resolve(null);
      } finally {
        stmt.finalize();
      }
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
      const stmt = db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        stmt.stepReset();
      } finally {
        stmt.finalize();
      }

      // Get changes count and last insert rowid
      const changes = db.changes();
      const lastInsertRowid = Number(sqlite3.capi.sqlite3_last_insert_rowid(db));

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
    this.getDbOrThrow().exec('BEGIN TRANSACTION');
    return Promise.resolve();
  }

  /**
   * Commit a transaction
   */
  commit(): Promise<void> {
    this.getDbOrThrow().exec('COMMIT');
    this.hasUnsavedData = true;
    return Promise.resolve();
  }

  /**
   * Rollback a transaction
   */
  rollback(): Promise<void> {
    this.getDbOrThrow().exec('ROLLBACK');
    return Promise.resolve();
  }

  /**
   * Execute a function within a transaction
   * Handles concurrent access via lock and nested transactions via depth tracking
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    // If already in a transaction, just run the function (no nesting)
    if (this.transactionDepth > 0) {
      return fn();
    }

    // Queue this transaction after any pending ones
    let resolve: (() => void) | undefined;
    const previousLock = this.transactionLock;
    this.transactionLock = new Promise<void>((r) => { resolve = r; });

    try {
      // Wait for any pending transaction to complete
      await previousLock;

      this.transactionDepth++;
      await this.beginTransaction();

      try {
        const result = await fn();
        await this.commit();
        return result;
      } catch (error) {
        await this.rollback();
        throw error;
      } finally {
        this.transactionDepth--;
      }
    } finally {
      // Release the lock for the next transaction
      resolve?.();
    }
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
    const result = await this.queryOne<{ eventId: string }>(
      'SELECT eventId FROM applied_events WHERE eventId = ?',
      [eventId]
    );
    return result !== null;
  }

  /**
   * Mark an event as applied
   */
  async markEventApplied(eventId: string): Promise<void> {
    await this.run(
      'INSERT OR IGNORE INTO applied_events (eventId, appliedAt) VALUES (?, ?)',
      [eventId, Date.now()]
    );
  }

  /**
   * Get list of applied event IDs after a timestamp
   */
  async getAppliedEventsAfter(timestamp: number): Promise<string[]> {
    const results = await this.query<{ eventId: string }>(
      'SELECT eventId FROM applied_events WHERE appliedAt > ? ORDER BY appliedAt',
      [timestamp]
    );
    return results.map(r => r.eventId);
  }

  // ==================== Sync state ====================

  /**
   * Get sync state for a device
   */
  async getSyncState(deviceId: string): Promise<SyncState | null> {
    const result = await this.queryOne<{ deviceId: string; lastEventTimestamp: number; syncedFilesJson: string }>(
      'SELECT deviceId, lastEventTimestamp, syncedFilesJson FROM sync_state WHERE deviceId = ?',
      [deviceId]
    );

    if (!result) return null;

      const fileTimestampsRaw: unknown = result.syncedFilesJson ? JSON.parse(result.syncedFilesJson) : {};
      const fileTimestamps: Record<string, number> = {};
      if (isRecord(fileTimestampsRaw)) {
        for (const [key, value] of Object.entries(fileTimestampsRaw)) {
          if (typeof value === 'number' && Number.isFinite(value)) {
            fileTimestamps[key] = value;
          }
        }
      }
      return {
        deviceId: result.deviceId,
        lastEventTimestamp: result.lastEventTimestamp,
        fileTimestamps
      };
  }

  /**
   * Update sync state for a device
   */
  async updateSyncState(deviceId: string, lastEventTimestamp: number, fileTimestamps: Record<string, number>): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO sync_state (deviceId, lastEventTimestamp, syncedFilesJson)
       VALUES (?, ?, ?)`,
      [deviceId, lastEventTimestamp, JSON.stringify(fileTimestamps)]
    );
  }

  // ==================== Data management ====================

  /**
   * Clear all data (for rebuilding from JSONL)
   */
  async clearAllData(): Promise<void> {
    await this.transaction(() => {
      const db = this.getDbOrThrow();
      db.exec(`
        DELETE FROM task_note_links;
        DELETE FROM task_dependencies;
        DELETE FROM tasks;
        DELETE FROM projects;
        DELETE FROM messages;
        DELETE FROM conversations;
        DELETE FROM memory_traces;
        DELETE FROM states;
        DELETE FROM sessions;
        DELETE FROM workspaces;
        DELETE FROM applied_events;
        DELETE FROM sync_state;
      `);

      // Drop and recreate vec0 virtual tables (cannot DELETE from vec0)
      // Conversation embeddings
      db.exec(`DROP TABLE IF EXISTS conversation_embeddings`);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(embedding float[384])`);
      db.exec(`DELETE FROM conversation_embedding_metadata`);
      db.exec(`DELETE FROM embedding_backfill_state`);
      return Promise.resolve();
    });
  }

  /**
   * Rebuild FTS5 indexes after bulk data changes
   */
  async rebuildFTSIndexes(): Promise<void> {
    await this.transaction(() => {
      const db = this.getDbOrThrow();
      // Rebuild workspace FTS5
      db.exec(`
        INSERT INTO workspace_fts(workspace_fts) VALUES ('rebuild');
      `);

      // Rebuild conversation FTS5
      db.exec(`
        INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');
      `);

      // Rebuild message FTS5
      db.exec(`
        INSERT INTO message_fts(message_fts) VALUES ('rebuild');
      `);
      return Promise.resolve();
    });
  }

  /**
   * Vacuum the database to reclaim space
   */
  vacuum(): Promise<void> {
    try {
      this.getDbOrThrow().exec('VACUUM');
      this.hasUnsavedData = true;
      return Promise.resolve();
    } catch (error) {
      console.error('[SQLiteCacheManager] Vacuum failed:', error);
      throw error;
    }
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
  async getStatistics(): Promise<{
    workspaces: number;
    sessions: number;
    states: number;
    traces: number;
    conversations: number;
    messages: number;
    appliedEvents: number;
    conversationEmbeddings: number;
    dbSizeBytes: number;
  }> {
    const stats = await Promise.all([
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM workspaces'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM sessions'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM states'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM memory_traces'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM conversations'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM messages'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM applied_events'),
      this.queryOne<{ count: number }>('SELECT COUNT(*) as count FROM conversation_embedding_metadata'),
    ]);

    // Get file size from filesystem
    let dbSizeBytes = 0;
    try {
      const exists = await this.app.vault.adapter.exists(this.dbPath);
      if (exists) {
        const stat = await this.app.vault.adapter.stat(this.dbPath);
        dbSizeBytes = stat?.size ?? 0;
      }
    } catch {
      void 0;
    }

    return {
      workspaces: stats[0]?.count ?? 0,
      sessions: stats[1]?.count ?? 0,
      states: stats[2]?.count ?? 0,
      traces: stats[3]?.count ?? 0,
      conversations: stats[4]?.count ?? 0,
      messages: stats[5]?.count ?? 0,
      appliedEvents: stats[6]?.count ?? 0,
      conversationEmbeddings: stats[7]?.count ?? 0,
      dbSizeBytes
    };
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
    const stats = await this.getStatistics();

    // Count tables
    const tableCountResult = await this.queryOne<{ count: number }>(
      "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'"
    );
    const tableCount = tableCountResult?.count ?? 0;

    return {
      fileSize: stats.dbSizeBytes,
      tableCount,
      totalRows: stats.workspaces + stats.sessions + stats.states + stats.traces +
                 stats.conversations + stats.messages,
      tableCounts: {
        workspaces: stats.workspaces,
        sessions: stats.sessions,
        states: stats.states,
        memory_traces: stats.traces,
        conversations: stats.conversations,
        messages: stats.messages,
        applied_events: stats.appliedEvents,
        conversation_embedding_metadata: stats.conversationEmbeddings
      },
      walMode: false  // WASM doesn't use WAL mode
    };
  }
}
