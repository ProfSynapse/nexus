/**
 * Regression tests for permanent workspace deletion (#219 follow-up).
 *
 * Before the fix, `deleteWorkspace` ran a single
 * `DELETE FROM workspaces WHERE id = ?` and touched no JSONL at all beyond
 * appending a `workspace_deleted` tombstone. Measured in a real vault, deleting
 * a workspace holding 2 sessions / 2 states / 2 traces / 1 project / 2 tasks
 * left behind:
 *
 *   SQLite: sessions 2, states 2, memory_traces 2, projects 1, tasks 2
 *   JSONL:  workspaces/ws_<id>/ (8 events) and tasks/tasks_<id>/ (3 events)
 *
 * and running `rebuildCache()` reproduced the exact same orphan set, because
 * SQLite is dropped and replayed from those two surviving streams. Every test
 * here fails against that code.
 */

import { WorkspaceRepository } from '../../src/database/repositories/WorkspaceRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import { WorkspaceEventApplier } from '../../src/database/sync/WorkspaceEventApplier';
import { ShardedJsonlStreamStore } from '../../src/database/storage/vaultRoot/ShardedJsonlStreamStore';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { SyncCoordinator, type ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { createMockApp } from '../helpers/mockVaultAdapter';

const WS = 'ws-owned';

/** Records every statement so a test can ask "what did the cache actually see?". */
function createRecordingSqlite() {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const cache = {
    run: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return undefined;
    }),
    query: jest.fn(async () => []),
    queryOne: jest.fn(async () => null),
    transaction: jest.fn((fn: () => Promise<unknown>) => fn()),
    getSyncState: jest.fn(async () => null),
    updateSyncState: jest.fn(async () => undefined),
    isEventApplied: jest.fn(async () => false),
    markEventApplied: jest.fn(async () => undefined),
    clearAllData: jest.fn(async () => undefined),
    rebuildFTSIndexes: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined)
  };
  const tablesTouchedBy = (verb: string): string[] =>
    statements
      .filter(s => s.sql.trim().toUpperCase().startsWith(verb))
      .map(s => {
        const m = s.sql.match(/(?:DELETE FROM|INSERT (?:OR (?:REPLACE|IGNORE) )?INTO|UPDATE)\s+([a-zA-Z_]+)/i);
        return m ? m[1] : s.sql;
      });
  return { cache, statements, tablesTouchedBy };
}

describe('permanent workspace delete removes everything the workspace owns', () => {
  // ==========================================================================
  // The replay half. This is what decides the outcome of `rebuildCache()`.
  // ==========================================================================
  describe('WorkspaceEventApplier: replaying workspace_deleted', () => {
    it('purges every workspace-keyed table, not just the workspaces row', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply({
        id: 'evt-del',
        type: 'workspace_deleted',
        deviceId: 'dev',
        timestamp: 10,
        workspaceId: WS
      } as never);

      const deleted = tablesTouchedBy('DELETE');
      // Pre-fix this array was exactly ['workspaces'].
      expect(deleted).toEqual(
        expect.arrayContaining([
          'task_dependencies',
          'task_note_links',
          'tasks',
          'projects',
          'memory_traces',
          'states',
          'sessions',
          'workspaces',
          'trace_embedding_metadata'
        ])
      );
    });

    it('deletes children before the parent rows they are reached through', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply({
        id: 'evt-del',
        type: 'workspace_deleted',
        deviceId: 'dev',
        timestamp: 10,
        workspaceId: WS
      } as never);

      const deleted = tablesTouchedBy('DELETE');
      // task_dependencies/task_note_links are resolved through `tasks`, so the
      // tasks rows must still exist when they run.
      expect(deleted.indexOf('task_dependencies')).toBeLessThan(deleted.indexOf('tasks'));
      expect(deleted.indexOf('task_note_links')).toBeLessThan(deleted.indexOf('tasks'));
      // The workspaces row goes last so nothing is orphaned mid-purge.
      expect(deleted.indexOf('workspaces')).toBe(deleted.length - 1);
    });

    it('leaves conversations alone — they outlive the workspace by design', async () => {
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const applier = new WorkspaceEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply({
        id: 'evt-del',
        type: 'workspace_deleted',
        deviceId: 'dev',
        timestamp: 10,
        workspaceId: WS
      } as never);

      expect(tablesTouchedBy('DELETE')).not.toContain('conversations');
      expect(tablesTouchedBy('DELETE')).not.toContain('messages');
    });
  });

  // ==========================================================================
  // The stream half.
  // ==========================================================================
  describe('ShardedJsonlStreamStore.deleteStream', () => {
    it('removes every shard including cloud-sync conflict copies, then the directory', async () => {
      const { app, adapter } = createMockApp({ initialFiles: {
        'Nexus/data/workspaces/ws_a/shard-000001.jsonl': '{"id":"1"}\n',
        'Nexus/data/workspaces/ws_a/shard-000002.jsonl': '{"id":"2"}\n',
        'Nexus/data/workspaces/ws_a/shard-000002 (1).jsonl': '{"id":"3"}\n'
      }});
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'Nexus/data', maxShardBytes: 1024 });

      await expect(store.deleteStream('workspaces/ws_a')).resolves.toBe(true);

      expect(await adapter.exists('Nexus/data/workspaces/ws_a')).toBe(false);
      expect(await adapter.exists('Nexus/data/workspaces/ws_a/shard-000001.jsonl')).toBe(false);
      // The conflict sibling holds real events; leaving it turns the delete into
      // a partial truncation on the next rebuild.
      expect(await adapter.exists('Nexus/data/workspaces/ws_a/shard-000002 (1).jsonl')).toBe(false);
      expect(await store.readEvents('workspaces/ws_a')).toEqual([]);
    });

    it('is idempotent, so a failed delete can be retried whole', async () => {
      const { app } = createMockApp();
      const store = new ShardedJsonlStreamStore({ app, rootPath: 'Nexus/data', maxShardBytes: 1024 });

      await expect(store.deleteStream('workspaces/ws_missing')).resolves.toBe(false);
    });
  });

  // ==========================================================================
  // The live delete, wired to a real event store over a real (mock) vault.
  // ==========================================================================
  describe('WorkspaceRepository.delete over a real event store', () => {
    function build() {
      const { app, adapter } = createMockApp({ withLocalStorage: true });
      const vaultEventStore = new VaultEventStore({
        app,
        resolution: { resolvedPath: 'Nexus', dataPath: 'Nexus/data', maxShardBytes: 4096 }
      });
      const jsonlWriter = new JSONLWriter({
        app,
        basePath: '.obsidian/plugins/nexus/data',
        readBasePaths: ['.obsidian/plugins/nexus/data'],
        vaultEventStore
      });
      const { cache, tablesTouchedBy } = createRecordingSqlite();
      const deps: RepositoryDependencies = {
        sqliteCache: cache as never,
        jsonlWriter,
        queryCache: new QueryCache()
      };
      return { app, adapter, vaultEventStore, jsonlWriter, cache, tablesTouchedBy, deps };
    }

    /** Seeds both streams a workspace owns with the events a real one carries. */
    async function seedStreams(jsonlWriter: JSONLWriter) {
      await jsonlWriter.appendEvents(`workspaces/ws_${WS}.jsonl`, [
        { type: 'workspace_created', data: { id: WS, name: 'Owned', rootFolder: '/', created: 1 } },
        { type: 'session_created', workspaceId: WS, data: { id: 'sess-1', name: 'S1', startTime: 2 } },
        { type: 'state_saved', workspaceId: WS, sessionId: 'sess-1', data: { id: 'st-1', name: 'St1', created: 3, stateJson: '{}' } },
        { type: 'trace_added', workspaceId: WS, sessionId: 'sess-1', data: { id: 'tr-1', content: 'trace', traceType: 'note' } }
      ] as never);
      await jsonlWriter.appendEvents(`tasks/tasks_${WS}.jsonl`, [
        { type: 'project_created', data: { id: 'proj-1', workspaceId: WS, name: 'P1', status: 'active', created: 4, updated: 4 } },
        { type: 'task_created', data: { id: 'task-1', projectId: 'proj-1', workspaceId: WS, title: 'T1', status: 'todo', priority: 'medium', created: 5, updated: 5 } }
      ] as never);
    }

    it('removes BOTH owned streams, not just the workspace stream', async () => {
      const { jsonlWriter, vaultEventStore, deps } = build();
      await seedStreams(jsonlWriter);
      expect(await vaultEventStore.listFiles('workspaces')).toContain(`workspaces/ws_${WS}.jsonl`);
      expect(await vaultEventStore.listFiles('tasks')).toContain(`tasks/tasks_${WS}.jsonl`);

      await new WorkspaceRepository(deps).delete(WS);

      // The tasks stream is a separate file that no workspace-stream tombstone
      // reaches. Pre-fix both of these still listed.
      expect(await vaultEventStore.listFiles('workspaces')).not.toContain(`workspaces/ws_${WS}.jsonl`);
      expect(await vaultEventStore.listFiles('tasks')).not.toContain(`tasks/tasks_${WS}.jsonl`);
    });

    it('purges the workspace-keyed SQLite tables as well', async () => {
      const { jsonlWriter, deps, tablesTouchedBy } = build();
      await seedStreams(jsonlWriter);

      await new WorkspaceRepository(deps).delete(WS);

      expect(tablesTouchedBy('DELETE')).toEqual(
        expect.arrayContaining(['tasks', 'projects', 'memory_traces', 'states', 'sessions', 'workspaces'])
      );
    });

    it('writes the tombstone before removing the streams', async () => {
      const { jsonlWriter, vaultEventStore, deps } = build();
      await seedStreams(jsonlWriter);
      const appendSpy = jest.spyOn(jsonlWriter, 'appendEvent');
      const removeSpy = jest.spyOn(vaultEventStore, 'deleteStream');

      await new WorkspaceRepository(deps).delete(WS);

      expect(appendSpy).toHaveBeenCalledWith(
        `workspaces/ws_${WS}.jsonl`,
        expect.objectContaining({ type: 'workspace_deleted', workspaceId: WS })
      );
      const tombstoneOrder = appendSpy.mock.invocationCallOrder[0];
      const firstRemovalOrder = removeSpy.mock.invocationCallOrder[0];
      expect(tombstoneOrder).toBeLessThan(firstRemovalOrder);
    });

    describe('partial failure', () => {
      it('does not touch SQLite when a stream cannot be removed, so the delete stays retryable', async () => {
        const { jsonlWriter, deps, tablesTouchedBy } = build();
        await seedStreams(jsonlWriter);
        jest.spyOn(jsonlWriter, 'deleteStream').mockRejectedValue(new Error('vault is locked'));

        await expect(new WorkspaceRepository(deps).delete(WS)).rejects.toThrow(/was not deleted/);

        // Pre-fix, the workspaces row was deleted regardless — a workspace that
        // stopped listing but came straight back on the next rebuild.
        expect(tablesTouchedBy('DELETE')).toEqual([]);
      });

      it('attempts every stream before reporting, so a retry has less to do', async () => {
        const { jsonlWriter, deps } = build();
        await seedStreams(jsonlWriter);
        const deleteStream = jest
          .spyOn(jsonlWriter, 'deleteStream')
          .mockRejectedValue(new Error('vault is locked'));

        await expect(new WorkspaceRepository(deps).delete(WS)).rejects.toThrow();

        expect(deleteStream).toHaveBeenCalledTimes(2);
      });

      it('removes the tasks stream first, so the tombstone survives longest', async () => {
        const { jsonlWriter, deps } = build();
        await seedStreams(jsonlWriter);
        const deleteStream = jest.spyOn(jsonlWriter, 'deleteStream');

        await new WorkspaceRepository(deps).delete(WS);

        expect(deleteStream.mock.calls.map(c => c[0])).toEqual([
          `tasks/tasks_${WS}.jsonl`,
          `workspaces/ws_${WS}.jsonl`
        ]);
      });
    });
  });

  // ==========================================================================
  // The rebuild path — the only test that proves the delete is real.
  // ==========================================================================
  describe('rebuildCache() after a delete', () => {
    it('replays nothing for the deleted workspace', async () => {
      const { app } = createMockApp({ withLocalStorage: true });
      const vaultEventStore = new VaultEventStore({
        app,
        resolution: { resolvedPath: 'Nexus', dataPath: 'Nexus/data', maxShardBytes: 4096 }
      });
      const jsonlWriter = new JSONLWriter({
        app,
        basePath: '.obsidian/plugins/nexus/data',
        readBasePaths: ['.obsidian/plugins/nexus/data'],
        vaultEventStore
      });
      const { cache, statements } = createRecordingSqlite();

      await jsonlWriter.appendEvents(`workspaces/ws_${WS}.jsonl`, [
        { type: 'workspace_created', data: { id: WS, name: 'Owned', rootFolder: '/', created: 1 } },
        { type: 'session_created', workspaceId: WS, data: { id: 'sess-1', name: 'S1', startTime: 2 } },
        { type: 'state_saved', workspaceId: WS, sessionId: 'sess-1', data: { id: 'st-1', name: 'St1', created: 3, stateJson: '{}' } },
        { type: 'trace_added', workspaceId: WS, sessionId: 'sess-1', data: { id: 'tr-1', content: 'trace', traceType: 'note' } }
      ] as never);
      await jsonlWriter.appendEvents(`tasks/tasks_${WS}.jsonl`, [
        { type: 'project_created', data: { id: 'proj-1', workspaceId: WS, name: 'P1', status: 'active', created: 4, updated: 4 } },
        { type: 'task_created', data: { id: 'task-1', projectId: 'proj-1', workspaceId: WS, title: 'T1', status: 'todo', priority: 'medium', created: 5, updated: 5 } }
      ] as never);

      const repo = new WorkspaceRepository({
        sqliteCache: cache as never,
        jsonlWriter,
        queryCache: new QueryCache()
      });
      await repo.delete(WS);

      // Everything up to here is setup; the rebuild is the assertion.
      statements.length = 0;
      const coordinator = new SyncCoordinator(
        jsonlWriter as never,
        cache as unknown as ISQLiteCacheManager
      );
      const result = await coordinator.fullRebuild();

      expect(result.success).toBe(true);
      const writes = statements.filter(s => !/^\s*DELETE/i.test(s.sql));
      const resurrected = writes.filter(s => JSON.stringify(s.params).includes(WS));
      // Pre-fix: the two streams survived, so the rebuild re-inserted the
      // workspace's sessions, states, traces, project and task.
      expect(resurrected).toEqual([]);
    });
  });
});
