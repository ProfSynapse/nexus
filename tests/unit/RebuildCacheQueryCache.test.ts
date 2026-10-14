/**
 * "Nexus: Rebuild cache" must not leave the repositories answering from the
 * database it threw away.
 *
 * Observed live: after a rebuild, `workspaceService.getWorkspace` kept returning
 * the pre-rebuild workspace until the plugin was reloaded. Every repository read
 * goes through one shared `QueryCache` (60 s TTL), and `rebuildCache()` closed,
 * wiped and replayed SQLite without clearing it.
 *
 * Real pieces: node:sqlite with the production `workspaces` DDL, the production
 * `WorkspaceRepository`, `QueryCache`, `SyncCoordinator` and
 * `WorkspaceEventApplier`. Only the event store (an in-memory event list) and
 * the cache-file lifecycle (close / blob remove / reopen) are stand-ins.
 */

import { WorkspaceRepository } from '../../src/database/repositories/WorkspaceRepository';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { SyncCoordinator } from '../../src/database/sync/SyncCoordinator';
import type { IJSONLWriter, ISQLiteCacheManager, SyncResult } from '../../src/database/sync/SyncCoordinator';
import type { ReconcilePipeline } from '../../src/database/sync/ReconcilePipeline';
import { StorageMaintenanceService, type StorageMaintenanceDeps } from '../../src/database/adapters/lifecycle/StorageMaintenanceService';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import type { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import type { StorageEvent, WorkspaceEvent } from '../../src/database/interfaces/StorageEvents';

interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): Record<string, unknown>[];
    get(...params: unknown[]): Record<string, unknown> | undefined;
  };
}

function loadNodeSqlite(): (new (path: string) => NodeSqliteDb) | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('node:sqlite') as { DatabaseSync: new (path: string) => NodeSqliteDb }).DatabaseSync;
  } catch {
    return null;
  }
}

const DatabaseSync = loadNodeSqlite();
const describeWithSqlite = DatabaseSync ? describe : describe.skip;

function openCache() {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA_SQL.replace(
    /CREATE VIRTUAL TABLE IF NOT EXISTS (\w+) USING vec0\([\s\S]*?\);/g,
    'CREATE TABLE IF NOT EXISTS $1 (rowid INTEGER PRIMARY KEY);'
  ));
  const params = (p: unknown[] = []) => p.map(v => (v === undefined ? null : v));
  const cache = {
    run: async (sql: string, p?: unknown[]) => db.prepare(sql).run(...params(p)),
    query: async <T>(sql: string, p?: unknown[]) => db.prepare(sql).all(...params(p)) as T[],
    queryOne: async <T>(sql: string, p?: unknown[]) => (db.prepare(sql).get(...params(p)) ?? null) as T | null,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    getSyncState: async () => null,
    updateSyncState: async () => undefined,
    isEventApplied: async () => false,
    markEventApplied: async () => undefined,
    clearAllData: async () => { db.exec('DELETE FROM sessions; DELETE FROM workspaces;'); },
    rebuildFTSIndexes: async () => undefined,
    save: async () => undefined,
    stopAutoSave: () => undefined,
    close: async () => undefined,
    initialize: async () => undefined
  };
  return { db, cache };
}

const STREAM = 'workspaces/ws_w1.jsonl';
const events: WorkspaceEvent[] = [
  {
    id: 'e1', type: 'workspace_created', deviceId: 'dev', timestamp: 1,
    data: { id: 'w1', name: 'Research', description: 'from creation', rootFolder: '/', created: 1 }
  } as WorkspaceEvent,
  {
    id: 'e2', type: 'workspace_updated', deviceId: 'dev', timestamp: 2,
    workspaceId: 'w1', data: { description: 'from the event store' }
  } as WorkspaceEvent
];

const eventStore: IJSONLWriter = {
  getDeviceId: () => 'dev',
  listFiles: async (category) => (category === 'workspaces' ? [STREAM] : []),
  getFileModTime: async () => null,
  readEvents: async <T extends StorageEvent>() => events as unknown as T[],
  getEventsNotFromDevice: async <T extends StorageEvent>() => [] as T[]
};

describeWithSqlite('rebuildCache clears the repository query cache', () => {
  it('getById answers with the replayed row, not the one read before the rebuild', async () => {
    const { db, cache } = openCache();
    const queryCache = new QueryCache();
    const repo = new WorkspaceRepository({ sqliteCache: cache, jsonlWriter: {}, queryCache } as unknown as RepositoryDependencies);
    const coordinator = new SyncCoordinator(eventStore, cache as unknown as ISQLiteCacheManager);

    // A cache that drifted from the event store — the reason to rebuild.
    db.prepare("INSERT INTO workspaces (id, name, description, rootFolder, created, lastAccessed) VALUES ('w1', 'Research', 'drifted', '/', 1, 1)").run();
    expect((await repo.getById('w1'))?.description).toBe('drifted');

    const maintenance = new StorageMaintenanceService({
      getInitLifecycle: () => ({ isInitialized: () => true }),
      getSqliteCache: () => cache,
      getCacheBlobStore: () => ({ remove: async () => undefined }),
      getSyncCoordinator: () => coordinator,
      getQueryCache: () => queryCache
    } as unknown as StorageMaintenanceDeps);

    await maintenance.rebuildCache();

    expect(db.prepare("SELECT description FROM workspaces WHERE id = 'w1'").get()?.description).toBe('from the event store');
    // Pre-fix: 'drifted' — served from the QueryCache entry made before the rebuild.
    expect((await repo.getById('w1'))?.description).toBe('from the event store');
  });
});

describe('SyncCoordinator.sync: a call that arrives mid-sync waits for the follow-up run', () => {
  it('does not resolve until the queued run has applied its changes', async () => {
    const { cache } = openCache();
    const releases: Array<() => void> = [];
    const finished: number[] = [];
    let runs = 0;
    const pipeline = {
      reconcileAll: jest.fn(async () => {
        const run = ++runs;
        await new Promise<void>(resolve => releases.push(resolve));
        finished.push(run);
        return { success: true, eventsApplied: run, eventsSkipped: 0, errors: [] };
      })
    };
    const coordinator = new SyncCoordinator(eventStore, cache as unknown as ISQLiteCacheManager);
    coordinator.setReconcilePipeline(pipeline as unknown as ReconcilePipeline);

    const first = coordinator.sync();
    let refreshResult: SyncResult | null = null;
    // What "Refresh synced data" does while startup's sync is still running.
    const refresh = coordinator.sync().then(r => { refreshResult = r; });

    await Promise.resolve();
    // Pre-fix: already resolved with a fabricated 0-event success.
    expect(refreshResult).toBeNull();

    releases[0]();
    await first;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(refreshResult).toBeNull();
    expect(pipeline.reconcileAll).toHaveBeenCalledTimes(2);

    releases[1]();
    await refresh;
    expect(finished).toEqual([1, 2]);
    expect(refreshResult).toMatchObject({ success: true, eventsApplied: 2 });
  });
});
