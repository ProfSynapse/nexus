import { CreateStateTool } from '../../src/agents/memoryManager/tools/states/createState';
import { CreateStateParams } from '../../src/agents/memoryManager/types';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { createServiceIntegration } from '../../src/agents/memoryManager/services/ValidationService';

jest.mock('../../src/agents/memoryManager/services/ValidationService', () => ({
  createServiceIntegration: jest.fn()
}));

describe('CreateStateTool workspace context', () => {
  const createServiceIntegrationMock = createServiceIntegration as jest.MockedFunction<typeof createServiceIntegration>;

  beforeEach(() => {
    createServiceIntegrationMock.mockReset();
  });

  it('honors the workspaceId injected into tool params instead of falling back to default', async () => {
    const memoryService = {
      getStates: jest.fn().mockResolvedValue({ items: [] }),
      saveState: jest.fn().mockResolvedValue('state-1'),
      getState: jest.fn().mockResolvedValue({
        workspaceId: 'workspace-uuid',
        name: 'diagnostic-state',
        context: { activeTask: 'Diagnostic' }
      }),
      deleteState: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Diagnostic workspace',
        description: 'Workspace used by the create-state diagnostic.',
        rootFolder: '/',
        created: 1,
        lastAccessed: 1,
        isActive: true,
        sessions: {}
      })
    };

    createServiceIntegrationMock.mockReturnValue({
      getMemoryService: jest.fn().mockResolvedValue({ success: true, service: memoryService }),
      getWorkspaceService: jest.fn().mockResolvedValue({ success: true, service: workspaceService })
    } as unknown as ReturnType<typeof createServiceIntegration>);

    const agent = {
      getApp: () => ({})
    } as unknown as MemoryManagerAgent;
    const tool = new CreateStateTool(agent);
    const params: CreateStateParams & { workspaceId: string } = {
      context: {
        workspaceId: 'workspace-uuid',
        sessionId: 'session-1',
        memory: 'Testing create-state workspace scoping.',
        goal: 'Create a state in the requested workspace.'
      },
      workspaceId: 'workspace-uuid',
      name: 'diagnostic-state',
      conversationContext: '## Original Request\nDiagnostic test',
      activeTask: 'Diagnostic',
      activeFiles: ['none'],
      nextSteps: ['Check result'],
      tags: ['diagnostic']
    };

    const result = await tool.execute(params);

    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result).toHaveProperty('recommendations', [
      {
        type: 'state_reference',
        message: expect.stringContaining('State saved as "diagnostic-state"')
      }
    ]);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('workspace-uuid');
    expect(memoryService.getStates).toHaveBeenCalledWith('workspace-uuid');
    expect(memoryService.saveState).toHaveBeenCalledWith(
      'workspace-uuid',
      'session-1',
      expect.objectContaining({
        workspaceId: 'workspace-uuid',
        sessionId: 'session-1',
        name: 'diagnostic-state'
      }),
      'diagnostic-state'
    );
  });

  it('uses the top-level sessionId injected by useTools instead of creating a new session', async () => {
    const memoryService = {
      getStates: jest.fn().mockResolvedValue({ items: [] }),
      saveState: jest.fn().mockResolvedValue('state-1'),
      getState: jest.fn().mockResolvedValue({
        workspaceId: 'workspace-uuid',
        name: 'diagnostic-state',
        context: { activeTask: 'Diagnostic' }
      }),
      deleteState: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Diagnostic workspace',
        description: 'Workspace used by the create-state diagnostic.',
        rootFolder: '/',
        created: 1,
        lastAccessed: 1,
        isActive: true,
        sessions: {}
      })
    };

    createServiceIntegrationMock.mockReturnValue({
      getMemoryService: jest.fn().mockResolvedValue({ success: true, service: memoryService }),
      getWorkspaceService: jest.fn().mockResolvedValue({ success: true, service: workspaceService })
    } as unknown as ReturnType<typeof createServiceIntegration>);

    const agent = {
      getApp: () => ({})
    } as unknown as MemoryManagerAgent;
    const tool = new CreateStateTool(agent);
    const params = {
      workspaceId: 'workspace-uuid',
      sessionId: 'current-session',
      name: 'diagnostic-state',
      conversationContext: '## Original Request\nDiagnostic test',
      activeTask: 'Diagnostic',
      activeFiles: ['none'],
      nextSteps: ['Check result'],
      tags: ['diagnostic']
    } as unknown as CreateStateParams;

    const result = await tool.execute(params);

    expect(result.success).toBe(true);
    expect(memoryService.saveState).toHaveBeenCalledWith(
      'workspace-uuid',
      'current-session',
      expect.objectContaining({
        workspaceId: 'workspace-uuid',
        sessionId: 'current-session',
        name: 'diagnostic-state'
      }),
      'diagnostic-state'
    );
  });
});
