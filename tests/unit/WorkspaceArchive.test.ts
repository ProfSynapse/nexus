import { App } from 'obsidian';
import { ArchiveWorkspaceTool } from '../../src/agents/memoryManager/tools/workspaces/archiveWorkspace';
import type { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import type { IStorageAdapter, QueryOptions } from '../../src/database/interfaces/IStorageAdapter';
import { WorkspaceService } from '../../src/services/WorkspaceService';
import type { PaginatedResult } from '../../src/types/pagination/PaginationTypes';
import type { WorkspaceMetadata as HybridWorkspaceMetadata } from '../../src/types/storage/HybridStorageTypes';
import type { IndividualWorkspace } from '../../src/types/storage/StorageTypes';

function createPaginatedResult<T>(items: T[]): PaginatedResult<T> {
  return {
    items,
    page: 0,
    pageSize: items.length || 10,
    totalItems: items.length,
    totalPages: items.length === 0 ? 0 : 1,
    hasNextPage: false,
    hasPreviousPage: false
  };
}

function createHybridWorkspace(overrides: Partial<HybridWorkspaceMetadata> = {}): HybridWorkspaceMetadata {
  return {
    id: 'ws-1',
    name: 'Workspace',
    rootFolder: '/',
    created: 1,
    lastAccessed: 1,
    isActive: true,
    ...overrides
  };
}

function createIndividualWorkspace(overrides: Partial<IndividualWorkspace> = {}): IndividualWorkspace {
  return {
    id: 'ws-1',
    name: 'Workspace',
    rootFolder: '/',
    created: 1,
    lastAccessed: 1,
    isActive: true,
    sessions: {},
    ...overrides
  };
}

function createWorkspaceServiceWithAdapter(adapter: IStorageAdapter): WorkspaceService {
  return new WorkspaceService(
    {} as never,
    {} as never,
    {} as never,
    adapter
  );
}

describe('Workspace archive state', () => {
  it('preserves isArchived on hybrid list and lookup paths', async () => {
    const archivedWorkspace = createHybridWorkspace({
      id: 'ws-archived',
      name: 'Archived Workspace',
      isArchived: true
    });

    const getWorkspace = jest.fn().mockImplementation(async (id: string) => {
      return id === archivedWorkspace.id ? archivedWorkspace : null;
    });

    const getWorkspaces = jest.fn().mockImplementation(async (options?: QueryOptions) => {
      if (options?.search === archivedWorkspace.name) {
        return createPaginatedResult([archivedWorkspace]);
      }

      return createPaginatedResult([archivedWorkspace]);
    });

    const adapter = {
      isReady: jest.fn().mockReturnValue(true),
      getWorkspace,
      getWorkspaces
    } as unknown as IStorageAdapter;

    const workspaceService = createWorkspaceServiceWithAdapter(adapter);

    const listed = await workspaceService.getWorkspaces();
    expect(listed).toHaveLength(1);
    expect(listed[0].isArchived).toBe(true);

    const loaded = await workspaceService.getWorkspaceByNameOrId('Archived Workspace');
    expect(loaded?.id).toBe('ws-archived');
    expect(loaded?.isArchived).toBe(true);
    expect(getWorkspaces).toHaveBeenCalledWith(expect.objectContaining({ search: 'Archived Workspace' }));
  });

  it('returns failure when archive state does not persist after update', async () => {
    const existingWorkspace = createIndividualWorkspace({ name: 'Workspace', isArchived: false });

    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn()
        .mockResolvedValueOnce(existingWorkspace)
        .mockResolvedValueOnce({ ...existingWorkspace, lastAccessed: 2, isArchived: false }),
      updateWorkspace: jest.fn().mockResolvedValue(undefined)
    };

    const tool = new ArchiveWorkspaceTool({
      getApp: () => new App()
    } as MemoryManagerAgent);

    (tool as unknown as {
      serviceIntegration: {
        getWorkspaceService: () => Promise<{ success: boolean; service: typeof workspaceService }>;
      };
    }).serviceIntegration = {
      getWorkspaceService: jest.fn().mockResolvedValue({
        success: true,
        service: workspaceService
      })
    };

    const result = await tool.execute({ name: 'Workspace' });

    expect(workspaceService.updateWorkspace).toHaveBeenCalledWith(
      'ws-1',
      expect.objectContaining({ isArchived: true })
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('Persisted archive state did not change');
  });

  it('returns success when archive state persists after update', async () => {
    const existingWorkspace = createIndividualWorkspace({ name: 'Workspace', isArchived: false });

    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn()
        .mockResolvedValueOnce(existingWorkspace)
        .mockResolvedValueOnce({ ...existingWorkspace, lastAccessed: 2, isArchived: true }),
      updateWorkspace: jest.fn().mockResolvedValue(undefined)
    };

    const tool = new ArchiveWorkspaceTool({
      getApp: () => new App()
    } as MemoryManagerAgent);

    (tool as unknown as {
      serviceIntegration: {
        getWorkspaceService: () => Promise<{ success: boolean; service: typeof workspaceService }>;
      };
    }).serviceIntegration = {
      getWorkspaceService: jest.fn().mockResolvedValue({
        success: true,
        service: workspaceService
      })
    };

    const result = await tool.execute({ name: 'Workspace' });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });
});
