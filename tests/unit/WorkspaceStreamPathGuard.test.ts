/**
 * tests/unit/WorkspaceStreamPathGuard.test.ts — issue #214.
 *
 * Envelope validation (#311, #317) only guards callers that come through
 * `useTools`. Everything below it minted a JSONL path straight from a
 * caller-supplied workspaceId — `workspaces/ws_<id>.jsonl` for session, state,
 * trace and workspace events, `tasks/tasks_<workspaceId>.jsonl` for task and
 * project events — so any string that reached a repository by another door
 * became a directory on disk, silently and permanently. The reporter's census
 * of one real vault found 41 of 56 workspace directories were phantoms,
 * including `ws_--workspaceId`, `ws_--id` and one named `ws_` (the empty id).
 *
 * The guard is structural on purpose: it refuses strings that can be neither a
 * workspace id NOR a workspace name, and asks nothing about whether the
 * workspace exists — that needs the live list, belongs at the envelope, and
 * cannot move down here without every repository depending on the service that
 * owns one of them. So real names with spaces and accents still pass, and a
 * well-formed id for a workspace that no longer exists still passes.
 */
import {
  describeUnusableWorkspaceId,
  workspaceStreamPath,
  taskStreamPath,
  workspaceStreamPathForRemoval
} from '../../src/database/repositories/base/workspaceStreamPath';
import { SessionRepository } from '../../src/database/repositories/SessionRepository';
import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { WorkspaceRepository } from '../../src/database/repositories/WorkspaceRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';
import { VaultEventStore } from '../../src/database/storage/vaultRoot/VaultEventStore';
import { JSONLWriter } from '../../src/database/storage/JSONLWriter';
import { QueryCache } from '../../src/database/optimizations/QueryCache';
import { createMockApp } from '../helpers/mockVaultAdapter';

function createMockDeps(): RepositoryDependencies & { appendEvent: jest.Mock } {
  const appendEvent = jest.fn().mockImplementation((_path: string, ev: Record<string, unknown>) => ({
    ...ev,
    id: 'evt-x',
    timestamp: Date.now(),
    deviceId: 'dev-1'
  }));
  return {
    appendEvent,
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      run: jest.fn(),
      transaction: jest.fn((fn: () => Promise<unknown>) => fn())
    } as never,
    jsonlWriter: {
      appendEvent,
      readEvents: jest.fn().mockResolvedValue([])
    } as never,
    queryCache: {
      cachedQuery: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    } as never
  };
}

describe('workspace stream path guard (#214)', () => {
  describe('ids that must never become a directory', () => {
    // One case per class the census turned up, plus the traversal case the
    // repo's own rule about normalizePath() not stripping ".." implies.
    const rejected: Array<[string, unknown]> = [
      ['the empty id — the directory literally named ws_', ''],
      ['a blank id', '   '],
      ['a padded id', ' default '],
      ['a leaked long flag name', '--workspaceId'],
      ['a leaked short flag name', '--id'],
      ['a single dash argument', '-w'],
      ['a path separator', 'default/nested'],
      ['a windows path separator', 'workspaces\\default'],
      ['a traversal segment', '../../etc/passwd'],
      ['a bare traversal', '..'],
      ['a newline', 'default\ndefault'],
      ['a null byte', 'default\u0000'],
      ['a non-string', 42],
      ['null', null],
      ['undefined', undefined],
      ['an absurdly long id', 'x'.repeat(201)]
    ];

    it.each(rejected)('rejects %s', (_label, value) => {
      expect(describeUnusableWorkspaceId(value)).not.toBeNull();
      expect(() => workspaceStreamPath(value, 'session')).toThrow(/Refusing to store session events/);
      expect(() => taskStreamPath(value, 'task')).toThrow(/Refusing to store task events/);
    });

    // The reason is user-facing steering copy — the model is expected to read it
    // and self-correct — and the checks overlap enough that a deleted clause is
    // silently covered by the next one with the WRONG wording ('' reported as
    // 'blank', '   ' as padded). Pinning each reason is what makes those cases
    // distinguishable.
    it.each([
      ['', 'it is empty'],
      ['   ', 'it is blank'],
      [' default ', 'it has leading or trailing whitespace'],
      ['--workspaceId', 'it looks like a command-line flag, not a workspace'],
      ['default/nested', 'it contains a path separator'],
      // A traversal WITH a slash reports the separator first; '..' is the case
      // that actually exercises the traversal clause.
      ['..', 'it contains a path traversal segment'],
      ['default\u0000', 'it contains control characters'],
      ['x'.repeat(201), 'it is longer than 200 characters']
    ])('explains %j with the reason that actually fits it', (value, reason) => {
      expect(describeUnusableWorkspaceId(value)).toBe(reason);
    });

    it('names the workspace, the reason and the way out', () => {
      expect(() => workspaceStreamPath('--workspaceId', 'trace')).toThrow(
        /"--workspaceId".*command-line flag.*Pass "default" for the global workspace/s
      );
    });
  });

  describe('ids that must keep working', () => {
    // Rejecting any of these would turn a working call into a hard error.
    const accepted: string[] = [
      'default',
      'a8fbad11-7412-49c8-bce0-5690e2c1d197',
      'ws-1',
      '__system_guides__',
      'Desenvolvedor',
      'Desenvolvimento & Automação',           // a real name: spaces and accents
      'Default Workspace',
      '5078340f-0000-0000-0000-000000000000',  // zero-filled: needs the live list
      'a8fbad11',                              // truncated: needs the live list
      'x'.repeat(200)
    ];

    it.each(accepted)('accepts %s', (value) => {
      expect(describeUnusableWorkspaceId(value)).toBeNull();
      expect(workspaceStreamPath(value, 'session')).toBe(`workspaces/ws_${value}.jsonl`);
      expect(taskStreamPath(value, 'task')).toBe(`tasks/tasks_${value}.jsonl`);
    });
  });

  describe('at the repository boundary', () => {
    it('SessionRepository writes no event for the empty workspace id', async () => {
      const deps = createMockDeps();
      const repo = new SessionRepository(deps);

      await expect(
        repo.create({ workspaceId: '', name: 'Session' } as never)
      ).rejects.toThrow(/Refusing to store session events/);
      // Pre-fix this appended session_created to "workspaces/ws_.jsonl".
      expect(deps.appendEvent).not.toHaveBeenCalled();
    });

    it('SessionRepository writes no event for a leaked flag name', async () => {
      const deps = createMockDeps();
      const repo = new SessionRepository(deps);

      await expect(
        repo.create({ workspaceId: '--workspaceId', name: 'Session' } as never)
      ).rejects.toThrow(/Refusing to store session events/);
      expect(deps.appendEvent).not.toHaveBeenCalled();
    });

    it('TaskRepository writes no event for a traversal id', async () => {
      const deps = createMockDeps();
      const repo = new TaskRepository(deps);

      await expect(
        repo.create({ workspaceId: '../../escape', projectId: 'proj-1', title: 'T' } as never)
      ).rejects.toThrow(/Refusing to store task events/);
      expect(deps.appendEvent).not.toHaveBeenCalled();
    });

    it('still writes to the right shard for a real workspace', async () => {
      const deps = createMockDeps();
      const repo = new SessionRepository(deps);

      await repo.create({ workspaceId: 'Desenvolvedor', name: 'Session' } as never);

      expect(deps.appendEvent).toHaveBeenCalledTimes(1);
      expect(deps.appendEvent.mock.calls[0][0]).toBe('workspaces/ws_Desenvolvedor.jsonl');
    });
  });
  // ==========================================================================
  // Removal is NOT a write (#347 interaction).
  //
  // #347 made permanent workspace delete purge every stream the workspace owns.
  // Its first step appends a `workspace_deleted` tombstone, and that append used
  // to be minted by `this.jsonlPath` — the WRITE guard. Applying the write tier
  // to a delete throws before the purge ever runs, so the malformed streams this
  // guard now refuses to CREATE would have become permanently undeletable —
  // exactly the 41-of-56 phantoms in the census that motivated the guard.
  //
  // So removal enforces path safety only. That is still a tightening: before
  // this, a traversal id reached `deleteStream` completely unchecked.
  // ==========================================================================
  describe('removal tier', () => {
    it.each([
      ['the empty id', ''],
      ['a leaked flag name', '--workspaceId'],
      ['a padded id', '  ws-real  '],
      ['an over-long id', 'w'.repeat(250)]
    ])('mints a removal path for %s, which the write tier refuses', (_label, value) => {
      expect(() => workspaceStreamPath(value, 'workspace')).toThrow(/Refusing to store/);
      expect(workspaceStreamPathForRemoval(value, 'workspace')).toBe(`workspaces/ws_${value}.jsonl`);
    });

    it.each([
      ['a traversal id', '../../escape'],
      ['a path separator', 'a/b']
    ])('still refuses %s, because removal cannot escape the stream directory', (_label, value) => {
      expect(() => workspaceStreamPathForRemoval(value, 'workspace')).toThrow(/Refusing to remove/);
    });

    it('lets a pre-existing phantom workspace actually be deleted', async () => {
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
      const deps: RepositoryDependencies = {
        sqliteCache: {
          run: jest.fn(async () => undefined),
          query: jest.fn(async () => []),
          queryOne: jest.fn(async () => null),
          transaction: jest.fn((fn: () => Promise<unknown>) => fn())
        } as never,
        jsonlWriter,
        queryCache: new QueryCache()
      };

      // A phantom that predates the write guard, as found in the real vault.
      const phantom = '--workspaceId';
      await jsonlWriter.appendEvents(`workspaces/ws_${phantom}.jsonl`, [
        { type: 'workspace_created', data: { id: phantom, name: 'Phantom', rootFolder: '/', created: 1 } }
      ] as never);
      expect(await vaultEventStore.listFiles('workspaces')).toContain(`workspaces/ws_${phantom}.jsonl`);

      await new WorkspaceRepository(deps).delete(phantom);

      // With the tombstone minted by the write guard this threw
      // "it looks like a command-line flag" and the stream survived.
      expect(await vaultEventStore.listFiles('workspaces')).not.toContain(`workspaces/ws_${phantom}.jsonl`);
    });
  });
});
