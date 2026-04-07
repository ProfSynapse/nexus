import { App } from 'obsidian';

import type { DatabaseStats } from '../interfaces/IStorageBackend';
import type { QueryParams } from '../repositories/base/BaseRepository';
import { SQLiteWasmBridge, SQLiteDatabaseHandle } from './SQLiteWasmBridge';

export interface SQLiteMaintenanceStatistics {
  workspaces: number;
  sessions: number;
  states: number;
  traces: number;
  conversations: number;
  messages: number;
  appliedEvents: number;
  conversationEmbeddings: number;
  dbSizeBytes: number;
}

interface SQLiteMaintenanceServiceOptions {
  app: App;
  dbPath: string;
  bridge: SQLiteWasmBridge;
  getDb: () => SQLiteDatabaseHandle;
  queryOne: <T>(sql: string, params?: QueryParams) => Promise<T | null>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class SQLiteMaintenanceService {
  private readonly app: App;
  private readonly dbPath: string;
  private readonly bridge: SQLiteWasmBridge;
  private readonly getDb: () => SQLiteDatabaseHandle;
  private readonly queryOne: <T>(sql: string, params?: QueryParams) => Promise<T | null>;
  private readonly transaction: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(options: SQLiteMaintenanceServiceOptions) {
    this.app = options.app;
    this.dbPath = options.dbPath;
    this.bridge = options.bridge;
    this.getDb = options.getDb;
    this.queryOne = options.queryOne;
    this.transaction = options.transaction;
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
        conversation_embedding_metadata: stats.conversationEmbeddings
      },
      walMode: false
    };
  }
}
