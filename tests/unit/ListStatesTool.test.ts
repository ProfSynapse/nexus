import { ListStatesTool } from '../../src/agents/memoryManager/tools/states/listStates';
import { ListStatesParams } from '../../src/agents/memoryManager/types';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';

describe('ListStatesTool', () => {
  it('returns metadata needed to verify tag filtering and session linkage', async () => {
    const memoryService = {
      getStates: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'state-1',
            name: 'Verification checkpoint',
            description: 'Checkpoint description',
            sessionId: 'session-1',
            workspaceId: 'workspace-1',
            created: 123,
            tags: ['test', 'verification'],
            state: {
              state: {
                metadata: {
                  tags: ['test', 'verification']
                }
              }
            }
          },
          {
            id: 'state-2',
            name: 'Other checkpoint',
            description: 'Other description',
            sessionId: 'session-2',
            workspaceId: 'workspace-1',
            created: 100,
            tags: ['other'],
            state: {
              state: {
                metadata: {
                  tags: ['other']
                }
              }
            }
          }
        ],
        page: 0,
        pageSize: 10,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      })
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Workspace Name'
      })
    };
    const agent = {
      getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
    } as unknown as MemoryManagerAgent;
    const tool = new ListStatesTool(agent);
    const params: ListStatesParams = {
      context: {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        memory: 'Testing list states.',
        goal: 'Verify metadata is visible.'
      },
      tags: ['test']
    };

    const result = await tool.execute(params);

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Workspace Name');
    expect(memoryService.getStates).toHaveBeenCalledWith('workspace-1', undefined, {
      page: 0,
      pageSize: undefined
    });
    expect(result.data).toEqual([
      {
        id: 'state-1',
        name: 'Verification checkpoint',
        description: 'Checkpoint description',
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        created: 123,
        tags: ['test', 'verification']
      }
    ]);
  });

  it('returns a clear error when the scoped workspace name cannot be resolved', async () => {
    const memoryService = {
      getStates: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null)
    };
    const agent = {
      getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
    } as unknown as MemoryManagerAgent;
    const tool = new ListStatesTool(agent);

    const result = await tool.execute({
      context: {
        workspaceId: 'Missing Workspace',
        sessionId: 'session-1',
        memory: 'Testing list states.',
        goal: 'Verify workspace name resolution.'
      }
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Workspace not found: Missing Workspace/);
    expect(memoryService.getStates).not.toHaveBeenCalled();
  });
});
