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
// @ts-ignore - esbuild alias handling
import sqlite3InitModule from '@dao-xyz/sqlite3-vec/wasm';

import { App, normalizePath } from 'obsidian';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { IStorageBackend, RunResult, DatabaseStats } from '../interfaces/IStorageBackend';
import type { SyncState, ISQLiteCacheManager } from '../sync/SyncCoordinator';
import { SQLiteSearchService } from './SQLiteSearchService';

// Import schema from TypeScript module (esbuild compatible)
import { SCHEMA_SQL } from '../schema/schema';
import { SchemaMigrator, CURRENT_SCHEMA_VERSION } from '../schema/SchemaMigrator';

export interface SQLiteCacheManagerOptions {
  app: App;
  dbPath: string;  // e.g., '.nexus/cache.db'
  autoSaveInterval?: number;  // ms between auto-saves (default: 30000)
}

export interface QueryResult<T> {
  items: T[];
  totalCount?: number;
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
  private sqlite3: any = null;  // The sqlite3 WASM module
  private db: any = null;  // The oo1.DB instance
  private isInitialized: boolean = false;
  private searchService: SQLiteSearchService;
  private hasUnsavedData: boolean = false;
  private autoSaveInterval: number;
  private autoSaveTimer: NodeJS.Timeout | null = null;

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;  // 30 seconds default
    this.searchService = new SQLiteSearchService(this);
  }

  /**
   * Resolve the sqlite3.wasm path for the currently-installed plugin folder.
   *
   * Nexus supports legacy installs under `.obsidian/plugins/claudesidian-mcp/`
   * as well as the current `.obsidian/plugins/nexus/` folder.
   */
  private async resolveSqliteWasmPath(): Promise<string> {
    const configDir = (this.app.vault as any)?.configDir || '.obsidian';
    const candidatePluginFolders = ['nexus', 'claudesidian-mcp'];
    const candidates = candidatePluginFolders.map(folder => `${configDir}/plugins/${folder}/sqlite3.wasm`);

    for (const candidate of candidates) {
      try {
        if (await this.app.vault.adapter.exists(candidate)) {
          return candidate;
        }
      } catch (error) {
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
      console.warn('[SQLiteCacheManager] Already initialized');
      return;
    }

    try {
      console.log('[SQLiteCacheManager] Initializing WASM SQLite with sqlite-vec...');

      // Load WASM binary using Obsidian's vault adapter
      // The WASM file is copied to the plugin directory by esbuild
      const wasmPath = await this.resolveSqliteWasmPath();

      console.log('[SQLiteCacheManager] Loading WASM from:', wasmPath);

      // Read WASM binary using Obsidian's API
      const wasmBinary = await this.app.vault.adapter.readBinary(wasmPath);

      console.log('[SQLiteCacheManager] WASM binary loaded:', wasmBinary.byteLength, 'bytes');

      // Initialize the WASM module with instantiateWasm callback
      // This bypasses the module's own URL-based loading entirely
      this.sqlite3 = await sqlite3InitModule({
        // Use instantiateWasm for direct control over WASM instantiation
        instantiateWasm: (imports: WebAssembly.Imports, successCallback: (instance: WebAssembly.Instance) => void) => {
          WebAssembly.instantiate(wasmBinary, imports)
            .then(result => {
              successCallback(result.instance);
            })
            .catch(err => {
              console.error('[SQLiteCacheManager] WASM instantiation failed:', err);
            });
          return {}; // Return empty object, actual instance provided via callback
        },
        print: (msg: string) => console.log('[SQLite]', msg),
        printErr: (msg: string) => console.error('[SQLite]', msg)
      });

      console.log('[SQLiteCacheManager] WASM module loaded');

      // Ensure parent directory exists
      const parentPath = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const parentExists = await this.app.vault.adapter.exists(parentPath);
      if (!parentExists) {
        await this.app.vault.adapter.mkdir(parentPath);
        console.log(`[SQLiteCacheManager] Created directory: ${parentPath}`);
      }

      // Check if database file exists
      const dbExists = await this.app.vault.adapter.exists(this.dbPath);

      if (dbExists) {
        // Load existing database from file
        await this.loadFromFile();
        console.log('[SQLiteCacheManager] Loaded existing database from file');
      } else {
        // Create new in-memory database
        this.db = new this.sqlite3.oo1.DB(':memory:');

        // Create schema
        this.db.exec(SCHEMA_SQL);
        console.log('[SQLiteCacheManager] Created new database with schema');

        // Save initial database to file
        await this.saveToFile();
      }

      // Verify sqlite-vec extension is loaded
      try {
        const version = this.db.selectValue('SELECT vec_version()');
        console.log(`[SQLiteCacheManager] sqlite-vec version: ${version}`);
      } catch (e) {
        console.warn('[SQLiteCacheManager] sqlite-vec extension not available:', e);
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
      console.log('[SQLiteCacheManager] Initialization complete');
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
        console.log('[SQLiteCacheManager] Empty database file, creating fresh database');
        this.db = new this.sqlite3.oo1.DB(':memory:');
        this.db.exec(SCHEMA_SQL);
        return;
      }

      // Allocate memory for the database bytes
      const ptr = this.sqlite3.wasm.allocFromTypedArray(uint8);

      // Create empty in-memory database
      this.db = new this.sqlite3.oo1.DB(':memory:');

      // Deserialize the data into the database
      const rc = this.sqlite3.capi.sqlite3_deserialize(
        this.db.pointer,
        'main',
        ptr,
        uint8.byteLength,
        uint8.byteLength,
        this.sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
        this.sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE
      );

      if (rc !== 0) {
        throw new Error(`sqlite3_deserialize failed with code ${rc}`);
      }

      // Verify database integrity
      try {
        const integrityResult = this.db.selectValue('PRAGMA integrity_check');
        if (integrityResult !== 'ok') {
          throw new Error(`Database integrity check failed: ${integrityResult}`);
        }
        console.log('[SQLiteCacheManager] Database integrity check passed');
      } catch (integrityError) {
        console.error('[SQLiteCacheManager] Database corrupted, recreating:', integrityError);
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
    console.log('[SQLiteCacheManager] Recreating database after corruption...');

    // Close existing DB if open
    if (this.db) {
      try {
        this.db.close();
      } catch (e) {
        // Ignore close errors on corrupted DB
      }
      this.db = null;
    }

    // Delete corrupted file
    try {
      await this.app.vault.adapter.remove(this.dbPath);
      console.log('[SQLiteCacheManager] Deleted corrupted database file');
    } catch (e) {
      console.warn('[SQLiteCacheManager] Could not delete corrupt file:', e);
    }

    // Create fresh database
    this.db = new this.sqlite3.oo1.DB(':memory:');
    this.db.exec(SCHEMA_SQL);

    // Save fresh database to file
    await this.saveToFile();
    console.log('[SQLiteCacheManager] Fresh database created and saved');
  }

  /**
   * Save database to file using sqlite3_js_db_export
   */
  private async saveToFile(): Promise<void> {
    if (!this.db) return;

    try {
      // Export database to Uint8Array
      const data = this.sqlite3.capi.sqlite3_js_db_export(this.db.pointer);

      // Write to vault as binary
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
      console.log('[SQLiteCacheManager] Database closed');
    } catch (error) {
      console.error('[SQLiteCacheManager] Error closing database:', error);
      throw error;
    }
  }

  /**
   * Execute raw SQL (for schema creation and multi-statement execution)
   * NOTE: Does not support parameters - use run() or query() for parameterized queries
   */
  async exec(sql: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.exec(sql);
      this.hasUnsavedData = true;
    } catch (error) {
      console.error('[SQLiteCacheManager] Exec failed:', error);
      throw error;
    }
  }

  /**
   * Query returning multiple rows
   */
  async query<T>(sql: string, params?: any[]): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stmt = this.db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        const results: T[] = [];
        while (stmt.step()) {
          results.push(stmt.get({}) as T);
        }
        return results;
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
  async queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stmt = this.db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        if (stmt.step()) {
          return stmt.get({}) as T;
        }
        return null;
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
  async run(sql: string, params?: any[]): Promise<RunResult> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const stmt = this.db.prepare(sql);
      try {
        if (params?.length) {
          stmt.bind(params);
        }
        stmt.stepReset();
      } finally {
        stmt.finalize();
      }

      // Get changes count and last insert rowid
      const changes = this.db.changes();
      const lastInsertRowid = Number(this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer));

      this.hasUnsavedData = true;
      return { changes, lastInsertRowid };
    } catch (error) {
      console.error('[SQLiteCacheManager] Run failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Begin a transaction
   */
  async beginTransaction(): Promise<void> {
    this.db.exec('BEGIN TRANSACTION');
  }

  /**
   * Commit a transaction
   */
  async commit(): Promise<void> {
    this.db.exec('COMMIT');
    this.hasUnsavedData = true;
  }

  /**
   * Rollback a transaction
   */
  async rollback(): Promise<void> {
    this.db.exec('ROLLBACK');
  }

  /**
   * Execute a function within a transaction
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.beginTransaction();
    try {
      const result = await fn();
      await this.commit();
      return result;
    } catch (error) {
      await this.rollback();
      throw error;
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
    params: any[] = []
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

    return {
      deviceId: result.deviceId,
      lastEventTimestamp: result.lastEventTimestamp,
      fileTimestamps: result.syncedFilesJson ? JSON.parse(result.syncedFilesJson) : {}
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
    await this.transaction(async () => {
      this.db.exec(`
        DELETE FROM messages;
        DELETE FROM conversations;
        DELETE FROM memory_traces;
        DELETE FROM states;
        DELETE FROM sessions;
        DELETE FROM workspaces;
        DELETE FROM applied_events;
        DELETE FROM sync_state;
      `);
    });
  }

  /**
   * Rebuild FTS5 indexes after bulk data changes
   */
  async rebuildFTSIndexes(): Promise<void> {
    await this.transaction(async () => {
      // Rebuild workspace FTS5
      this.db.exec(`
        INSERT INTO workspace_fts(workspace_fts) VALUES ('rebuild');
      `);

      // Rebuild conversation FTS5
      this.db.exec(`
        INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');
      `);

      // Rebuild message FTS5
      this.db.exec(`
        INSERT INTO message_fts(message_fts) VALUES ('rebuild');
      `);
    });
  }

  /**
   * Vacuum the database to reclaim space
   */
  async vacuum(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.exec('VACUUM');
      this.hasUnsavedData = true;
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
  async searchWorkspaces(query: string, limit: number = 50): Promise<any[]> {
    return this.searchService.searchWorkspaces(query, limit);
  }

  /**
   * Search conversations using FTS4
   */
  async searchConversations(query: string, limit: number = 50): Promise<any[]> {
    return this.searchService.searchConversations(query, limit);
  }

  /**
   * Search messages using FTS4
   */
  async searchMessages(query: string, limit: number = 50): Promise<any[]> {
    return this.searchService.searchMessages(query, limit);
  }

  /**
   * Search messages within a specific conversation using FTS4
   */
  async searchMessagesInConversation(conversationId: string, query: string, limit: number = 50): Promise<any[]> {
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
    ]);

    // Get file size from filesystem
    let dbSizeBytes = 0;
    try {
      const exists = await this.app.vault.adapter.exists(this.dbPath);
      if (exists) {
        const stat = await this.app.vault.adapter.stat(this.dbPath);
        dbSizeBytes = stat?.size ?? 0;
      }
    } catch (e) {
      console.warn('[SQLiteCacheManager] Could not get db file size:', e);
    }

    return {
      workspaces: stats[0]?.count ?? 0,
      sessions: stats[1]?.count ?? 0,
      states: stats[2]?.count ?? 0,
      traces: stats[3]?.count ?? 0,
      conversations: stats[4]?.count ?? 0,
      messages: stats[5]?.count ?? 0,
      appliedEvents: stats[6]?.count ?? 0,
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
        applied_events: stats.appliedEvents
      },
      walMode: false  // WASM doesn't use WAL mode
    };
  }
}
