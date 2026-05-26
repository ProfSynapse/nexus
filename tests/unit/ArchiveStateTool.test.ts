import { ArchiveStateTool } from '../../src/agents/memoryManager/tools/states/archiveState';
import type { MemoryManagerAgent } from '../../src/agents/memoryManager/memoryManager';
import type { WorkspaceState } from '../../src/database/types/session/SessionTypes';

interface StateListItem {
  id: string;
  name: string;
  sessionId?: string;
  state?: WorkspaceState;
}

function buildWorkspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    id: 'state-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    name: 'Checkpoint',
    description: 'A snapshot',
    created: 100,
    state: {
      workspace: null,
      recentTraces: [],
      contextFiles: [],
      metadata: {}
    },
    ...overrides
  } as WorkspaceState;
}

function buildAgentMocks(opts: {
  listItems: StateListItem[];
  getStateResult: WorkspaceState | null;
  updateState?: jest.Mock;
}): {
  agent: MemoryManagerAgent;
  memoryService: {
    getStates: jest.Mock;
    getState: jest.Mock;
    updateState: jest.Mock;
  };
  workspaceService: { getWorkspaceByNameOrId: jest.Mock };
} {
  const memoryService = {
    getStates: jest.fn().mockResolvedValue({
      items: opts.listItems,
      page: 0,
      pageSize: opts.listItems.length || 10,
      totalItems: opts.listItems.length,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false
    }),
    getState: jest.fn().mockResolvedValue(opts.getStateResult),
    updateState: opts.updateState ?? jest.fn().mockResolvedValue(undefined)
  };
  const workspaceService = {
    getWorkspaceByNameOrId: jest.fn().mockResolvedValue({ id: 'workspace-1', name: 'Workspace Name' })
  };
  const agent = {
    getMemoryServiceAsync: jest.fn().mockResolvedValue(memoryService),
    getWorkspaceServiceAsync: jest.fn().mockResolvedValue(workspaceService)
  } as unknown as MemoryManagerAgent;
  return { agent, memoryService, workspaceService };
}

function archiveContext() {
  return {
    workspaceId: 'Workspace Name',
    sessionId: 'session-1',
    memory: 'Testing archive.',
    goal: 'Verify archive round-trip.'
  };
}

describe('ArchiveStateTool', () => {
  it('archives an un-archived state by toggling metadata.isArchived to true', async () => {
    const listItems: StateListItem[] = [{ id: 'state-1', name: 'Checkpoint', sessionId: 'session-1' }];
    const existing = buildWorkspaceState();
    const { agent, memoryService } = buildAgentMocks({ listItems, getStateResult: existing });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Checkpoint' });

    expect(result.success).toBe(true);
    expect(memoryService.updateState).toHaveBeenCalledTimes(1);
    const updateCall = memoryService.updateState.mock.calls[0];
    expect(updateCall[0]).toBe('workspace-1');
    expect(updateCall[1]).toBe('session-1');
    expect(updateCall[2]).toBe('state-1');
    const passedNextState = updateCall[3].state as WorkspaceState;
    expect(passedNextState.state?.metadata?.isArchived).toBe(true);
  });

  it('preserves tags and snapshot fields when archiving a TAGGED state (B1 regression guard)', async () => {
    // This is the B1 skeleton-corruption guard: archiveState must read the REAL
    // snapshot via getState and preserve every existing field. Before the fix,
    // a skeleton WorkspaceState was constructed and tags/conversationContext/
    // activeTask/activeFiles/nextSteps were clobbered.
    const listItems: StateListItem[] = [{ id: 'state-1', name: 'Tagged Checkpoint', sessionId: 'session-1' }];
    const existing = buildWorkspaceState({
      name: 'Tagged Checkpoint',
      tags: ['important', 'milestone'],
      state: {
        workspace: { id: 'workspace-1' } as unknown as WorkspaceState['state']['workspace'],
        recentTraces: [{ id: 'trace-1' }] as unknown as WorkspaceState['state']['recentTraces'],
        contextFiles: ['notes/Plan.md'] as unknown as WorkspaceState['state']['contextFiles'],
        metadata: {
          tags: ['important', 'milestone'],
          conversationContext: 'Discussing Q3 roadmap',
          activeTask: 'Finalize plan',
          activeFiles: ['notes/Plan.md'],
          nextSteps: ['Ship by Friday']
        } as unknown as WorkspaceState['state']['metadata']
      }
    });
    const { agent, memoryService } = buildAgentMocks({ listItems, getStateResult: existing });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Tagged Checkpoint' });

    expect(result.success).toBe(true);
    const passedNextState = memoryService.updateState.mock.calls[0][3].state as WorkspaceState;
    // isArchived flipped
    expect(passedNextState.state?.metadata?.isArchived).toBe(true);
    // Top-level tags survive
    expect(passedNextState.tags).toEqual(['important', 'milestone']);
    // Nested metadata survives (this is what skeleton-corruption clobbered)
    const md = passedNextState.state?.metadata as Record<string, unknown>;
    expect(md.tags).toEqual(['important', 'milestone']);
    expect(md.conversationContext).toBe('Discussing Q3 roadmap');
    expect(md.activeTask).toBe('Finalize plan');
    expect(md.activeFiles).toEqual(['notes/Plan.md']);
    expect(md.nextSteps).toEqual(['Ship by Friday']);
    // Snapshot sub-fields survive
    expect(passedNextState.state?.recentTraces).toEqual([{ id: 'trace-1' }]);
    expect(passedNextState.state?.contextFiles).toEqual(['notes/Plan.md']);
  });

  it('restores an archived state by toggling metadata.isArchived to false, preserving tags', async () => {
    const listItems: StateListItem[] = [{ id: 'state-1', name: 'Tagged Checkpoint', sessionId: 'session-1' }];
    const existing = buildWorkspaceState({
      tags: ['important'],
      state: {
        workspace: null,
        recentTraces: [],
        contextFiles: [],
        metadata: {
          tags: ['important'],
          isArchived: true
        } as unknown as WorkspaceState['state']['metadata']
      }
    });
    const { agent, memoryService } = buildAgentMocks({ listItems, getStateResult: existing });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Tagged Checkpoint', restore: true });

    expect(result.success).toBe(true);
    const passedNextState = memoryService.updateState.mock.calls[0][3].state as WorkspaceState;
    expect(passedNextState.state?.metadata?.isArchived).toBe(false);
    expect(passedNextState.tags).toEqual(['important']);
    expect((passedNextState.state?.metadata as Record<string, unknown>).tags).toEqual(['important']);
  });

  it('returns a clear error when the named state is not found', async () => {
    const { agent, memoryService } = buildAgentMocks({ listItems: [], getStateResult: null });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Nonexistent' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/State "Nonexistent" not found/);
    expect(memoryService.updateState).not.toHaveBeenCalled();
  });

  it('rejects restore=true on a state that is not archived', async () => {
    const listItems: StateListItem[] = [{ id: 'state-1', name: 'Checkpoint', sessionId: 'session-1' }];
    const existing = buildWorkspaceState();
    const { agent, memoryService } = buildAgentMocks({ listItems, getStateResult: existing });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Checkpoint', restore: true });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is not archived/);
    expect(memoryService.updateState).not.toHaveBeenCalled();
  });

  it('rejects archive on a state that is already archived (idempotency guard)', async () => {
    const listItems: StateListItem[] = [{ id: 'state-1', name: 'Checkpoint', sessionId: 'session-1' }];
    const existing = buildWorkspaceState({
      state: {
        workspace: null,
        recentTraces: [],
        contextFiles: [],
        metadata: { isArchived: true } as unknown as WorkspaceState['state']['metadata']
      }
    });
    const { agent, memoryService } = buildAgentMocks({ listItems, getStateResult: existing });

    const tool = new ArchiveStateTool(agent);
    const result = await tool.execute({ context: archiveContext(), name: 'Checkpoint' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/is already archived/);
    expect(memoryService.updateState).not.toHaveBeenCalled();
  });
});
