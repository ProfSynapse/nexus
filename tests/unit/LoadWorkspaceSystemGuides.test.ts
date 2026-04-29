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

    const result = await tool.execute({ id: SYSTEM_GUIDES_WORKSPACE_ID, limit: 2 });

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

    const result = await tool.execute({ id: 'my workspace', limit: 5 });

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

  // Regression for #190: prior to PR #191 the WorkspaceDataFetcher dropped every
  // state/session via a defensive filter that always evaluated false. This test
  // proves that non-empty paginated results from getStates / getSessions actually
  // reach data.states / data.sessions instead of being silently emptied.
  it('forwards non-empty sessions and states from MemoryService into the result payload', async () => {
    const workspace = {
      id: 'ws-actual-id',
      name: 'My Workspace',
      description: 'Workspace with sessions and states',
      rootFolder: 'Projects/My Workspace',
      created: 1000,
      lastAccessed: 2000,
      isActive: true,
      context: {
        purpose: 'Verify items survive the pipeline',
        keyFiles: [],
        preferences: ''
      },
      sessions: {}
    };
    const workspaceService = {
      isSystemWorkspaceId: jest.fn().mockReturnValue(false),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
      updateLastAccessed: jest.fn().mockResolvedValue(undefined)
    };
    const sessionsPage = {
      items: [
        {
          id: 'session-1',
          name: 'First session',
          description: 'desc-1',
          startTime: 1500,
          workspaceId: 'ws-actual-id'
        },
        {
          id: 'session-2',
          name: 'Second session',
          startTime: 1800,
          workspaceId: 'ws-actual-id'
        }
      ],
      page: 0,
      pageSize: 5,
      totalItems: 2,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false
    };
    const statesPage = {
      items: [
        {
          id: 'state-1',
          name: 'Planning checkpoint',
          description: 'Snapshot before refactor',
          sessionId: 'session-1',
          workspaceId: 'ws-actual-id',
          created: 1700,
          tags: ['planning'],
          state: {}
        },
        {
          id: 'state-2',
          name: 'Verification checkpoint',
          description: 'Post-refactor verification',
          sessionId: 'session-2',
          workspaceId: 'ws-actual-id',
          created: 1900,
          tags: ['verification'],
          state: {}
        },
        {
          id: 'state-3',
          name: 'Rollback candidate',
          sessionId: 'session-2',
          workspaceId: 'ws-actual-id',
          created: 1950,
          tags: [],
          state: {}
        }
      ],
      page: 0,
      pageSize: 5,
      totalItems: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false
    };
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue(emptyPage),
      getSessions: jest.fn().mockResolvedValue(sessionsPage),
      getStates: jest.fn().mockResolvedValue(statesPage)
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

    const result = await tool.execute({ id: 'ws-actual-id', limit: 5 });

    expect(result.success).toBe(true);

    expect(result.data.sessions).toHaveLength(2);
    expect(result.data.sessions.map(s => s.id)).toEqual(['session-1', 'session-2']);
    expect(result.data.sessions[0]).toMatchObject({
      id: 'session-1',
      name: 'First session',
      description: 'desc-1',
      created: 1500
    });

    expect(result.data.states).toHaveLength(3);
    expect(result.data.states.map(s => s.id)).toEqual(['state-1', 'state-2', 'state-3']);
    expect(result.data.states[0]).toMatchObject({
      id: 'state-1',
      name: 'Planning checkpoint',
      description: 'Snapshot before refactor',
      sessionId: 'session-1',
      created: 1700,
      tags: ['planning']
    });
    expect(result.data.states[2]).toMatchObject({
      id: 'state-3',
      name: 'Rollback candidate',
      sessionId: 'session-2',
      created: 1950
    });

    expect(result.pagination?.sessions.totalItems).toBe(2);
    expect(result.pagination?.states.totalItems).toBe(3);
  });

  // Regression for #190 (silent-drop bug): if a future change re-introduces a
  // defensive workspaceId filter inside WorkspaceDataFetcher, this test fails.
  // It mocks getStates with the legacy shape (no top-level workspaceId, empty
  // `state` placeholder) — i.e. the exact shape that the pre-PR #191 filter
  // rejected. data.states MUST still receive these items.
  it('forwards states even when MemoryService payloads omit top-level workspaceId', async () => {
    const workspace = {
      id: 'ws-actual-id',
      name: 'My Workspace',
      rootFolder: 'Projects/My Workspace',
      created: 1000,
      lastAccessed: 2000,
      isActive: true,
      context: { purpose: '', keyFiles: [], preferences: '' },
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
      // Legacy shape: no top-level workspaceId, no nested state.workspaceId.
      // The pre-PR #191 filter rejected every row that didn't satisfy
      //   state.state?.workspaceId === workspaceId || state.workspaceId === workspaceId
      getStates: jest.fn().mockResolvedValue({
        items: [
          { id: 'legacy-1', name: 'Legacy state 1', created: 1700, state: {} },
          { id: 'legacy-2', name: 'Legacy state 2', created: 1800, state: {} }
        ],
        page: 0,
        pageSize: 5,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      })
    };
    const app = { vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) } };
    const tool = new LoadWorkspaceTool({
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
      getMemoryService: jest.fn().mockReturnValue(memoryService),
      getCacheManager: jest.fn().mockReturnValue(null),
      getTaskService: jest.fn().mockReturnValue(null),
      getApp: jest.fn().mockReturnValue(app),
      plugin: {},
      customPromptStorage: undefined
    } as never);

    const result = await tool.execute({ id: 'ws-actual-id', limit: 5 });

    expect(result.success).toBe(true);
    expect(result.data.states.map(s => s.id)).toEqual(['legacy-1', 'legacy-2']);
  });

  // Regression for #190: the internal '_workspace' bookkeeping session must be
  // hidden from the user-facing session list, but its presence in the upstream
  // page must NOT cause the rest of the sessions to be dropped.
  it('hides the _workspace bookkeeping session without dropping real sessions', async () => {
    const workspace = {
      id: 'ws-actual-id',
      name: 'My Workspace',
      rootFolder: 'Projects/My Workspace',
      created: 1000,
      lastAccessed: 2000,
      isActive: true,
      context: { purpose: '', keyFiles: [], preferences: '' },
      sessions: {}
    };
    const workspaceService = {
      isSystemWorkspaceId: jest.fn().mockReturnValue(false),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(workspace),
      updateLastAccessed: jest.fn().mockResolvedValue(undefined)
    };
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue(emptyPage),
      getSessions: jest.fn().mockResolvedValue({
        items: [
          { id: '_workspace', name: 'Workspace bookkeeping', startTime: 100, workspaceId: 'ws-actual-id' },
          { id: 'session-real', name: 'Real session', startTime: 200, workspaceId: 'ws-actual-id' }
        ],
        page: 0,
        pageSize: 5,
        totalItems: 2,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false
      }),
      getStates: jest.fn().mockResolvedValue(emptyPage)
    };
    const app = { vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) } };
    const tool = new LoadWorkspaceTool({
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
      getMemoryService: jest.fn().mockReturnValue(memoryService),
      getCacheManager: jest.fn().mockReturnValue(null),
      getTaskService: jest.fn().mockReturnValue(null),
      getApp: jest.fn().mockReturnValue(app),
      plugin: {},
      customPromptStorage: undefined
    } as never);

    const result = await tool.execute({ id: 'ws-actual-id', limit: 5 });

    expect(result.success).toBe(true);
    expect(result.data.sessions.map(s => s.id)).toEqual(['session-real']);
  });
});
