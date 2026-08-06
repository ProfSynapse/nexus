/**
 * Tests for LoadWorkspaceTool miss recovery.
 *
 * A guessed workspace name used to dead-end with "not found", which is what
 * sends CLI agents into retry loops on invented names. Every branch here has to
 * hand back something the caller can act on without guessing again.
 */

import { LoadWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/loadWorkspace';
import { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import { WorkspaceMetadata } from '../../src/types/storage/StorageTypes';

const emptyPage = {
  items: [],
  page: 0,
  pageSize: 5,
  totalItems: 0,
  totalPages: 0,
  hasNextPage: false,
  hasPreviousPage: false
};

function makeIndexRow(
  overrides: Partial<WorkspaceMetadata> & { id: string; name: string }
): WorkspaceMetadata {
  return {
    rootFolder: 'Notes',
    created: 1000,
    lastAccessed: 1000,
    sessionCount: 0,
    traceCount: 0,
    ...overrides
  };
}

function makeFullWorkspace(id: string, name: string) {
  return {
    id,
    name,
    description: `${name} description`,
    rootFolder: 'Notes',
    created: 1000,
    lastAccessed: 2000,
    isActive: true,
    context: { purpose: 'testing', keyFiles: [], preferences: '' },
    sessions: {}
  };
}

function createTool(options: {
  index?: WorkspaceMetadata[];
  full?: Record<string, ReturnType<typeof makeFullWorkspace>>;
  listWorkspaces?: jest.Mock;
  /** Whether the cache claims its list is exhaustive. Default: settled. */
  listComplete?: boolean;
}) {
  const full = options.full ?? {};

  const workspaceService = {
    isSystemWorkspaceId: jest.fn().mockReturnValue(false),
    getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null),
    getWorkspace: jest.fn().mockImplementation((id: string) => Promise.resolve(full[id] ?? null)),
    listWorkspaces: options.listWorkspaces ?? jest.fn().mockResolvedValue(options.index ?? []),
    isListComplete: jest.fn().mockReturnValue(options.listComplete ?? true),
    updateLastAccessed: jest.fn().mockResolvedValue(undefined)
  };

  const memoryService = {
    getMemoryTraces: jest.fn().mockResolvedValue(emptyPage),
    getSessions: jest.fn().mockResolvedValue(emptyPage),
    getStates: jest.fn().mockResolvedValue(emptyPage)
  };

  const tool = new LoadWorkspaceTool({
    getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService),
    getMemoryService: jest.fn().mockReturnValue(memoryService),
    getCacheManager: jest.fn().mockReturnValue(null),
    getTaskService: jest.fn().mockReturnValue(null),
    getApp: jest.fn().mockReturnValue({
      vault: { getAbstractFileByPath: jest.fn().mockReturnValue(null) }
    }),
    plugin: {},
    customPromptStorage: undefined
  } as unknown as MemoryManagerAgent);

  return { tool, workspaceService, memoryService };
}

describe('LoadWorkspaceTool miss recovery', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('auto-loads the single close match and says which workspace it actually opened', async () => {
    const { tool, workspaceService, memoryService } = createTool({
      index: [
        makeIndexRow({ id: 'ws-research', name: 'Research' }),
        makeIndexRow({ id: 'ws-budget', name: 'Budget' })
      ],
      full: { 'ws-research': makeFullWorkspace('ws-research', 'Research') }
    });

    const result = await tool.execute({ workspace: 'Research Notes', limit: 5 });

    expect(result.success).toBe(true);
    expect(result.data.context.name).toBe('Research');
    expect(result.workspaceContext?.workspaceId).toBe('ws-research');
    expect(result.resolution).toMatchObject({
      requested: 'Research Notes',
      autoResolved: true,
      resolvedTo: { id: 'ws-research', name: 'Research' }
    });
    expect(result.resolution?.note).toContain('Research');

    // The rest of the load runs against the resolved workspace, not the guess.
    expect(workspaceService.updateLastAccessed).toHaveBeenCalledWith('ws-research');
    expect(memoryService.getSessions).toHaveBeenCalledWith('ws-research', expect.anything());
  });

  it('returns ranked candidates instead of picking between two plausible workspaces', async () => {
    const { tool, workspaceService } = createTool({
      index: [
        makeIndexRow({ id: 'ws-hub', name: 'Research Hub' }),
        makeIndexRow({ id: 'ws-ai', name: 'AI Research' })
      ]
    });

    const result = await tool.execute({ workspace: 'Research', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.resolution?.autoResolved).toBe(false);
    expect(result.resolution?.candidates?.map(candidate => candidate.name))
      .toEqual(['Research Hub', 'AI Research']);
    expect(result.error).toContain('Research Hub');
    expect(result.error).toContain('memory load-workspace');
    expect(workspaceService.getWorkspace).not.toHaveBeenCalled();
  });

  it('lists the workspaces that do exist when nothing resembles the request', async () => {
    const { tool } = createTool({
      index: [
        makeIndexRow({ id: 'ws-a', name: 'Budget' }),
        makeIndexRow({ id: 'ws-b', name: 'Recipes' })
      ]
    });

    const result = await tool.execute({ workspace: 'Quarterly Planning', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.resolution?.availableWorkspaces).toEqual(['Budget', 'Recipes']);
    expect(result.error).toContain('"Budget"');
    expect(result.error).toContain('"Recipes"');
    expect(result.error).toContain('do not invent another');
  });

  it('excludes archived workspaces from the listed inventory', async () => {
    const { tool } = createTool({
      index: [
        makeIndexRow({ id: 'ws-a', name: 'Budget' }),
        makeIndexRow({ id: 'ws-old', name: 'Old Notes', isArchived: true })
      ]
    });

    const result = await tool.execute({ workspace: 'Quarterly Planning', limit: 5 });

    expect(result.resolution?.availableWorkspaces).toEqual(['Budget']);
  });

  it('points at workspace creation when the vault has no workspaces at all', async () => {
    const { tool } = createTool({ index: [] });

    const result = await tool.execute({ workspace: 'Research', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.resolution?.availableWorkspaces).toEqual([]);
    expect(result.error).toContain('memory create-workspace');
  });

  it('degrades to a plain retry instruction when the workspace list cannot be read', async () => {
    const { tool } = createTool({
      listWorkspaces: jest.fn().mockRejectedValue(new Error('cache cold'))
    });

    const result = await tool.execute({ workspace: 'Research', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.resolution?.autoResolved).toBe(false);
    expect(result.error).toContain('memory list-workspaces');
  });

  it('falls back to a candidate when the resolved index row has no loadable record', async () => {
    const { tool } = createTool({
      index: [makeIndexRow({ id: 'ws-research', name: 'Research' })],
      full: {}
    });

    const result = await tool.execute({ workspace: 'Research Notes', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.resolution?.autoResolved).toBe(false);
    expect(result.resolution?.candidates?.[0].id).toBe('ws-research');
  });

  it('leaves an exact hit untouched — no resolution report', async () => {
    const { tool, workspaceService } = createTool({});
    workspaceService.getWorkspaceByNameOrId.mockResolvedValue(
      makeFullWorkspace('ws-research', 'Research')
    );

    const result = await tool.execute({ workspace: 'Research', limit: 5 });

    expect(result.success).toBe(true);
    expect(result.resolution).toBeUndefined();
    expect(workspaceService.listWorkspaces).not.toHaveBeenCalled();
  });
});

describe('LoadWorkspaceTool miss recovery on a rebuilding cache', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not claim the workspace is missing while the list is still partial', async () => {
    // Live-reproduced: seconds after a plugin reload the SQLite cache had
    // replayed 1 of 12 workspaces, and the tool reported a real workspace as
    // nonexistent while presenting the partial set as authoritative.
    const { tool } = createTool({
      index: [makeIndexRow({ id: 'ws-a', name: 'Default Workspace' })],
      listComplete: false
    });

    const result = await tool.execute({ workspace: 'Blog Testing', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('still rebuilding');
    expect(result.error).toContain('INCOMPLETE');
    expect(result.error).not.toContain('nothing resembles it');
    // Steer back to the ORIGINAL name, not the partial list's first entry.
    expect(result.error).toContain('--workspace "Blog Testing"');
  });

  it('still asserts the inventory is exhaustive once the cache has settled', async () => {
    const { tool } = createTool({
      index: [makeIndexRow({ id: 'ws-a', name: 'Budget' })],
      listComplete: true
    });

    const result = await tool.execute({ workspace: 'Totally Invented', limit: 5 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing resembles it');
    expect(result.error).not.toContain('still rebuilding');
  });
});
