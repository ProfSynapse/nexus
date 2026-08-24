import { LoadStateTool } from '../../src/agents/memoryManager/tools/states/loadState';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { createServiceIntegration } from '../../src/agents/memoryManager/services/ValidationService';

jest.mock('../../src/agents/memoryManager/services/ValidationService', () => ({
  createServiceIntegration: jest.fn()
}));

describe('LoadStateTool', () => {
  const createServiceIntegrationMock = createServiceIntegration as jest.MockedFunction<typeof createServiceIntegration>;

  beforeEach(() => {
    createServiceIntegrationMock.mockReset();
  });

  function createTool(memoryService: Record<string, unknown>, workspaceService: Record<string, unknown>): LoadStateTool {
    createServiceIntegrationMock.mockReturnValue({
      getMemoryService: jest.fn().mockResolvedValue({ success: true, service: memoryService }),
      getWorkspaceService: jest.fn().mockResolvedValue({ success: true, service: workspaceService })
    } as unknown as ReturnType<typeof createServiceIntegration>);

    const agent = {
      getApp: () => ({})
    } as unknown as MemoryManagerAgent;

    return new LoadStateTool(agent);
  }

  it('resolves workspace names and prefers current tags over stale snapshot tags', async () => {
    const matchingState = {
      id: 'state-1',
      name: 'Checkpoint',
      sessionId: 'session-1',
      workspaceId: 'workspace-uuid',
      tags: ['current']
    };
    const loadedState = {
      id: 'state-1',
      name: 'Checkpoint',
      description: 'Checkpoint description',
      sessionId: 'session-1',
      workspaceId: 'workspace-uuid',
      created: Date.now(),
      context: {
        conversationContext: 'Conversation context',
        activeTask: 'Active task',
        activeFiles: ['note.md'],
        nextSteps: ['Continue testing']
      },
      state: {
        metadata: {
          tags: ['stale']
        }
      }
    };
    const memoryService = {
      findState: jest.fn(async (_ws: string, identifier: string, options?: { matchId?: boolean; caseSensitiveName?: boolean }) => {
        const matchId = options?.matchId !== false;
        const cs = options?.caseSensitiveName !== false;
        const same = (n?: string) => (cs ? n === identifier : n?.toLowerCase() === identifier.toLowerCase());
        const pool = [matchingState] as Array<{ id: string; name?: string }>;
        return pool.find(s => matchId && s.id === identifier) ?? pool.find(s => same(s.name)) ?? null;
      }),
      getStates: jest.fn().mockResolvedValue({
        items: [matchingState],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      }),
      getState: jest.fn().mockResolvedValue(loadedState),
      getMemoryTraces: jest.fn().mockResolvedValue({ items: [] })
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Workspace Name'
      }),
      getWorkspace: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Workspace Name'
      })
    };
    const tool = createTool(memoryService, workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        memory: 'Testing load state.',
        goal: 'Verify workspace name resolution.'
      },
      name: 'Checkpoint'
    });

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Workspace Name');
    // Resolved in SQL, not by scanning a page: a pageSize scan could not see
    // a state older than its own page.
    expect(memoryService.findState).toHaveBeenCalledWith('workspace-uuid', 'Checkpoint', { caseSensitiveName: false });
    expect(memoryService.getState).toHaveBeenCalledWith('workspace-uuid', 'session-1', 'state-1');
    expect(result.data).toMatchObject({
      name: 'Checkpoint',
      conversationContext: 'Conversation context',
      activeTask: 'Active task',
      activeFiles: ['note.md'],
      nextSteps: ['Continue testing'],
      description: 'Checkpoint description',
      tags: ['current']
    });
  });

  it('keeps an empty current tag list instead of restoring stale snapshot tags', async () => {
    const memoryService = {
      findState: jest.fn(async (_ws: string, identifier: string, options?: { matchId?: boolean; caseSensitiveName?: boolean }) => {
        const matchId = options?.matchId !== false;
        const cs = options?.caseSensitiveName !== false;
        const same = (n?: string) => (cs ? n === identifier : n?.toLowerCase() === identifier.toLowerCase());
        const pool = [{ id: 'state-1', name: 'Checkpoint', sessionId: 'session-1', workspaceId: 'workspace-uuid', tags: [] }] as Array<{ id: string; name?: string }>;
        return pool.find(s => matchId && s.id === identifier) ?? pool.find(s => same(s.name)) ?? null;
      }),
      getStates: jest.fn().mockResolvedValue({
        items: [{
          id: 'state-1',
          name: 'Checkpoint',
          sessionId: 'session-1',
          workspaceId: 'workspace-uuid',
          tags: []
        }],
        page: 0,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      }),
      getState: jest.fn().mockResolvedValue({
        id: 'state-1',
        name: 'Checkpoint',
        sessionId: 'session-1',
        workspaceId: 'workspace-uuid',
        created: Date.now(),
        context: {
          conversationContext: 'Conversation context',
          activeTask: 'Active task',
          activeFiles: [],
          nextSteps: []
        },
        state: { metadata: { tags: ['stale'] } }
      }),
      getMemoryTraces: jest.fn().mockResolvedValue({ items: [] })
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Workspace Name'
      }),
      getWorkspace: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Workspace Name'
      })
    };
    const tool = createTool(memoryService, workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        memory: 'Testing cleared state tags.',
        goal: 'Verify cleared tags remain empty.'
      },
      name: 'Checkpoint'
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ tags: [] });
  });

  it('returns a clear error when the scoped workspace name cannot be resolved', async () => {
    const memoryService = {
      getStates: jest.fn(),
      getState: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null)
    };
    const tool = createTool(memoryService, workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'Missing Workspace',
        sessionId: 'session-1',
        memory: 'Testing load state.',
        goal: 'Verify workspace name resolution.'
      },
      name: 'Checkpoint'
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Workspace not found: Missing Workspace/);
    expect(memoryService.getStates).not.toHaveBeenCalled();
  });
});
