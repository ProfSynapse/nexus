import { CreateWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/createWorkspace';
import { CreateWorkspaceParameters } from '../../src/database/types/workspace/ParameterTypes';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { createServiceIntegration } from '../../src/agents/memoryManager/services/ValidationService';

jest.mock('../../src/agents/memoryManager/services/ValidationService', () => ({
  createServiceIntegration: jest.fn()
}));

describe('CreateWorkspaceTool', () => {
  const createServiceIntegrationMock = createServiceIntegration as jest.MockedFunction<typeof createServiceIntegration>;

  beforeEach(() => {
    createServiceIntegrationMock.mockReset();
  });

  it('returns success and nudges agents that the workspace name is valid for follow-up commands', async () => {
    const workspace = {
      id: 'workspace-uuid',
      name: 'E2E Workspace State Test',
      description: 'End-to-end test workspace.',
      rootFolder: '/',
      created: 1,
      lastAccessed: 1,
      isActive: true,
      sessions: {}
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null),
      createWorkspace: jest.fn().mockResolvedValue(workspace)
    };

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
    const tool = new CreateWorkspaceTool(agent);
    const params = {
      context: {
        workspaceId: 'default',
        sessionId: 'current-session',
        memory: 'Testing create workspace.',
        goal: 'Create a test workspace.'
      },
      name: 'E2E Workspace State Test',
      description: 'End-to-end test workspace.',
      rootFolder: '/',
      purpose: 'End-to-end test workspace.'
    } as CreateWorkspaceParameters;

    const result = await tool.execute(params);

    expect(result.success).toBe(true);
    expect(result.data).toBeUndefined();
    expect(result.recommendations).toEqual([
      {
        type: 'workspace_reference',
        message: expect.stringContaining('Workspace created as "E2E Workspace State Test"')
      }
    ]);
    expect(result.recommendations[0].message).not.toContain('workspace-uuid');
  });
});
