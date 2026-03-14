import { WorkspaceRepository } from '../../src/database/repositories/WorkspaceRepository';
import { RepositoryDependencies } from '../../src/database/repositories/base/BaseRepository';

function createMockDeps(): RepositoryDependencies {
  return {
    sqliteCache: {
      queryOne: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      run: jest.fn(),
      transaction: jest.fn((fn: () => Promise<unknown>) => fn())
    } as never,
    jsonlWriter: {
      appendEvent: jest.fn().mockResolvedValue({
        id: 'evt-1',
        type: 'workspace_updated',
        timestamp: Date.now(),
        deviceId: 'dev-1'
      })
    } as never,
    queryCache: {
      cachedQuery: jest.fn((_key: string, fn: () => Promise<unknown>) => fn()),
      invalidateByType: jest.fn(),
      invalidateById: jest.fn(),
      invalidate: jest.fn()
    } as never
  };
}

describe('WorkspaceRepository', () => {
  let repo: WorkspaceRepository;
  let deps: RepositoryDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    repo = new WorkspaceRepository(deps);
  });

  it('persists isArchived on create', async () => {
    await repo.create({
      name: 'Archived Workspace',
      rootFolder: '/',
      isArchived: true
    });

    expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
      expect.stringContaining('workspaces/ws_'),
      expect.objectContaining({
        type: 'workspace_created',
        data: expect.objectContaining({ isArchived: true })
      })
    );

    expect(deps.sqliteCache.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO workspaces'),
      expect.arrayContaining([1, 1])
    );
  });

  it('persists isArchived on update', async () => {
    await repo.update('ws-1', { isArchived: true, lastAccessed: 123 });

    expect(deps.jsonlWriter.appendEvent).toHaveBeenCalledWith(
      'workspaces/ws_ws-1.jsonl',
      expect.objectContaining({
        type: 'workspace_updated',
        workspaceId: 'ws-1',
        data: expect.objectContaining({
          isArchived: true,
          lastAccessed: 123
        })
      })
    );

    expect(deps.sqliteCache.run).toHaveBeenCalledWith(
      expect.stringContaining('isArchived = ?'),
      expect.arrayContaining([1, 123, 'ws-1'])
    );
  });

  it('hydrates isArchived from SQLite rows', async () => {
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({
      id: 'ws-1',
      name: 'Workspace',
      description: null,
      rootFolder: '/',
      created: 1,
      lastAccessed: 2,
      isActive: 1,
      isArchived: 1,
      dedicatedAgentId: null,
      contextJson: null
    });

    const workspace = await repo.getById('ws-1');

    expect(workspace?.isArchived).toBe(true);
  });

  it('supports filtering by isArchived', async () => {
    (deps.sqliteCache.queryOne as jest.Mock).mockResolvedValue({ count: 0 });

    await repo.getWorkspaces({ filter: { isArchived: true } });

    expect(deps.sqliteCache.queryOne).toHaveBeenCalledWith(
      expect.stringContaining('isArchived = ?'),
      [1]
    );
  });
});
