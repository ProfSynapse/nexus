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
  taskStreamPath
} from '../../src/database/repositories/base/workspaceStreamPath';
import { SessionRepository } from '../../src/database/repositories/SessionRepository';
import { TaskRepository } from '../../src/database/repositories/TaskRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

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
});
