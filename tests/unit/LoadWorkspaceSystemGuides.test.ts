import { LoadWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/loadWorkspace';
import { SYSTEM_GUIDES_WORKSPACE_ID } from '../../src/services/workspace/SystemGuidesWorkspaceProvider';

describe('LoadWorkspaceTool system guides workspace', () => {
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
});
