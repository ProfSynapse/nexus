/**
 * Tests for SearchWorkspacesTool - workspace search with strict single-match auto-load.
 */

import { SearchWorkspacesTool } from '../../src/agents/memoryManager/tools/workspaces/searchWorkspaces';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { WorkspaceMetadata } from '../../src/types/storage/StorageTypes';
import { SearchWorkspacesParameters } from '../../src/database/types/workspace/ParameterTypes';

function makeWorkspace(id: string, name: string, extra: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata {
  return {
    id,
    name,
    rootFolder: 'Notes',
    created: 1000,
    lastAccessed: 1000,
    sessionCount: 0,
    traceCount: 0,
    ...extra
  };
}

const BASE_CONTEXT = {
  workspaceId: 'default',
  sessionId: 'session-1',
  memory: 'Looking for the research workspace.',
  goal: 'Find and open it.'
};

function params(overrides: Partial<SearchWorkspacesParameters> = {}): SearchWorkspacesParameters {
  return {
    context: BASE_CONTEXT,
    query: 'research',
    ...overrides
  } as SearchWorkspacesParameters;
}

describe('SearchWorkspacesTool', () => {
  function createTool(options: {
    workspaces?: WorkspaceMetadata[];
    workspaceService?: unknown;
    executeTool?: jest.Mock;
  } = {}): { tool: SearchWorkspacesTool; executeTool: jest.Mock } {
    const executeTool = options.executeTool
      ?? jest.fn().mockResolvedValue({ success: true, data: { workspace: 'loaded' } });

    const workspaceService = 'workspaceService' in options
      ? options.workspaceService
      : { listWorkspaces: jest.fn().mockResolvedValue(options.workspaces ?? []) };

    const agent = {
      getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
      executeTool
    } as unknown as MemoryManagerAgent;

    return { tool: new SearchWorkspacesTool(agent), executeTool };
  }

  it('rejects an empty query without touching the service', async () => {
    const { tool } = createTool();

    const result = await tool.execute(params({ query: '   ' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('query is required');
    expect(result.data.matches).toEqual([]);
  });

  it('errors cleanly when the workspace service is unavailable', async () => {
    const { tool } = createTool({ workspaceService: null });

    const result = await tool.execute(params());

    expect(result.success).toBe(false);
    expect(result.error).toBe('WorkspaceService not available');
  });

  it('surfaces a service query failure as an error result', async () => {
    const { tool } = createTool({
      workspaceService: { listWorkspaces: jest.fn().mockRejectedValue(new Error('cache cold')) }
    });

    const result = await tool.execute(params());

    expect(result.success).toBe(false);
    expect(result.error).toContain('cache cold');
  });

  it('returns an empty match set with a list-workspaces fallback nudge', async () => {
    const { tool, executeTool } = createTool({ workspaces: [makeWorkspace('a', 'Cooking')] });

    const result = await tool.execute(params({ load: true }));

    expect(result.success).toBe(true);
    expect(result.data.totalMatches).toBe(0);
    expect(result.data.autoLoaded).toBe(false);
    expect(result.data.nudge).toContain('list-workspaces');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('returns lean matches without loading when load is not requested', async () => {
    const { tool, executeTool } = createTool({
      workspaces: [makeWorkspace('a', 'Research'), makeWorkspace('b', 'Research Archive')]
    });

    const result = await tool.execute(params());

    expect(result.data.autoLoaded).toBe(false);
    expect(result.data.matches.map(m => m.id)).toEqual(['a', 'b']);
    expect(result.data.matches[0]).toMatchObject({ name: 'Research', matchedOn: ['name'] });
    expect(result.data.workspace).toBeUndefined();
    expect(result.data.nudge).toContain('memory load-workspace "a"');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('auto-loads when load is requested and exactly one workspace matches', async () => {
    const { tool, executeTool } = createTool({
      workspaces: [makeWorkspace('a', 'Research'), makeWorkspace('b', 'Cooking')]
    });

    const result = await tool.execute(params({ load: true }));

    expect(result.data.autoLoaded).toBe(true);
    expect(result.data.workspace).toEqual({ success: true, data: { workspace: 'loaded' } });
    expect(result.data.nudge).toBeUndefined();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith(
      'loadWorkspace',
      expect.objectContaining({ workspace: 'a', context: BASE_CONTEXT })
    );
  });

  it('does not auto-load when several workspaces match', async () => {
    const { tool, executeTool } = createTool({
      workspaces: [makeWorkspace('a', 'Research'), makeWorkspace('b', 'Research Archive')]
    });

    const result = await tool.execute(params({ load: true }));

    expect(result.data.autoLoaded).toBe(false);
    expect(result.data.nudge).toContain('2 workspaces matched');
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('does not let limit truncation manufacture a single-match auto-load', async () => {
    const { tool, executeTool } = createTool({
      workspaces: [makeWorkspace('a', 'Research'), makeWorkspace('b', 'Research Archive')]
    });

    const result = await tool.execute(params({ load: true, limit: 1 }));

    expect(result.data.matches).toHaveLength(1);
    expect(result.data.totalMatches).toBe(2);
    expect(result.data.autoLoaded).toBe(false);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('excludes archived workspaces unless includeArchived is set', async () => {
    const workspaces = [
      makeWorkspace('a', 'Research'),
      makeWorkspace('b', 'Research Archive', { isArchived: true })
    ];

    const { tool } = createTool({ workspaces });
    const excluded = await tool.execute(params());
    expect(excluded.data.matches.map(m => m.id)).toEqual(['a']);

    const { tool: tool2 } = createTool({ workspaces });
    const included = await tool2.execute(params({ includeArchived: true }));
    expect(included.data.matches.map(m => m.id)).toEqual(['a', 'b']);
  });

  it('reports a failed auto-load as a successful search with a retry nudge', async () => {
    const { tool } = createTool({
      workspaces: [makeWorkspace('a', 'Research')],
      executeTool: jest.fn().mockResolvedValue({ success: false, error: 'workspace not found' })
    });

    const result = await tool.execute(params({ load: true }));

    expect(result.success).toBe(true);
    expect(result.data.autoLoaded).toBe(false);
    expect(result.data.nudge).toContain('workspace not found');
    expect(result.data.nudge).toContain('memory load-workspace "a"');
  });

  it('reports a thrown auto-load as a successful search with a retry nudge', async () => {
    const { tool } = createTool({
      workspaces: [makeWorkspace('a', 'Research')],
      executeTool: jest.fn().mockRejectedValue(new Error('loadWorkspace exploded'))
    });

    const result = await tool.execute(params({ load: true }));

    expect(result.success).toBe(true);
    expect(result.data.autoLoaded).toBe(false);
    expect(result.data.nudge).toContain('loadWorkspace exploded');
  });

  it('declares query as the only required parameter', () => {
    const { tool } = createTool();

    const schema = tool.getParameterSchema() as Record<string, unknown>;
    const required = schema.required as string[];

    expect(required).toContain('query');
    expect(required).not.toContain('load');
  });
});
