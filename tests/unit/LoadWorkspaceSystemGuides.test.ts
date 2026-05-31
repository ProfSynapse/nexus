import { LoadWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/loadWorkspace';
import { SYSTEM_GUIDES_WORKSPACE_ID } from '../../src/services/workspace/SystemGuidesWorkspaceProvider';

describe('LoadWorkspaceTool system guides workspace', () => {
  const emptyPage = {
    items: [],
    page: 0,
    pageSize: 5,
    totalItems: 0,
    totalPages: 0,
    hasNextPage: false,
    hasPreviousPage: false
  };

  it('returns a bounded docs payload for the reserved guides workspace', async () => {
    const tool = new LoadWorkspaceTool({
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue({
        isSystemWorkspaceId: jest.fn().mockImplementation((id: string) => id === SYSTEM_GUIDES_WORKSPACE_ID),
        loadSystemGuidesWorkspace: jest.fn().mockResolvedValue({
          workspaceContext: {
            purpose: 'Reference documentation.',
            keyFiles: ['Assistant data/guides/index.md']
          },
          data: {
            context: {
              name: 'Assistant guides',
              rootFolder: 'Assistant data/guides',
              recentActivity: ['Start with Assistant data/guides/index.md.']
            },
            workflows: [],
            workflowDefinitions: [],
            workspaceStructure: ['Assistant data/guides/index.md'],
            recentFiles: [{ path: 'Assistant data/guides/index.md', modified: 1 }],
            keyFiles: { 'Assistant data/guides/index.md': '# Assistant guides' },
            preferences: 'Load deeper guide files selectively.',
            sessions: [],
            states: []
          }
        })
      }),
      getApp: jest.fn().mockReturnValue({}),
      plugin: {},
      customPromptStorage: undefined
    } as never);

    const result = await tool.execute({ workspace: SYSTEM_GUIDES_WORKSPACE_ID, limit: 2 });

    expect(result.success).toBe(true);
    expect(result.data.context.name).toBe('Assistant guides');
    expect(result.data.keyFiles['Assistant data/guides/index.md']).toContain('# Assistant guides');
    expect(result.pagination?.sessions.totalItems).toBe(0);
    expect(result.pagination?.states.totalItems).toBe(0);
  });

  it('loads a regular workspace by case-insensitive name and uses the resolved workspace ID downstream', async () => {
    const workspace = {
      id: 'ws-actual-id',
      name: 'My Workspace',
      description: 'Workspace loaded by name',
      rootFolder: 'Projects/My Workspace',
      created: 1000,
      lastAccessed: 2000,
      isActive: true,
      context: {
        purpose: 'Verify name lookup',
        keyFiles: ['Projects/My Workspace/README.md'],
        preferences: 'Use exact workspace names when possible.'
      },
      sessions: {}
    };
    const workspaceService = {
      isSystemWorkspaceId: jest.fn().mockReturnValue(false),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
      updateLastAccessed: jest.fn().mockResolvedValue(undefined)
    };
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue(emptyPage),
      getSessions: jest.fn().mockResolvedValue(emptyPage),
      getStates: jest.fn().mockResolvedValue(emptyPage)
    };
    const app = {
      vault: {
        getAbstractFileByPath: jest.fn().mockReturnValue(null)
      }
    };
    const tool = new LoadWorkspaceTool({
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
      getMemoryService: jest.fn().mockReturnValue(memoryService),
      getCacheManager: jest.fn().mockReturnValue(null),
      getTaskService: jest.fn().mockReturnValue(null),
      getApp: jest.fn().mockReturnValue(app),
      plugin: {},
      customPromptStorage: undefined
    } as never);

    const result = await tool.execute({ workspace: 'my workspace', limit: 5 });

    expect(result.success).toBe(true);
    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('my workspace');
    expect(workspaceService.updateLastAccessed).toHaveBeenCalledWith('ws-actual-id');
    expect(memoryService.getMemoryTraces).toHaveBeenCalledWith('ws-actual-id');
    expect(memoryService.getSessions).toHaveBeenCalledWith('ws-actual-id', {
      page: 0,
      pageSize: 5
    });
    expect(memoryService.getStates).toHaveBeenCalledWith('ws-actual-id', undefined, {
      page: 0,
      pageSize: 5
    });
    expect(result.workspaceContext?.workspaceId).toBe('ws-actual-id');
    expect(result.data.context.name).toBe('My Workspace');
  });
});
