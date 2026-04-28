import { UpdateWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/updateWorkspace';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { createServiceIntegration } from '../../src/agents/memoryManager/services/ValidationService';

jest.mock('../../src/agents/memoryManager/services/ValidationService', () => ({
  createServiceIntegration: jest.fn()
}));

describe('UpdateWorkspaceTool', () => {
  const createServiceIntegrationMock = createServiceIntegration as jest.MockedFunction<typeof createServiceIntegration>;

  beforeEach(() => {
    createServiceIntegrationMock.mockReset();
  });

  function createTool(workspaceService: Record<string, unknown>): UpdateWorkspaceTool {
    createServiceIntegrationMock.mockReturnValue({
      getWorkspaceService: jest.fn().mockResolvedValue({ success: true, service: workspaceService })
    } as unknown as ReturnType<typeof createServiceIntegration>);

    const agent = {
      getApp: () => ({
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue({ path: '/' }),
          createFolder: jest.fn()
        }
      })
    } as unknown as MemoryManagerAgent;

    return new UpdateWorkspaceTool(agent);
  }

  it('uses the explicit id argument as a workspace ID or name and applies name as the rename value', async () => {
    const workspace = {
      id: 'workspace-uuid',
      name: 'E2E Workspace Name Handle Test',
      description: 'Original description.',
      rootFolder: '/',
      created: 1,
      lastAccessed: 1,
      isActive: true,
      sessions: {},
      context: {
        purpose: 'Original purpose.'
      }
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
      updateWorkspace: jest.fn().mockResolvedValue(undefined)
    };
    const tool = createTool(workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'default',
        sessionId: 'current-session',
        memory: 'Testing update workspace.',
        goal: 'Rename a workspace by name.'
      },
      id: 'E2E Workspace Name Handle Test',
      name: 'Renamed Workspace',
      description: 'Updated description.'
    });

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('E2E Workspace Name Handle Test');
    expect(workspaceService.updateWorkspace).toHaveBeenCalledWith(
      'workspace-uuid',
      expect.objectContaining({
        id: 'workspace-uuid',
        name: 'Renamed Workspace',
        description: 'Updated description.'
      })
    );
  });

  it('keeps legacy direct workspaceId calls working as an internal fallback', async () => {
    const workspace = {
      id: 'workspace-uuid',
      name: 'Workspace',
      rootFolder: '/',
      created: 1,
      lastAccessed: 1,
      isActive: true,
      sessions: {}
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
      updateWorkspace: jest.fn().mockResolvedValue(undefined)
    };
    const tool = createTool(workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'default',
        sessionId: 'current-session',
        memory: 'Testing legacy update.',
        goal: 'Update a workspace by legacy workspaceId.'
      },
      workspaceId: 'workspace-uuid',
      description: 'Updated description.'
    });

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('workspace-uuid');
  });

  it('fails with clear guidance when no target workspace identifier is provided', async () => {
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn(),
      updateWorkspace: jest.fn()
    };
    const tool = createTool(workspaceService);

    const result = await tool.execute({
      context: {
        workspaceId: 'default',
        sessionId: 'current-session',
        memory: 'Testing missing target.',
        goal: 'Update should require a target.'
      },
      description: 'Updated description.'
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Workspace identifier is required/);
    expect(workspaceService.getWorkspaceByNameOrId).not.toHaveBeenCalled();
    expect(workspaceService.updateWorkspace).not.toHaveBeenCalled();
  });
});
