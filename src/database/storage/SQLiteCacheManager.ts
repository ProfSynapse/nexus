/**
 * Location: src/database/storage/SQLiteCacheManager.ts
 * Purpose: SQLite cache manager using sql.js for hybrid storage system
 *
 * Provides:
 * - Local cache for fast queries and true pagination
 * - Can be rebuilt from JSONL files anytime
 * - Full-text search via FTS4
 * - Transaction support
 * - Event tracking to prevent duplicate processing
 *
 * Relationships:
 * - Used by StorageManager for fast queries
 * - Backed by JSONL files in EventLogManager
 * - Implements IStorageBackend interface
 */

// Use asm.js version (pure JS, no external WASM file needed)
// This avoids CDN requests on every startup
import initSqlJs from 'sql.js/dist/sql-asm.js';
import type { Database, SqlJsStatic } from 'sql.js';
import { App } from 'obsidian';
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
  autoSaveInterval?: number; // Auto-save interval in ms (default: 30000)
}

export interface QueryResult<T> {
  items: T[];
  totalCount?: number;
}

/**
 * SQLite cache manager using sql.js
 *
 * Features:
 * - Pure JavaScript SQLite (no native dependencies)
 * - Stored as binary in Obsidian vault
 * - Full-text search with FTS4
 * - Cursor-based pagination
 * - Transaction support
 * - Auto-save with dirty tracking
 */
export class SQLiteCacheManager implements IStorageBackend, ISQLiteCacheManager {
  private app: App;
  private dbPath: string;
  private db: Database | null = null;
  private SQL: SqlJsStatic | null = null;
  private isDirty: boolean = false;
  private autoSaveInterval: number;
  private autoSaveTimer: NodeJS.Timeout | null = null;
  private isInitialized: boolean = false;
  private searchService: SQLiteSearchService;

  constructor(options: SQLiteCacheManagerOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.autoSaveInterval = options.autoSaveInterval ?? 30000;
    this.searchService = new SQLiteSearchService(this);
  }

  /**
   * Initialize sql.js and create/open database
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      console.warn('[SQLiteCacheManager] Already initialized');
      return;
    }

    try {
      // Initialize sql.js (asm.js version - no external files needed)
      this.SQL = await initSqlJs();

      // Try to load existing database
      const existingData = await this.loadDatabaseFile();

      if (existingData) {
        this.db = new this.SQL.Database(existingData);
        console.log('[SQLiteCacheManager] Loaded existing database');

        // Run schema migrations if needed
        const migrator = new SchemaMigrator(this.db);
        const result = await migrator.migrate();

        if (result.applied > 0) {
          console.log(`[SQLiteCacheManager] Applied ${result.applied} migration(s): v${result.fromVersion} -> v${result.toVersion}`);
          // Note: We don't clear data after migrations to avoid OOM during rebuild.
          // New columns will have NULL/default values for existing rows.
          this.isDirty = true;
          await this.save(); // Persist migrations immediately
        }
      } else {
        // Create new database with schema
        this.db = new this.SQL.Database();
        await this.exec(SCHEMA_SQL);
        await this.save(); // Persist the new database
        console.log(`[SQLiteCacheManager] Created new database with schema v${CURRENT_SCHEMA_VERSION}`);
      }

      this.isInitialized = true;

      // Start auto-save timer
      this.startAutoSave();
    } catch (error) {
      console.error('[SQLiteCacheManager] Initialization failed:', error);
      throw error;
    }
  }

  /**
   * Load database file from Obsidian vault
   * Uses raw adapter to support hidden folders (like .nexus/)
   */
  private async loadDatabaseFile(): Promise<Uint8Array | null> {
    try {
      // Use adapter directly - vault.getAbstractFileByPath doesn't work for hidden files
      const exists = await this.app.vault.adapter.exists(this.dbPath);
      if (!exists) {
        console.log(`[SQLiteCacheManager] Database file not found: ${this.dbPath}`);
        return null;
      }

      const arrayBuffer = await this.app.vault.adapter.readBinary(this.dbPath);
      console.log(`[SQLiteCacheManager] Loaded database file: ${this.dbPath} (${arrayBuffer.byteLength} bytes)`);
      return new Uint8Array(arrayBuffer);
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to load database file:', error);
      return null;
    }
  }

  /**
   * Save database to Obsidian vault
   * Uses raw adapter to support hidden folders (like .nexus/)
   */
  async save(): Promise<void> {
    if (!this.db) {
      console.warn('[SQLiteCacheManager] Cannot save: database not initialized');
      return;
    }

    if (!this.isDirty) {
      return; // No changes to save
    }

    try {
      const data = this.db.export();
      // Convert Uint8Array to ArrayBuffer (Obsidian adapter requires ArrayBuffer)
      const buffer = new ArrayBuffer(data.byteLength);
      new Uint8Array(buffer).set(data);

      // Ensure parent directory exists using adapter (works for hidden folders)
      const parentPath = this.dbPath.substring(0, this.dbPath.lastIndexOf('/'));
      const parentExists = await this.app.vault.adapter.exists(parentPath);
      if (!parentExists) {
        await this.app.vault.adapter.mkdir(parentPath);
      }

      // Write directly using adapter (works for hidden folders)
      await this.app.vault.adapter.writeBinary(this.dbPath, buffer);

      this.isDirty = false;
      console.log(`[SQLiteCacheManager] Saved database: ${this.dbPath} (${buffer.byteLength} bytes)`);
    } catch (error) {
      console.error('[SQLiteCacheManager] Failed to save database:', error);
      throw error;
    }
  }

  /**
   * Start auto-save timer
   */
  private startAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
    }

    this.autoSaveTimer = setInterval(async () => {
      if (this.isDirty) {
        try {
          await this.save();
        } catch (error) {
          console.error('[SQLiteCacheManager] Auto-save failed:', error);
        }
      }
    }, this.autoSaveInterval);
  }

  /**
   * Close the database
   */
  async close(): Promise<void> {
    try {
      // Stop auto-save timer
      if (this.autoSaveTimer) {
        clearInterval(this.autoSaveTimer);
        this.autoSaveTimer = null;
      }

      // Save if dirty
      if (this.isDirty) {
        await this.save();
      }

      // Close database
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
   */
  async exec(sql: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.exec(sql);
      this.isDirty = true;
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

      if (params && params.length > 0) {
        stmt.bind(params);
      }

      const results: T[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject() as T);
      }
      stmt.free();

      return results;
    } catch (error) {
      console.error('[SQLiteCacheManager] Query failed:', error, { sql, params });
      throw error;
    }
  }

  /**
   * Query returning single row
   */
  async queryOne<T>(sql: string, params?: any[]): Promise<T | null> {
    const results = await this.query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Run a statement (INSERT, UPDATE, DELETE)
   */
  async run(sql: string, params?: any[]): Promise<RunResult> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      this.db.run(sql, params);
      this.isDirty = true;

      const changes = this.db.getRowsModified();

      // Get last insert rowid via query
      const lastIdResult = this.db.exec('SELECT last_insert_rowid() as id');
      const lastInsertRowid = lastIdResult.length > 0 && lastIdResult[0].values.length > 0
        ? lastIdResult[0].values[0][0] as number
        : 0;

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
    await this.exec('BEGIN TRANSACTION');
  }

  /**
   * Commit a transaction
   */
  async commit(): Promise<void> {
    await this.exec('COMMIT');
  }

  /**
   * Rollback a transaction
   */
  async rollback(): Promise<void> {
    await this.exec('ROLLBACK');
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
      await this.exec(`
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
   * Update FTS indexes after bulk data changes
   */
  async rebuildFTSIndexes(): Promise<void> {
    await this.transaction(async () => {
      // Rebuild workspace FTS (FTS4 uses docid)
      await this.exec(`
        DELETE FROM workspace_fts;
        INSERT INTO workspace_fts(docid, id, name, description)
        SELECT rowid, id, name, description FROM workspaces;
      `);

      // Rebuild conversation FTS
      await this.exec(`
        DELETE FROM conversation_fts;
        INSERT INTO conversation_fts(docid, id, title)
        SELECT rowid, id, title FROM conversations;
      `);

      // Rebuild message FTS
      await this.exec(`
        DELETE FROM message_fts;
        INSERT INTO message_fts(docid, id, conversationId, content, reasoningContent)
        SELECT rowid, id, conversationId, content, reasoningContent FROM messages;
      `);
    });
  }

  /**
   * Vacuum the database to reclaim space
   */
  async vacuum(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      await this.exec('VACUUM');
      await this.save(); // Vacuum requires immediate save
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

    let dbSizeBytes = 0;
    if (this.db) {
      const data = this.db.export();
      dbSizeBytes = data.length;
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
   * Get database path
   */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Check if there are unsaved changes
   */
  hasUnsavedChanges(): boolean {
    return this.isDirty;
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
      walMode: false // sql.js doesn't support WAL mode
    };
  }
}
