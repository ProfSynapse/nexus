import { SQLiteSyncStateStore, type ShardCursor } from '../../src/database/storage/SQLiteSyncStateStore';
import type { QueryParams } from '../../src/database/repositories/base/BaseRepository';
import type { RunResult } from '../../src/database/interfaces/IStorageBackend';

describe('SQLiteSyncStateStore', () => {
  function createStore() {
    const query = jest.fn<Promise<unknown[]>, [string, QueryParams?]>();
    const queryOne = jest.fn<Promise<unknown>, [string, QueryParams?]>();
    const run = jest.fn<Promise<RunResult>, [string, QueryParams?]>();

    return {
      store: new SQLiteSyncStateStore(
        <T>(sql: string, params?: QueryParams) => query(sql, params) as Promise<T[]>,
        <T>(sql: string, params?: QueryParams) => queryOne(sql, params) as Promise<T | null>,
        run
      ),
      query,
      queryOne,
      run
    };
  }

  it('parses sync-state JSON and keeps only finite numeric timestamps', async () => {
    const { store, queryOne } = createStore();
    queryOne.mockResolvedValue({
      deviceId: 'desktop',
      lastEventTimestamp: 123,
      syncedFilesJson: JSON.stringify({
        'workspaces/a.jsonl': 50,
        'conversations/b.jsonl': 'bad',
        'tasks/c.jsonl': Number.POSITIVE_INFINITY,
        'tasks/d.jsonl': 75
      })
    });

    await expect(store.getSyncState('desktop')).resolves.toEqual({
      deviceId: 'desktop',
      lastEventTimestamp: 123,
      fileTimestamps: {
        'workspaces/a.jsonl': 50,
        'tasks/d.jsonl': 75
      }
    });
  });

  it('returns applied event ids in timestamp order', async () => {
    const { store, query } = createStore();
    query.mockResolvedValue([
      { eventId: 'a' },
      { eventId: 'b' }
    ]);

    await expect(store.getAppliedEventsAfter(100)).resolves.toEqual(['a', 'b']);
    expect(query).toHaveBeenCalledWith(
      'SELECT eventId FROM applied_events WHERE appliedAt > ? ORDER BY appliedAt',
      [100]
    );
  });

  it('persists sync state as JSON', async () => {
    const { store, run } = createStore();
    run.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });

    await store.updateSyncState('desktop', 123, { 'workspaces/a.jsonl': 50 });

    expect(run).toHaveBeenCalledWith(
      `INSERT OR REPLACE INTO sync_state (deviceId, lastEventTimestamp, syncedFilesJson)
       VALUES (?, ?, ?)`,
      ['desktop', 123, '{"workspaces/a.jsonl":50}']
    );
  });

  describe('shard_cursors API', () => {
    const baseCursor: ShardCursor = {
      deviceId: 'desktop',
      shardPath: 'tasks/ws_alpha/shard-000001.jsonl',
      lastEventId: 'evt-7',
      lastOffset: 4096,
      lastTimestamp: 1700000000000,
      kind: 'tasks',
      workspaceKey: 'ws_alpha',
      updatedAt: 1700000001000
    };

    it('returns null when no cursor row exists', async () => {
      const { store, queryOne } = createStore();
      queryOne.mockResolvedValue(null);

      await expect(
        store.getCursor('desktop', 'tasks/ws_alpha/shard-000001.jsonl')
      ).resolves.toBeNull();

      expect(queryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM shard_cursors'),
        ['desktop', 'tasks/ws_alpha/shard-000001.jsonl']
      );
    });

    it('hydrates a cursor row into a ShardCursor', async () => {
      const { store, queryOne } = createStore();
      queryOne.mockResolvedValue({ ...baseCursor });

      await expect(
        store.getCursor('desktop', baseCursor.shardPath)
      ).resolves.toEqual(baseCursor);
    });

    it('upserts a cursor with INSERT OR REPLACE on (deviceId, shardPath)', async () => {
      const { store, run } = createStore();
      run.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });

      await store.upsertCursor(baseCursor);

      const [sql, params] = run.mock.calls[0];
      expect(sql).toContain('INSERT OR REPLACE INTO shard_cursors');
      expect(params).toEqual([
        baseCursor.deviceId,
        baseCursor.shardPath,
        baseCursor.lastEventId,
        baseCursor.lastOffset,
        baseCursor.lastTimestamp,
        baseCursor.kind,
        baseCursor.workspaceKey,
        baseCursor.updatedAt
      ]);
    });

    it('treats canonical and conflict-suffixed shards as distinct cursor rows', async () => {
      const { store, run } = createStore();
      run.mockResolvedValue({ changes: 1, lastInsertRowid: 0 });

      const canonical: ShardCursor = {
        ...baseCursor,
        shardPath: 'tasks/ws_alpha/shard-000001.jsonl',
        lastOffset: 100
      };
      const conflict: ShardCursor = {
        ...baseCursor,
        shardPath: 'tasks/ws_alpha/shard-000001 [Conflict].jsonl',
        lastOffset: 200
      };

      await store.upsertCursor(canonical);
      await store.upsertCursor(conflict);

      const firstParams = run.mock.calls[0][1] as Array<string | number | null>;
      const secondParams = run.mock.calls[1][1] as Array<string | number | null>;
      expect(firstParams[1]).toBe('tasks/ws_alpha/shard-000001.jsonl');
      expect(secondParams[1]).toBe('tasks/ws_alpha/shard-000001 [Conflict].jsonl');
      expect(firstParams[3]).not.toBe(secondParams[3]);
    });

    it('lists all cursors when no filter is passed', async () => {
      const { store, query } = createStore();
      query.mockResolvedValue([{ ...baseCursor }]);

      await expect(store.listCursors()).resolves.toEqual([baseCursor]);

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('FROM shard_cursors');
      expect(sql).not.toContain('WHERE');
      expect(params).toBeUndefined();
    });

    it('applies deviceId, shardPath, and kind filters together', async () => {
      const { store, query } = createStore();
      query.mockResolvedValue([]);

      await store.listCursors({
        deviceId: 'desktop',
        shardPath: baseCursor.shardPath,
        kind: 'tasks'
      });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE deviceId = ? AND shardPath = ? AND kind = ?');
      expect(params).toEqual(['desktop', baseCursor.shardPath, 'tasks']);
    });

    it('applies a single filter independently', async () => {
      const { store, query } = createStore();
      query.mockResolvedValue([]);

      await store.listCursors({ kind: 'workspaces' });

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('WHERE kind = ?');
      expect(sql).not.toContain('deviceId = ?');
      expect(params).toEqual(['workspaces']);
    });
  });
});
