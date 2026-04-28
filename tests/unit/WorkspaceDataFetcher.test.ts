import { WorkspaceDataFetcher } from '../../src/agents/memoryManager/services/WorkspaceDataFetcher';

describe('WorkspaceDataFetcher', () => {
  it('returns adapter-backed states even when mapped state payloads do not include workspaceId', async () => {
    const fetcher = new WorkspaceDataFetcher();
    const memoryService = {
      getSessions: jest.fn(),
      getStates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'state-1',
            name: 'Planning checkpoint',
            description: 'Checkpoint description',
            sessionId: 'session-1',
            created: 123,
            state: {}
          }
        ],
        page: 0,
        pageSize: 5,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      })
    };

    const result = await fetcher.fetchWorkspaceStates('workspace-1', memoryService, {
      page: 0,
      pageSize: 5
    });

    expect(memoryService.getStates).toHaveBeenCalledWith('workspace-1', undefined, {
      page: 0,
      pageSize: 5
    });
    expect(result.items).toEqual([
      {
        id: 'state-1',
        name: 'Planning checkpoint',
        description: 'Checkpoint description',
        sessionId: 'session-1',
        created: 123,
        tags: [],
        workspaceId: undefined
      }
    ]);
    expect(result.totalItems).toBe(1);
  });

  it('preserves session pagination metadata from MemoryService', async () => {
    const fetcher = new WorkspaceDataFetcher();
    const memoryService = {
      getSessions: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'session-1',
            name: 'Session one',
            description: 'First session',
            workspaceId: 'workspace-1',
            created: 456
          }
        ],
        page: 1,
        pageSize: 1,
        totalItems: 3,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: true
      }),
      getStates: jest.fn()
    };

    const result = await fetcher.fetchWorkspaceSessions('workspace-1', memoryService, {
      page: 1,
      pageSize: 1
    });

    expect(memoryService.getSessions).toHaveBeenCalledWith('workspace-1', {
      page: 1,
      pageSize: 1
    });
    expect(result).toEqual({
      items: [
        {
          id: 'session-1',
          name: 'Session one',
          description: 'First session',
          created: 456,
          workspaceId: 'workspace-1'
        }
      ],
      page: 1,
      pageSize: 1,
      totalItems: 3,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true
    });
  });

  it('surfaces state metadata tags and real session IDs from adapter-backed state lists', async () => {
    const fetcher = new WorkspaceDataFetcher();
    const memoryService = {
      getSessions: jest.fn(),
      getStates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'state-1',
            name: 'Verification checkpoint',
            description: 'Checkpoint description',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            created: 789,
            tags: ['test', 'verification'],
            state: {
              state: {
                metadata: {
                  tags: ['test', 'verification']
                }
              }
            }
          }
        ],
        page: 0,
        pageSize: 5,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      })
    };

    const result = await fetcher.fetchWorkspaceStates('workspace-1', memoryService, {
      page: 0,
      pageSize: 5
    });

    expect(result.items[0]).toEqual({
      id: 'state-1',
      name: 'Verification checkpoint',
      description: 'Checkpoint description',
      sessionId: 'session-1',
      created: 789,
      tags: ['test', 'verification'],
      workspaceId: 'workspace-1'
    });
  });

  it('hides the internal workspace-state session from workspace session summaries', async () => {
    const fetcher = new WorkspaceDataFetcher();
    const memoryService = {
      getSessions: jest.fn().mockResolvedValue({
        items: [
          {
            id: '_workspace',
            name: 'Workspace states',
            workspaceId: 'workspace-1',
            created: 100
          },
          {
            id: 'session-1',
            name: 'Session one',
            workspaceId: 'workspace-1',
            created: 200
          }
        ],
        page: 0,
        pageSize: 10,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      }),
      getStates: jest.fn()
    };

    const result = await fetcher.fetchWorkspaceSessions('workspace-1', memoryService);

    expect(result.items).toEqual([
      {
        id: 'session-1',
        name: 'Session one',
        description: undefined,
        created: 200,
        workspaceId: 'workspace-1'
      }
    ]);
  });
});
