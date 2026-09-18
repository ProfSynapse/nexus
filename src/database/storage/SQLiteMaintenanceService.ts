import { App } from 'obsidian';

import type { DatabaseStats } from '../interfaces/IStorageBackend';
import type { QueryParams } from '../repositories/base/BaseRepository';
import { SQLiteWasmBridge, SQLiteDatabaseHandle } from './SQLiteWasmBridge';
import type { CacheBlobStore } from './CacheBlobStore';

export interface SQLiteMaintenanceStatistics {
  workspaces: number;
  sessions: number;
  states: number;
  traces: number;
  conversations: number;
  messages: number;
  appliedEvents: number;
  conversationEmbeddings: number;
  /**
   * Row counts for the tables that dominate the persisted blob, added so the
   * "why is the cache 150 MB" question has numbers instead of hypotheses. See
   * docs/plans/sqlite-cache-persistence-plan.md section 6c: the notes index is
   * persisted, per-note, and holds three JSON columns plus an EAV row per
   * frontmatter key, which makes it the first place to look and not `messages`.
   *
   * Each is a plain COUNT(*) and each is independently guarded: a table that is
   * absent (an older cache, a half-applied migration) reports 0 rather than
   * failing the whole statistics call, because this is diagnostics and must
   * never be the reason a startup path throws.
   */
  notes: number;
  noteProperties: number;
  noteEmbeddings: number;
  traceEmbeddings: number;
  dbSizeBytes: number;
  /**
   * Page accounting straight out of SQLite. `pageCount * pageSizeBytes` is the
   * logical size of the database inside the WASM heap, which is what every save
   * has to copy out; `dbSizeBytes` is what the last save actually wrote. A large
   * `freelistCount` means a VACUUM would shrink the blob.
   *
   * Null when the pragma did not answer. Both pragmas are header reads, so they
   * are cheap enough for the startup path that already calls getStatistics().
   */
  pageCount: number | null;
  freelistCount: number | null;
  pageSizeBytes: number | null;
}

/** One row of the dbstat breakdown: bytes and pages held by a single table or index. */
export interface SQLiteObjectPageUsage {
  name: string;
  pages: number;
  bytes: number;
}

interface SQLiteMaintenanceServiceOptions {
  app: App;
  dbPath: string;
  bridge: SQLiteWasmBridge;
  getDb: () => SQLiteDatabaseHandle;
  queryOne: <T>(sql: string, params?: QueryParams) => Promise<T | null>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Optional. When set, getStatistics() prefers this for `dbSizeBytes`. The
   * IDB backend can answer instantly; the file-on-disk backend stat is the
   * fallback used when the blob store returns null.
   */
  blobStore?: CacheBlobStore;
}

export class SQLiteMaintenanceService {
  private readonly app: App;
  private dbPath: string;
  private readonly bridge: SQLiteWasmBridge;
  private readonly getDb: () => SQLiteDatabaseHandle;
  private readonly queryOne: <T>(sql: string, params?: QueryParams) => Promise<T | null>;
  private readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly blobStore?: CacheBlobStore;

  constructor(options: SQLiteMaintenanceServiceOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.bridge = options.bridge;
    this.getDb = options.getDb;
    this.queryOne = options.queryOne;
    this.transaction = options.transaction;
    this.blobStore = options.blobStore;
  }

  setDbPath(dbPath: string): void {
    this.dbPath = dbPath;
  }

  async clearAllData(): Promise<void> {
    await this.transaction(() => {
      const db = this.getDb();
      this.bridge.exec(db, `
        DELETE FROM task_note_links;
        DELETE FROM task_dependencies;
        DELETE FROM tasks;
        DELETE FROM projects;
        DELETE FROM messages;
        DELETE FROM conversations;
        DELETE FROM tool_operation_receipts;
        DELETE FROM memory_traces;
        DELETE FROM states;
        DELETE FROM sessions;
        DELETE FROM workspaces;
        DELETE FROM applied_events;
        DELETE FROM sync_state;
      `);

      this.bridge.exec(db, 'DROP TABLE IF EXISTS conversation_embeddings');
      this.bridge.exec(db, 'CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(embedding float[384])');
      this.bridge.exec(db, 'DELETE FROM conversation_embedding_metadata');
      this.bridge.exec(db, 'DELETE FROM embedding_backfill_state');
      return Promise.resolve();
    });
  }

  async rebuildFTSIndexes(): Promise<void> {
    await this.transaction(() => {
      const db = this.getDb();
      this.bridge.exec(db, `
        INSERT INTO workspace_fts(workspace_fts) VALUES ('rebuild');
      `);
      this.bridge.exec(db, `
        INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');
      `);
      this.bridge.exec(db, `
        INSERT INTO message_fts(message_fts) VALUES ('rebuild');
      `);
      return Promise.resolve();
    });
  }

  vacuum(): Promise<void> {
    try {
      this.bridge.exec(this.getDb(), 'VACUUM');
      return Promise.resolve();
    } catch (error) {
      console.error('[SQLiteCacheManager] Vacuum failed:', error);
      throw error;
    }
  }

  async getStatistics(): Promise<SQLiteMaintenanceStatistics> {
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

    let dbSizeBytes = 0;
    try {
      if (this.blobStore) {
        const meta = await this.blobStore.getMetadata();
        if (meta) {
          dbSizeBytes = meta.size;
        }
      }
      if (dbSizeBytes === 0) {
        // Fallback to filesystem stat — handles legacy installs and the
        // VaultAdapter mobile backend.
        const exists = await this.app.vault.adapter.exists(this.dbPath);
        if (exists) {
          const stat = await this.app.vault.adapter.stat(this.dbPath);
          dbSizeBytes = stat?.size ?? 0;
        }
      }
    } catch {
      void 0;
    }

    const [notes, noteProperties, noteEmbeddings, traceEmbeddings] = await Promise.all([
      this.countRowsOrZero('notes'),
      this.countRowsOrZero('note_properties'),
      this.countRowsOrZero('embedding_metadata'),
      this.countRowsOrZero('trace_embedding_metadata')
    ]);

    const [pageCount, freelistCount, pageSizeBytes] = await Promise.all([
      this.readPragmaNumber('page_count'),
      this.readPragmaNumber('freelist_count'),
      this.readPragmaNumber('page_size')
    ]);

    return {
      workspaces: stats[0]?.count ?? 0,
      sessions: stats[1]?.count ?? 0,
      states: stats[2]?.count ?? 0,
      traces: stats[3]?.count ?? 0,
      conversations: stats[4]?.count ?? 0,
      messages: stats[5]?.count ?? 0,
      appliedEvents: stats[6]?.count ?? 0,
      conversationEmbeddings: stats[7]?.count ?? 0,
      notes,
      noteProperties,
      noteEmbeddings,
      traceEmbeddings,
      dbSizeBytes,
      pageCount,
      freelistCount,
      pageSizeBytes
    };
  }

  /**
   * COUNT(*) that answers 0 instead of throwing when the table is not there.
   *
   * The tables this is used for were added by migration v14 and later, so a
   * cache that has not been migrated yet, or one opened mid-migration, has some
   * of them and not others. getStatistics() is called on a startup path
   * (HybridStorageAdapter.shouldBlockStartupHydration), and diagnostics must
   * never be what makes startup fail.
   */
  private async countRowsOrZero(table: string): Promise<number> {
    try {
      const row = await this.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`);
      return row?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Read a single-value PRAGMA as a number, or null when it does not answer.
   *
   * `page_count`, `freelist_count` and `page_size` are all present in the
   * bundled build (verified against the shipped sqlite3.wasm compile options).
   * The null path is for a database handle that is closed or a build that ever
   * stops exposing them, not for normal operation.
   */
  private async readPragmaNumber(pragma: string): Promise<number | null> {
    try {
      const row = await this.queryOne<Record<string, unknown>>(`PRAGMA ${pragma}`);
      if (!row) return null;
      const value = row[pragma] ?? Object.values(row)[0];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Per-object byte breakdown from the `dbstat` virtual table: which table or
   * index is actually holding the pages. This is the measurement that settles
   * section 6c of docs/plans/sqlite-cache-persistence-plan.md, and with it the
   * question of whether Option E (unpersisting the notes index) is worth
   * anything.
   *
   * `ENABLE_DBSTAT_VTAB` is in the bundled build's compile options, so this is
   * expected to work. It returns null rather than throwing when it does not.
   *
   * DELIBERATELY NOT CALLED FROM getStatistics(). Reading dbstat walks every
   * page of the database, which on the 150 MB cache that motivated the plan is
   * exactly the kind of work that must not land on the startup path
   * getStatistics() already sits on. Call it on demand, from the developer
   * console or a diagnostics command, when you want the breakdown.
   *
   * Results are sorted descending by bytes, so the first row is the answer to
   * "what is the cache made of".
   */
  async getObjectPageUsage(): Promise<SQLiteObjectPageUsage[] | null> {
    try {
      const pageSizeBytes = await this.readPragmaNumber('page_size');
      const rows = this.bridge.query<{ name: string; pages: number; bytes: number }>(
        this.getDb(),
        'SELECT name, COUNT(*) AS pages, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC'
      );
      return rows.map(row => ({
        name: String(row.name),
        pages: Number(row.pages) || 0,
        // SUM(pgsize) is the authoritative figure; fall back to pages times the
        // page size only if this build ever stops reporting pgsize.
        bytes: Number(row.bytes) || (Number(row.pages) || 0) * (pageSizeBytes ?? 0)
      }));
    } catch (error) {
      console.warn(
        '[SQLiteCacheManager] dbstat is not available in this build, so no per-table page breakdown:',
        error
      );
      return null;
    }
  }

  async getStats(): Promise<DatabaseStats> {
    const stats = await this.getStatistics();
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
        conversation_embedding_metadata: stats.conversationEmbeddings,
        notes: stats.notes,
        note_properties: stats.noteProperties,
        embedding_metadata: stats.noteEmbeddings,
        trace_embedding_metadata: stats.traceEmbeddings
      },
      walMode: false
    };
  }
}
