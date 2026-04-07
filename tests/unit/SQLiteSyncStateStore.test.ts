import { SQLiteSyncStateStore } from '../../src/database/storage/SQLiteSyncStateStore';
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
});
