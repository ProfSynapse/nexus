/**
 * A rejected workspace create must leave nothing in the event store, and a
 * duplicate `workspace_created` already in the store must not undo later edits.
 *
 * Observed live: every plugin load appended one more `workspace_created` for
 * the default workspace, because `WorkspaceRepository.create` appended the
 * event and only then let the SQLite INSERT discover the id/name was taken.
 * The append is outside what the transaction can roll back. After an edit to
 * the default workspace and one more reload, "Nexus: Rebuild cache" replayed
 * the duplicate as INSERT OR REPLACE and the edit was gone — measured in the
 * test vault: description back to its creation text, `created` = last reload.
 *
 * These run against real SQLite (node:sqlite, in-memory) with the production
 * `workspaces` DDL and the production transaction coordinator, so the UNIQUE
 * constraints and the serialization are SQLite's and the coordinator's, not a
 * mock's. Skipped where node:sqlite does not exist (Node < 22.5); CI runs 22.x.
 */

import { WorkspaceRepository } from '../../src/database/repositories/WorkspaceRepository';
import { WorkspaceConflictError } from '../../src/database/repositories/interfaces/IWorkspaceRepository';
import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import { SQLiteTransactionCoordinator } from '../../src/database/storage/SQLiteTransactionCoordinator';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import type { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import type { ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';
import type { WorkspaceEvent } from '../../src/database/interfaces/StorageEvents';

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

/**
 * The production schema, minus sqlite-vec: vec0 virtual tables become plain
 * rowid tables so purge statements that touch them still resolve.
 */
function openCache() {
  const db = new DatabaseSync!(':memory:');
  db.exec(SCHEMA_SQL.replace(
    /CREATE VIRTUAL TABLE IF NOT EXISTS (\w+) USING vec0\([\s\S]*?\);/g,
    'CREATE TABLE IF NOT EXISTS $1 (rowid INTEGER PRIMARY KEY);'
  ));
  const coordinator = new SQLiteTransactionCoordinator();
  const params = (p: unknown[] = []) => p.map(v => (v === undefined ? null : v));
  const cache = {
    run: async (sql: string, p?: unknown[]) => db.prepare(sql).run(...params(p)),
    query: async <T>(sql: string, p?: unknown[]) => db.prepare(sql).all(...params(p)) as T[],
    queryOne: async <T>(sql: string, p?: unknown[]) => (db.prepare(sql).get(...params(p)) ?? null) as T | null,
    transaction: <T>(fn: () => Promise<T>) => coordinator.run(
      async () => { db.exec('BEGIN'); },
      async () => { db.exec('COMMIT'); },
      async () => { db.exec('ROLLBACK'); },
      fn
    ),
    getSyncState: async () => null,
    updateSyncState: async () => undefined,
    isEventApplied: async () => false,
    markEventApplied: async () => undefined,
    clearAllData: async () => undefined,
    rebuildFTSIndexes: async () => undefined,
    save: async () => undefined
  };
  return { db, cache };
}

/** An append-only event log standing in for the sharded JSONL store. */
function createEventLog() {
  const events: Array<WorkspaceEvent & { path: string }> = [];
  let clock = 1000;
  const writer = {
    appendEvent: jest.fn(async (path: string, data: Record<string, unknown>) => {
      const event = { ...data, id: `evt-${events.length + 1}`, deviceId: 'dev', timestamp: clock++ };
      events.push({ ...(event as unknown as WorkspaceEvent), path });
      return event;
    })
  };
  return { events, writer };
}

function createRepository(cache: ReturnType<typeof openCache>['cache'], writer: ReturnType<typeof createEventLog>['writer']) {
  return new WorkspaceRepository({
    sqliteCache: cache,
    jsonlWriter: writer,
    queryCache: new QueryCache()
  } as unknown as RepositoryDependencies);
}

const DEFAULT = { id: 'default', name: 'Default Workspace', description: 'original', rootFolder: '/' };

describeWithSqlite('WorkspaceRepository.create: a rejected create writes no event', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('rejects an existing id before appending to the event store', async () => {
    const { cache } = openCache();
    const log = createEventLog();
    const repo = createRepository(cache, log.writer);
    await repo.create(DEFAULT);

    await expect(repo.create(DEFAULT)).rejects.toBeInstanceOf(WorkspaceConflictError);

    // Pre-fix: 2 — the second workspace_created was appended, then INSERT threw.
    expect(log.events.filter(e => e.type === 'workspace_created')).toHaveLength(1);
    // An expected conflict is the caller's to handle, not a logged storage failure.
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('rejects a taken name under a different id before appending', async () => {
    const { cache } = openCache();
    const log = createEventLog();
    const repo = createRepository(cache, log.writer);
    await repo.create(DEFAULT);

    const attempt = repo.create({ ...DEFAULT, id: 'ws_phantom' });
    await expect(attempt).rejects.toMatchObject({ column: 'name', existingId: 'default' });
    // Keeps the wording WorkspaceService's default-workspace recovery matches on.
    await expect(attempt).rejects.toThrow('UNIQUE constraint failed: workspaces.name');

    expect(log.events.map(e => e.path)).toEqual([expect.stringContaining('ws_default')]);
  });

  it('two repository owners racing on one cache produce exactly one event', async () => {
    const { cache, db } = openCache();
    const log = createEventLog();
    const a = createRepository(cache, log.writer);
    const b = createRepository(cache, log.writer);

    const results = await Promise.allSettled([a.create(DEFAULT), b.create(DEFAULT)]);

    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(log.events).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()?.n).toBe(1);
  });

  it('rolls the row back when the event append fails, so SQLite never gets ahead of JSONL', async () => {
    const { cache, db } = openCache();
    const log = createEventLog();
    log.writer.appendEvent.mockRejectedValueOnce(new Error('disk full'));
    const repo = createRepository(cache, log.writer);

    await expect(repo.create(DEFAULT)).rejects.toThrow('disk full');

    expect(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get()?.n).toBe(0);
  });
});

describeWithSqlite('WorkspaceEventApplier: replaying a duplicate workspace_created', () => {
  const created = (timestamp: number, description: string): WorkspaceEvent => ({
    id: `c-${timestamp}`, type: 'workspace_created', deviceId: 'dev', timestamp,
    data: { id: 'default', name: 'Default Workspace', description, rootFolder: '/', created: timestamp, isActive: true }
  } as WorkspaceEvent);
  const updated = (timestamp: number, description: string): WorkspaceEvent => ({
    id: `u-${timestamp}`, type: 'workspace_updated', deviceId: 'dev', timestamp,
    workspaceId: 'default', data: { description, lastAccessed: timestamp }
  } as WorkspaceEvent);

  async function replay(events: WorkspaceEvent[]) {
    const { cache, db } = openCache();
    const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);
    for (const event of [...events].sort((x, y) => x.timestamp - y.timestamp)) {
      await applier.apply(event);
    }
    return db.prepare('SELECT * FROM workspaces').all();
  }

  it('keeps an edit made before a later duplicate create (the stream every load used to leave)', async () => {
    const rows = await replay([
      created(1, 'original'),
      created(2, 'original'),
      updated(3, 'EDITED'),
      created(4, 'original')
    ]);

    // Pre-fix: description 'original', created 4 — the edit lost on rebuild.
    expect(rows).toEqual([expect.objectContaining({ id: 'default', description: 'EDITED', created: 1 })]);
  });

  it('still re-creates a workspace after it was deleted', async () => {
    const rows = await replay([
      created(1, 'first life'),
      { id: 'd-2', type: 'workspace_deleted', deviceId: 'dev', timestamp: 2, workspaceId: 'default' } as WorkspaceEvent,
      created(3, 'second life')
    ]);

    expect(rows).toEqual([expect.objectContaining({ id: 'default', description: 'second life', created: 3 })]);
  });
});

/**
 * Two `workspace_created` events with one name and different ids.
 *
 * 5.17-5.20.x appended a `workspace_created` even when the live INSERT then
 * failed UNIQUE(name), and two devices can each create the same name before
 * syncing. Each id has its own shard (ws_<id>.jsonl) and a rebuild replays the
 * shards one after another in listing order. Replay used INSERT OR REPLACE, so
 * the second shard's create DELETED the first workspace's row — its edits gone,
 * its sessions/states/projects/tasks pointing at a workspace that no longer
 * existed. The rule now: both rows survive under their own ids, the
 * earliest-created keeps the name, the other becomes "<name> (<id>)", and the
 * result does not depend on shard order.
 */
describeWithSqlite('WorkspaceEventApplier: two workspaces created with one name', () => {
  const create = (id: string, created: number, description: string): WorkspaceEvent => ({
    id: `c-${id}-${created}`, type: 'workspace_created', deviceId: 'dev', timestamp: created,
    data: { id, name: 'Default Workspace', description, rootFolder: '/', created, isActive: true }
  } as WorkspaceEvent);
  const update = (workspaceId: string, timestamp: number, data: Record<string, unknown>): WorkspaceEvent => ({
    id: `u-${workspaceId}-${timestamp}`, type: 'workspace_updated', deviceId: 'dev', timestamp,
    workspaceId, data: { lastAccessed: timestamp, ...data }
  } as WorkspaceEvent);
  const session = (workspaceId: string, timestamp: number): WorkspaceEvent => ({
    id: `s-${workspaceId}`, type: 'session_created', deviceId: 'dev', timestamp,
    workspaceId, data: { id: `session-${workspaceId}`, name: 'S', startTime: timestamp }
  } as WorkspaceEvent);

  // Each array is one shard; shards replay whole, one after another.
  const realShard = [create('default', 10, 'real'), update('default', 20, { description: 'EDITED' }), session('default', 21)];
  const phantomShard = [create('ws_phantom', 30, 'phantom'), session('ws_phantom', 31)];

  async function replayShards(shards: WorkspaceEvent[][]) {
    const { cache, db } = openCache();
    const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);
    for (const shard of shards) {
      for (const event of shard) {
        await applier.apply(event);
      }
    }
    const workspaces = db.prepare('SELECT id, name, description, created FROM workspaces ORDER BY id').all();
    const orphanSessions = db.prepare(
      'SELECT s.id FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspaceId WHERE w.id IS NULL'
    ).all();
    return { workspaces, orphanSessions };
  }

  const expected = [
    { id: 'default', name: 'Default Workspace', description: 'EDITED', created: 10 },
    { id: 'ws_phantom', name: 'Default Workspace (ws_phantom)', description: 'phantom', created: 30 }
  ];

  it('keeps the earlier workspace, its edits and its sessions when the later shard replays second', async () => {
    const result = await replayShards([realShard, phantomShard]);
    // Pre-fix: only ws_phantom survived; session-default was orphaned.
    expect(result.workspaces).toEqual(expected);
    expect(result.orphanSessions).toEqual([]);
  });

  it('gives the same result when the later shard replays first', async () => {
    const result = await replayShards([phantomShard, realShard]);
    expect(result.workspaces).toEqual(expected);
    expect(result.orphanSessions).toEqual([]);
  });

  it('breaks a created-time tie by id, independent of shard order', async () => {
    const a = [create('ws_a', 5, 'a')];
    const b = [create('ws_b', 5, 'b')];
    const forward = await replayShards([a, b]);
    const reversed = await replayShards([b, a]);
    expect(forward.workspaces).toEqual(reversed.workspaces);
    expect(forward.workspaces).toEqual([
      expect.objectContaining({ id: 'ws_a', name: 'Default Workspace' }),
      expect.objectContaining({ id: 'ws_b', name: 'Default Workspace (ws_b)' })
    ]);
  });

  it('applies the rest of an update whose rename collides, instead of failing the event', async () => {
    const result = await replayShards([
      realShard,
      [
        { ...create('ws_other', 40, 'other'), data: { id: 'ws_other', name: 'Other', created: 40, rootFolder: '/' } } as WorkspaceEvent,
        update('ws_other', 50, { name: 'Default Workspace', description: 'kept' })
      ]
    ]);
    // Pre-fix: UNIQUE constraint failed: workspaces.name, and 'kept' never landed.
    expect(result.workspaces).toEqual([
      expect.objectContaining({ id: 'default', name: 'Default Workspace', description: 'EDITED' }),
      expect.objectContaining({ id: 'ws_other', name: 'Default Workspace (ws_other)', description: 'kept' })
    ]);
  });
});

describeWithSqlite('WorkspaceRepository.update: a rejected rename writes no event', () => {
  it('refuses a name another workspace holds before appending', async () => {
    const { cache, db } = openCache();
    const log = createEventLog();
    const repo = createRepository(cache, log.writer);
    await repo.create(DEFAULT);
    await repo.create({ ...DEFAULT, id: 'ws_other', name: 'Other' });

    await expect(repo.update('ws_other', { name: 'Default Workspace', description: 'x' }))
      .rejects.toThrow('UNIQUE constraint failed: workspaces.name');

    // Pre-fix: a workspace_updated was appended, then the UPDATE threw.
    expect(log.events.filter(e => e.type === 'workspace_updated')).toHaveLength(0);
    expect(db.prepare("SELECT name FROM workspaces WHERE id = 'ws_other'").get()?.name).toBe('Other');
  });
});
