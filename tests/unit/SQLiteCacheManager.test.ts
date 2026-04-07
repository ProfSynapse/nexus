import type { App } from 'obsidian';

jest.mock('@dao-xyz/sqlite3-vec/wasm', () => jest.fn(), { virtual: true });

import { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SQLiteTransactionCoordinator } from '../../src/database/storage/SQLiteTransactionCoordinator';
import { SQLiteSyncStateStore } from '../../src/database/storage/SQLiteSyncStateStore';
import type { QueryParams } from '../../src/database/repositories/base/BaseRepository';

interface DatabaseLike {
  exec: jest.Mock<void, [string]>;
}

interface MutableSQLiteCacheManager extends SQLiteCacheManager {
  app: App & {
    vault: {
      adapter: {
        exists: jest.Mock<Promise<boolean>, [string]>;
        stat: jest.Mock<Promise<{ size?: number } | null>, [string]>;
      };
    };
  };
  bridge: {
    exec(db: DatabaseLike, sql: string): void;
  };
  transactionCoordinator: SQLiteTransactionCoordinator;
  syncStateStore: SQLiteSyncStateStore;
  db: DatabaseLike | null;
  hasUnsavedData: boolean;
  beginTransaction: jest.Mock<Promise<void>, []>;
  commit: jest.Mock<Promise<void>, []>;
  rollback: jest.Mock<Promise<void>, []>;
  queryOne: jest.Mock<Promise<unknown>, [string, QueryParams?]>;
  query: jest.Mock<Promise<unknown[]>, [string, QueryParams?]>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
}

function createManager(): MutableSQLiteCacheManager {
  const manager = Object.create(SQLiteCacheManager.prototype) as MutableSQLiteCacheManager;
  manager.bridge = {
    exec(db: DatabaseLike, sql: string) {
      db.exec(sql);
    }
  };
  manager.app = {
    vault: {
      adapter: {
        exists: jest.fn(),
        stat: jest.fn()
      }
    }
  } as unknown as MutableSQLiteCacheManager['app'];
  manager.transactionCoordinator = new SQLiteTransactionCoordinator();
  manager.db = null;
  manager.hasUnsavedData = false;
  manager.beginTransaction = jest.fn().mockResolvedValue(undefined);
  manager.commit = jest.fn().mockResolvedValue(undefined);
  manager.rollback = jest.fn().mockResolvedValue(undefined);
  manager.queryOne = jest.fn();
  manager.query = jest.fn();
  manager.syncStateStore = new SQLiteSyncStateStore(
    <T>(sql: string, params?: QueryParams) => manager.query(sql, params) as Promise<T[]>,
    <T>(sql: string, params?: QueryParams) => manager.queryOne(sql, params) as Promise<T | null>,
    async () => ({ changes: 0, lastInsertRowid: 0 })
  );
  return manager;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SQLiteCacheManager', () => {
  describe('transaction', () => {
    it('serializes concurrent top-level transactions', async () => {
      const manager = createManager();
      const firstGate = createDeferred<void>();
      const order: string[] = [];

      manager.beginTransaction.mockImplementation(async () => {
        order.push('begin');
      });
      manager.commit.mockImplementation(async () => {
        order.push('commit');
      });

      const first = manager.transaction(async () => {
        order.push('first-start');
        await firstGate.promise;
        order.push('first-end');
        return 'first';
      });

      const second = manager.transaction(async () => {
        order.push('second-start');
        return 'second';
      });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(order).toEqual(['begin', 'first-start']);

      firstGate.resolve();
      await expect(first).resolves.toBe('first');
      await expect(second).resolves.toBe('second');

      expect(order).toEqual([
        'begin',
        'first-start',
        'first-end',
        'commit',
        'begin',
        'second-start',
        'commit'
      ]);
      expect(manager.beginTransaction).toHaveBeenCalledTimes(2);
      expect(manager.commit).toHaveBeenCalledTimes(2);
      expect(manager.rollback).not.toHaveBeenCalled();
    });

    it('does not open a nested SQL transaction', async () => {
      const manager = createManager();

      await manager.transaction(async () => {
        await manager.transaction(async () => {
          return 'nested';
        });
        return 'outer';
      });

      expect(manager.beginTransaction).toHaveBeenCalledTimes(1);
      expect(manager.commit).toHaveBeenCalledTimes(1);
      expect(manager.rollback).not.toHaveBeenCalled();
    });

    it('rolls back when the transaction body throws', async () => {
      const manager = createManager();

      await expect(
        manager.transaction(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');

      expect(manager.beginTransaction).toHaveBeenCalledTimes(1);
      expect(manager.commit).not.toHaveBeenCalled();
      expect(manager.rollback).toHaveBeenCalledTimes(1);
    });
  });

  describe('getSyncState', () => {
    it('parses sync-state JSON and keeps only finite numeric timestamps', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue({
        deviceId: 'desktop',
        lastEventTimestamp: 123,
        syncedFilesJson: JSON.stringify({
          'workspaces/a.jsonl': 50,
          'conversations/b.jsonl': 'bad',
          'tasks/c.jsonl': Number.POSITIVE_INFINITY,
          'tasks/d.jsonl': 75
        })
      });

      const result = await manager.getSyncState('desktop');

      expect(manager.queryOne).toHaveBeenCalledWith(
        'SELECT deviceId, lastEventTimestamp, syncedFilesJson FROM sync_state WHERE deviceId = ?',
        ['desktop']
      );
      expect(result).toEqual({
        deviceId: 'desktop',
        lastEventTimestamp: 123,
        fileTimestamps: {
          'workspaces/a.jsonl': 50,
          'tasks/d.jsonl': 75
        }
      });
    });

    it('returns null when no sync-state row exists', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue(null);

      await expect(manager.getSyncState('desktop')).resolves.toBeNull();
    });
  });

  describe('queryPaginated', () => {
    it('computes pagination metadata and appends limit/offset params', async () => {
      const manager = createManager();
      manager.queryOne.mockResolvedValue({ count: 53 });
      manager.query.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

      const result = await manager.queryPaginated<{ id: string }>(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt',
        'SELECT COUNT(*) as count FROM messages WHERE conversationId = ?',
        { page: 1, pageSize: 25 },
        ['conv-1']
      );

      expect(manager.queryOne).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM messages WHERE conversationId = ?',
        ['conv-1']
      );
      expect(manager.query).toHaveBeenCalledWith(
        'SELECT * FROM messages WHERE conversationId = ? ORDER BY createdAt LIMIT ? OFFSET ?',
        ['conv-1', 25, 25]
      );
      expect(result).toEqual({
        items: [{ id: 'a' }, { id: 'b' }],
        page: 1,
        pageSize: 25,
        totalItems: 53,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true
      });
    });
  });

  describe('maintenance operations', () => {
    it('clearAllData deletes domain tables and recreates vector tables inside a transaction', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };
      const transactionSpy = jest
        .spyOn(manager, 'transaction')
        .mockImplementation(async <T>(fn: () => Promise<T>) => fn());

      await manager.clearAllData();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(dbExec).toHaveBeenCalledTimes(5);
      expect(dbExec.mock.calls[0][0]).toContain('DELETE FROM task_note_links;');
      expect(dbExec.mock.calls[0][0]).toContain('DELETE FROM sync_state;');
      expect(dbExec.mock.calls[1][0]).toBe('DROP TABLE IF EXISTS conversation_embeddings');
      expect(dbExec.mock.calls[2][0]).toBe('CREATE VIRTUAL TABLE IF NOT EXISTS conversation_embeddings USING vec0(embedding float[384])');
      expect(dbExec.mock.calls[3][0]).toBe('DELETE FROM conversation_embedding_metadata');
      expect(dbExec.mock.calls[4][0]).toBe('DELETE FROM embedding_backfill_state');
    });

    it('rebuildFTSIndexes issues rebuild statements inside a transaction', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };
      const transactionSpy = jest
        .spyOn(manager, 'transaction')
        .mockImplementation(async <T>(fn: () => Promise<T>) => fn());

      await manager.rebuildFTSIndexes();

      expect(transactionSpy).toHaveBeenCalledTimes(1);
      expect(dbExec).toHaveBeenCalledTimes(3);
      expect(dbExec.mock.calls[0][0]).toContain("INSERT INTO workspace_fts(workspace_fts) VALUES ('rebuild');");
      expect(dbExec.mock.calls[1][0]).toContain("INSERT INTO conversation_fts(conversation_fts) VALUES ('rebuild');");
      expect(dbExec.mock.calls[2][0]).toContain("INSERT INTO message_fts(message_fts) VALUES ('rebuild');");
    });

    it('vacuum marks the database dirty and executes VACUUM', async () => {
      const manager = createManager();
      const dbExec = jest.fn<void, [string]>();
      manager.db = { exec: dbExec };

      await manager.vacuum();

      expect(dbExec).toHaveBeenCalledWith('VACUUM');
      expect(manager.hasUnsavedData).toBe(true);
    });
  });

  describe('statistics', () => {
    it('getStatistics returns row counts and db file size', async () => {
      const manager = createManager();
      manager.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('workspaces')) return { count: 1 };
        if (sql.includes('sessions')) return { count: 2 };
        if (sql.includes('states')) return { count: 3 };
        if (sql.includes('memory_traces')) return { count: 4 };
        if (sql.includes('conversations')) return { count: 5 };
        if (sql.includes('messages')) return { count: 6 };
        if (sql.includes('applied_events')) return { count: 7 };
        if (sql.includes('conversation_embedding_metadata')) return { count: 8 };
        return null;
      });
      manager.app.vault.adapter.exists.mockResolvedValue(true);
      manager.app.vault.adapter.stat.mockResolvedValue({ size: 4096 });

      await expect(manager.getStatistics()).resolves.toEqual({
        workspaces: 1,
        sessions: 2,
        states: 3,
        traces: 4,
        conversations: 5,
        messages: 6,
        appliedEvents: 7,
        conversationEmbeddings: 8,
        dbSizeBytes: 4096
      });
    });

    it('getStats returns file stats and row totals', async () => {
      const manager = createManager();
      manager.queryOne.mockImplementation(async (sql: string) => {
        if (sql.includes('workspaces')) return { count: 1 };
        if (sql.includes('sessions')) return { count: 2 };
        if (sql.includes('states')) return { count: 3 };
        if (sql.includes('memory_traces')) return { count: 4 };
        if (sql.includes('conversations')) return { count: 5 };
        if (sql.includes('messages')) return { count: 6 };
        if (sql.includes('applied_events')) return { count: 7 };
        if (sql.includes('conversation_embedding_metadata')) return { count: 8 };
        if (sql.includes("sqlite_master")) return { count: 12 };
        return null;
      });
      manager.app.vault.adapter.exists.mockResolvedValue(true);
      manager.app.vault.adapter.stat.mockResolvedValue({ size: 4096 });

      await expect(manager.getStats()).resolves.toEqual({
        fileSize: 4096,
        tableCount: 12,
        totalRows: 1 + 2 + 3 + 4 + 5 + 6,
        tableCounts: {
          workspaces: 1,
          sessions: 2,
          states: 3,
          memory_traces: 4,
          conversations: 5,
          messages: 6,
          applied_events: 7,
          conversation_embedding_metadata: 8
        },
        walMode: false
      });
    });
  });
});
