import { MemoryService } from '../../src/agents/memoryManager/services/MemoryService';
import type { Plugin } from 'obsidian';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';

/**
 * `MemoryService.getStates` must surface `state.metadata.isArchived` for every
 * row it returns — both archive filters in the codebase (the workspace
 * settings states section and the LLM-facing `listStates`) read it from there,
 * and a row that omits it is treated as visible.
 *
 * History, because this file has been on both sides of the trade:
 *
 * - PR #216 shipped `const fullState = stateMeta.tags ? null : await
 *   adapter.getState(...)`. Tagged states skipped the content fetch, the flag
 *   never surfaced, and archived states stayed visible forever (#218).
 * - PR #218 removed the shortcut by fetching content for EVERY row. Correct,
 *   but each fetch parses the whole workspace event stream: 200 states cost
 *   200 reads and ~180k parsed events on the first list after a restart.
 * - Issue #219 (this change) denormalizes the flag into a SQLite column, so
 *   the metadata row can answer the question on its own.
 *
 * The invariant that survives all three: the flag is surfaced. What changed is
 * where it comes from. A row whose column is `undefined` means "not backfilled
 * yet", NOT "not archived", and MUST still fall back to content — that is the
 * #218 guard, kept below in the only shape where it still applies.
 */
describe('MemoryService.getStates (isArchived surfacing)', () => {
  const baseMeta = {
    id: 'state-tagged-archived',
    name: 'Tagged Archived State',
    description: 'A state with tags that has been archived',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    created: 1717000000000,
    tags: ['draft', 'review']
  };

  const archivedContent = {
    id: 'state-tagged-archived',
    name: 'Tagged Archived State',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    created: 1717000000000,
    state: {
      workspace: null,
      recentTraces: [],
      contextFiles: [],
      metadata: {
        tags: ['draft', 'review'],
        isArchived: true
      }
    }
  };

  function buildService(
    metaRows: Array<Record<string, unknown>>,
    adapterOverrides: Partial<IStorageAdapter> = {}
  ): { service: MemoryService; getState: jest.Mock; getStates: jest.Mock } {
    const getState = jest.fn().mockResolvedValue({ content: archivedContent });
    const getStates = jest.fn().mockResolvedValue({
      items: metaRows,
      total: metaRows.length,
      page: 0,
      pageSize: 50,
      hasMore: false
    });

    const adapter = {
      isReady: () => true,
      getStates,
      getState,
      ...adapterOverrides
    } as unknown as IStorageAdapter;

    const workspaceService = { getWorkspace: jest.fn() } as unknown as WorkspaceService;
    const plugin = {} as unknown as Plugin;

    return { service: new MemoryService(plugin, workspaceService, adapter), getState, getStates };
  }

  function archiveFlagOf(item: { state?: { state?: { metadata?: Record<string, unknown> } } } | undefined) {
    return item?.state?.state?.metadata?.isArchived;
  }

  it('surfaces isArchived from SQLite metadata without reading JSONL content', async () => {
    const { service, getState } = buildService([{ ...baseMeta, isArchived: true }]);

    const result = await service.getStates('workspace-1');

    expect(getState).not.toHaveBeenCalled();
    expect(archiveFlagOf(result.items.find(s => s.id === baseMeta.id))).toBe(true);
  });

  it('surfaces a non-archived state as not archived, still without a content read', async () => {
    const { service, getState } = buildService([{ ...baseMeta, isArchived: false }]);

    const result = await service.getStates('workspace-1');

    expect(getState).not.toHaveBeenCalled();
    expect(archiveFlagOf(result.items.find(s => s.id === baseMeta.id))).toBe(false);
  });

  it('does NOT reinstate the tags shortcut: a tagged row with an unknown flag still reads content', async () => {
    // This is the #218 regression in its exact original shape — tags present,
    // archive flag not answerable from metadata. Content must be consulted.
    const { service, getState } = buildService([{ ...baseMeta, isArchived: undefined }]);

    const result = await service.getStates('workspace-1');

    expect(getState).toHaveBeenCalledWith('state-tagged-archived');
    expect(archiveFlagOf(result.items.find(s => s.id === baseMeta.id))).toBe(true);
  });

  it('reads content for exactly the rows whose flag is unknown, and no others', async () => {
    const { service, getState } = buildService([
      { ...baseMeta, id: 'known-1', isArchived: true },
      { ...baseMeta, id: 'unknown-1', isArchived: undefined },
      { ...baseMeta, id: 'known-2', isArchived: false }
    ]);

    await service.getStates('workspace-1');

    expect(getState).toHaveBeenCalledTimes(1);
    expect(getState).toHaveBeenCalledWith('unknown-1');
  });

  it('lets fetched content win over the column when both are present', async () => {
    // Content is the source of truth; the column is a cache of it. If they
    // ever disagree, the stream is right.
    const { service } = buildService([{ ...baseMeta, isArchived: undefined }]);

    const result = await service.getStates('workspace-1');

    expect(archiveFlagOf(result.items[0])).toBe(true);
  });

  it('preserves the cached tags from SQLite metadata', async () => {
    const { service } = buildService([{ ...baseMeta, isArchived: true }]);

    const result = await service.getStates('workspace-1');

    expect(result.items[0].tags).toEqual(['draft', 'review']);
  });

  it('keeps the description available for list views without a content read', async () => {
    const { service, getState } = buildService([{ ...baseMeta, isArchived: false }]);

    const result = await service.getStates('workspace-1');

    expect(getState).not.toHaveBeenCalled();
    expect(result.items[0].description).toBe('A state with tags that has been archived');
    expect(result.items[0].state.context?.activeTask).toBe('A state with tags that has been archived');
  });

  it('passes the archive filter down to the adapter so SQL can apply it', async () => {
    const { service, getStates } = buildService([{ ...baseMeta, isArchived: false }]);

    await service.getStates('workspace-1', undefined, { includeArchived: true });

    expect(getStates).toHaveBeenCalledWith('workspace-1', undefined, { includeArchived: true });
  });
});
