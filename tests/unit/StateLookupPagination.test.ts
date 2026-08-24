/**
 * Resolving a state by name must not be a paginated list scan.
 *
 * `BaseRepository.queryPaginated` defaults `pageSize` to 25 and hard-caps it at
 * 200, so every tool that resolved a state by scanning `getStates(...)` could
 * only ever see the newest page. In a workspace with more than 25 states the
 * older ones were unarchivable, unrestorable, unrenameable, and invisible to
 * the createState name-uniqueness check - while `listStates --page-size 100`
 * happily showed them, so the "not found" error pointed at a list that
 * contradicted it.
 *
 * The mock below is deliberately HONEST about pagination. The pre-existing
 * ArchiveStateTool mock returned every item regardless of `pageSize`, which is
 * exactly why a green suite never caught this. A mock that cannot express the
 * failure cannot fail on it.
 */
import { ArchiveStateTool } from '../../src/agents/memoryManager/tools/states/archiveState';
import { UpdateStateTool } from '../../src/agents/memoryManager/tools/states/updateState';
import type { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import type { WorkspaceState } from '../../src/database/types/session/SessionTypes';
import { StateRepository } from '../../src/database/repositories/StateRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

interface SeedState {
  id: string;
  name: string;
  sessionId: string;
  created: number;
}

/** 30 states, PERF-S01 (oldest) .. PERF-S30 (newest). Mirrors the live repro. */
function seedStates(count = 30): SeedState[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `state-${String(i + 1).padStart(2, '0')}`,
    name: `PERF-S${String(i + 1).padStart(2, '0')}`,
    sessionId: 'session-1',
    created: 1000 + i
  }));
}

function buildWorkspaceState(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    id: 'state-01',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    name: 'PERF-S01',
    description: 'oldest',
    created: 1000,
    state: { workspace: null, recentTraces: [], contextFiles: [], metadata: {} },
    ...over
  } as WorkspaceState;
}

/**
 * A memoryService whose `getStates` pages exactly like BaseRepository, and
 * whose `findState` resolves across the whole workspace the way the SQL
 * lookup does.
 */
function honestMemoryService(states: SeedState[], getStateResult: WorkspaceState | null) {
  const newestFirst = [...states].sort((a, b) => b.created - a.created);

  return {
    getStates: jest.fn(
      async (
        _workspaceId: string,
        _sessionId?: string,
        options?: { pageSize?: number; page?: number }
      ) => {
        // BaseRepository: `Math.min(options.pageSize ?? 25, 200)`.
        const pageSize = Math.min(options?.pageSize ?? 25, 200);
        const page = options?.page ?? 0;
        const items = newestFirst.slice(page * pageSize, page * pageSize + pageSize);
        return {
          items,
          page,
          pageSize,
          totalItems: states.length,
          totalPages: Math.ceil(states.length / pageSize),
          hasNextPage: (page + 1) * pageSize < states.length,
          hasPreviousPage: page > 0
        };
      }
    ),
    findState: jest.fn(
      async (
        _workspaceId: string,
        identifier: string,
        options?: { matchId?: boolean; caseSensitiveName?: boolean }
      ) => {
        const matchId = options?.matchId !== false;
        const caseSensitive = options?.caseSensitiveName !== false;
        const sameName = (n: string) =>
          caseSensitive ? n === identifier : n.toLowerCase() === identifier.toLowerCase();
        return (
          (matchId ? newestFirst.find(s => s.id === identifier) : undefined) ??
          newestFirst.find(s => sameName(s.name)) ??
          null
        );
      }
    ),
    getState: jest.fn().mockResolvedValue(getStateResult),
    updateState: jest.fn().mockResolvedValue(undefined)
  };
}

function buildAgent(memoryService: unknown): MemoryManagerAgent {
  const workspaceService = {
    getWorkspaceByNameOrId: jest.fn().mockResolvedValue({ id: 'workspace-1', name: 'Workspace Name' })
  };
  return {
    getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
    getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
  } as unknown as MemoryManagerAgent;
}

const ctx = {
  workspaceId: 'Workspace Name',
  sessionId: 'session-1',
  memory: 'Testing state lookup.',
  goal: 'Resolve a state older than one page.'
};

describe('resolving a state by name past the first page', () => {
  it('archiveState archives the OLDEST of 30 states (the 25-page-cap bug)', async () => {
    const states = seedStates(30);
    const memoryService = honestMemoryService(states, buildWorkspaceState());
    const tool = new ArchiveStateTool(buildAgent(memoryService));

    const result = await tool.execute({ context: ctx, name: 'PERF-S01' });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(memoryService.updateState).toHaveBeenCalledTimes(1);
    expect(memoryService.updateState.mock.calls[0][2]).toBe('state-01');
    const next = memoryService.updateState.mock.calls[0][3].state as WorkspaceState;
    expect(next.state?.metadata?.isArchived).toBe(true);
  });

  it('archiveState still archives a state inside the first page', async () => {
    const states = seedStates(30);
    const newest = buildWorkspaceState({ id: 'state-30', name: 'PERF-S30', created: 1029 });
    const memoryService = honestMemoryService(states, newest);
    const tool = new ArchiveStateTool(buildAgent(memoryService));

    const result = await tool.execute({ context: ctx, name: 'PERF-S30' });

    expect(result.success).toBe(true);
    expect(memoryService.updateState.mock.calls[0][2]).toBe('state-30');
  });

  it('archiveState resolves by id as well as by name', async () => {
    const states = seedStates(30);
    const memoryService = honestMemoryService(states, buildWorkspaceState());
    const tool = new ArchiveStateTool(buildAgent(memoryService));

    const result = await tool.execute({ context: ctx, name: 'state-01' });

    expect(result.success).toBe(true);
    expect(memoryService.updateState.mock.calls[0][2]).toBe('state-01');
  });

  it('archiveState still reports genuinely missing states as not found', async () => {
    const states = seedStates(30);
    const memoryService = honestMemoryService(states, buildWorkspaceState());
    const tool = new ArchiveStateTool(buildAgent(memoryService));

    const result = await tool.execute({ context: ctx, name: 'PERF-S99' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(memoryService.updateState).not.toHaveBeenCalled();
  });

  it('updateState renames the OLDEST of 30 states', async () => {
    const states = seedStates(30);
    const memoryService = honestMemoryService(states, buildWorkspaceState());
    const tool = new UpdateStateTool(buildAgent(memoryService));

    const result = await tool.execute({ context: ctx, name: 'PERF-S01', newName: 'Renamed' });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(memoryService.updateState.mock.calls[0][2]).toBe('state-01');
  });

  it('updateState rejects a rename that collides with a state past the first page', async () => {
    const states = seedStates(30);
    const memoryService = honestMemoryService(states, buildWorkspaceState({ id: 'state-30', name: 'PERF-S30' }));
    const tool = new UpdateStateTool(buildAgent(memoryService));

    // PERF-S02 is the 29th-newest, well outside the default 25-row page.
    const result = await tool.execute({ context: ctx, name: 'PERF-S30', newName: 'PERF-S02' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('already in use');
    expect(memoryService.updateState).not.toHaveBeenCalled();
  });
});

describe('StateRepository.findState', () => {
  function deps(row: Record<string, unknown> | null) {
    const queryOne = jest.fn().mockResolvedValue(row);
    const query = jest.fn().mockResolvedValue([]);
    return {
      queryOne,
      query,
      deps: {
        sqliteCache: { queryOne, query, run: jest.fn(), transaction: jest.fn((fn: () => Promise<unknown>) => fn()) } as never,
        jsonlWriter: { appendEvent: jest.fn(), readEvents: jest.fn().mockResolvedValue([]) } as never,
        queryCache: {
          cachedQuery: jest.fn((_k: string, fn: () => Promise<unknown>) => fn()),
          invalidateByType: jest.fn(),
          invalidateById: jest.fn(),
          invalidate: jest.fn()
        } as never
      } as RepositoryDependencies
    };
  }

  const row = {
    id: 'state-01',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    name: 'PERF-S01',
    description: 'oldest',
    created: 1000,
    tagsJson: null,
    isArchived: 0
  };

  it('resolves in a single bounded query, with no pagination', async () => {
    const { queryOne, query, deps: d } = deps(row);
    const repo = new StateRepository(d);

    const found = await repo.findState('ws-1', 'PERF-S01');

    expect(found?.id).toBe('state-01');
    expect(queryOne).toHaveBeenCalledTimes(1);
    // The paginated path (`query` + a separate count) must not be used: it is
    // what caps the search at one page.
    expect(query).not.toHaveBeenCalled();

    const sql = queryOne.mock.calls[0][0] as string;
    expect(sql).toContain('LIMIT 1');
    expect(sql).not.toContain('OFFSET');
    expect(sql).toContain('workspaceId = ?');
  });

  it('does not filter archived rows, so restore and rename can find them', async () => {
    const { queryOne, deps: d } = deps({ ...row, isArchived: 1 });
    const repo = new StateRepository(d);

    const found = await repo.findState('ws-1', 'PERF-S01');

    expect(found?.id).toBe('state-01');
    expect(queryOne.mock.calls[0][0] as string).not.toContain('isArchived');
  });

  it('matches name case-insensitively only when asked', async () => {
    const { queryOne, deps: d } = deps(row);
    const repo = new StateRepository(d);

    await repo.findState('ws-1', 'perf-s01', { caseSensitiveName: false });
    expect(queryOne.mock.calls[0][0] as string).toContain('COLLATE NOCASE');

    queryOne.mockClear();
    await repo.findState('ws-1', 'PERF-S01');
    expect(queryOne.mock.calls[0][0] as string).not.toContain('COLLATE NOCASE');
  });

  it('omits the id clause when matching by name only', async () => {
    const { queryOne, deps: d } = deps(row);
    const repo = new StateRepository(d);

    await repo.findState('ws-1', 'PERF-S01', { matchId: false });

    const sql = queryOne.mock.calls[0][0] as string;
    expect(sql).not.toContain('id = ?');
    expect(queryOne.mock.calls[0][1]).toEqual(['ws-1', 'PERF-S01']);
  });

  it('returns null when nothing matches', async () => {
    const { deps: d } = deps(null);
    const repo = new StateRepository(d);

    await expect(repo.findState('ws-1', 'nope')).resolves.toBeNull();
  });
});
