/**
 * Regression tests for project and task deletion.
 *
 * Both the live delete and the replay of it said "CASCADE will handle it".
 * It does not — SQLite foreign-key enforcement is per-connection and off by
 * default, and nothing in this plugin turns it on. Measured in a real vault
 * (Obsidian 1.13.7, headless):
 *
 *   delete a project with 3 tasks / 1 dependency edge / 1 note link
 *     after delete : projects 0, tasks 3, task_dependencies 1, task_note_links 1
 *     after rebuild: projects 0, tasks 3, task_dependencies 1, task_note_links 1
 *
 *   delete a single task with 1 incoming dependency / 1 note link / 1 child
 *     after delete : task_dependencies 1, task_note_links 1, child.parentTaskId = <deleted id>
 *     after rebuild: identical
 *
 * The rebuild reproduces the orphans rather than clearing them, because replay
 * re-creates every task from `task_created` and then drops only the parent row.
 * Every test here fails against that code.
 */

import { ProjectRepository } from '../../src/database/repositories/ProjectRepository';
import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import { TaskEventApplier } from '../../src/database/sync/TaskEventApplier';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { type ISQLiteCacheManager } from '../../src/database/sync/SyncCoordinator';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { createMockApp } from '../helpers/mockVaultAdapter';

const WS = 'ws-tasks';
const PROJECT = 'proj-target';
const TASK = 'task-target';

function createRecordingSqlite(row: Record<string, unknown> | null) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const cache = {
    run: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return undefined;
    }),
    query: jest.fn(async () => []),
    queryOne: jest.fn(async () => row),
    transaction: jest.fn((fn: () => Promise<unknown>) => fn()),
    getSyncState: jest.fn(async () => null),
    updateSyncState: jest.fn(async () => undefined),
    isEventApplied: jest.fn(async () => false),
    markEventApplied: jest.fn(async () => undefined),
    clearAllData: jest.fn(async () => undefined),
    rebuildFTSIndexes: jest.fn(async () => undefined),
    save: jest.fn(async () => undefined)
  };
  const touched = (verb: string): string[] =>
    statements
      .filter(s => s.sql.trim().toUpperCase().startsWith(verb))
      .map(s => {
        const m = s.sql.match(/(?:DELETE FROM|INSERT (?:OR (?:REPLACE|IGNORE) )?INTO|UPDATE)\s+([a-zA-Z_]+)/i);
        return m ? m[1] : s.sql;
      });
  return { cache, statements, touched };
}

function buildDeps(row: Record<string, unknown> | null) {
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
  const recording = createRecordingSqlite(row);
  const deps: RepositoryDependencies = {
    sqliteCache: recording.cache as never,
    jsonlWriter,
    queryCache: new QueryCache()
  };
  return { ...recording, jsonlWriter, vaultEventStore, deps };
}

describe('deleting a project takes its tasks with it', () => {
  const tombstone = {
    id: 'evt-proj-del',
    type: 'project_deleted',
    deviceId: 'dev',
    timestamp: 10,
    projectId: PROJECT
  };

  describe('TaskEventApplier: replaying project_deleted', () => {
    it('removes the tasks and their edges, not just the projects row', async () => {
      const { cache, touched } = createRecordingSqlite(null);
      const applier = new TaskEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      // Pre-fix this array was exactly ['projects'].
      expect(touched('DELETE')).toEqual(
        expect.arrayContaining(['task_dependencies', 'task_note_links', 'tasks', 'projects'])
      );
    });

    it('resolves the edges through tasks before the tasks rows are gone', async () => {
      const { cache, touched } = createRecordingSqlite(null);
      const applier = new TaskEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const deleted = touched('DELETE');
      expect(deleted.indexOf('task_dependencies')).toBeLessThan(deleted.indexOf('tasks'));
      expect(deleted.indexOf('task_note_links')).toBeLessThan(deleted.indexOf('tasks'));
      expect(deleted.indexOf('projects')).toBe(deleted.length - 1);
    });

    it('detaches surviving sub-tasks instead of deleting them (parentTaskId is SET NULL)', async () => {
      const { cache, statements } = createRecordingSqlite(null);
      const applier = new TaskEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const detach = statements.find(s => /UPDATE tasks SET parentTaskId = NULL/i.test(s.sql));
      expect(detach).toBeDefined();
      // and it runs while the tasks it references still exist
      const detachIndex = statements.indexOf(detach as { sql: string; params: unknown[] });
      const taskDelete = statements.findIndex(s => /DELETE FROM tasks/i.test(s.sql));
      expect(detachIndex).toBeLessThan(taskDelete);
    });
  });

  describe('ProjectRepository.delete', () => {
    it('writes the tombstone and purges the tasks the project owns', async () => {
      const { deps, touched, vaultEventStore } = buildDeps({
        id: PROJECT, workspaceId: WS, name: 'P', status: 'active', created: 1, updated: 1
      });

      await new ProjectRepository(deps).delete(PROJECT);

      const events = await vaultEventStore.readEvents<{ type: string }>(`tasks/tasks_${WS}.jsonl`);
      expect(events.some(e => e.type === 'project_deleted')).toBe(true);
      // Pre-fix: ['projects'] only, so the three tasks stayed in the cache.
      expect(touched('DELETE')).toEqual(
        expect.arrayContaining(['task_dependencies', 'task_note_links', 'tasks', 'projects'])
      );
    });

    it('scopes the purge to this project, never to the whole workspace', async () => {
      const { deps, statements } = buildDeps({
        id: PROJECT, workspaceId: WS, name: 'P', status: 'active', created: 1, updated: 1
      });

      await new ProjectRepository(deps).delete(PROJECT);

      for (const statement of statements.filter(s => /^\s*(DELETE|UPDATE)/i.test(s.sql))) {
        expect(statement.params).not.toContain(WS);
        expect(statement.params.every(p => p === PROJECT)).toBe(true);
      }
    });
  });
});

describe('deleting a task takes its edges with it', () => {
  const tombstone = {
    id: 'evt-task-del',
    type: 'task_deleted',
    deviceId: 'dev',
    timestamp: 11,
    taskId: TASK
  };

  describe('TaskEventApplier: replaying task_deleted', () => {
    it('removes dependency edges and note links, and detaches children', async () => {
      const { cache, touched, statements } = createRecordingSqlite(null);
      const applier = new TaskEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      // Pre-fix this array was exactly ['tasks'].
      expect(touched('DELETE')).toEqual(
        expect.arrayContaining(['task_dependencies', 'task_note_links', 'tasks'])
      );
      expect(statements.some(s => /UPDATE tasks SET parentTaskId = NULL/i.test(s.sql))).toBe(true);
    });

    it('removes edges in both directions — a task is also a dependency of others', async () => {
      const { cache, statements } = createRecordingSqlite(null);
      const applier = new TaskEventApplier(cache as unknown as ISQLiteCacheManager);

      await applier.apply(tombstone as never);

      const edges = statements.find(s => /DELETE FROM task_dependencies/i.test(s.sql));
      expect(edges?.sql).toMatch(/taskId = \?/i);
      expect(edges?.sql).toMatch(/dependsOnTaskId = \?/i);
    });
  });

  describe('TaskRepository.delete', () => {
    it('purges the edges alongside the task row', async () => {
      const { deps, touched } = buildDeps({
        id: TASK, projectId: PROJECT, workspaceId: WS, title: 'T', status: 'todo',
        priority: 'medium', created: 1, updated: 1
      });

      await new TaskRepository(deps).delete(TASK);

      expect(touched('DELETE')).toEqual(
        expect.arrayContaining(['task_dependencies', 'task_note_links', 'tasks'])
      );
    });
  });
});
