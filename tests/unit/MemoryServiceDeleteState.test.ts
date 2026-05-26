import { MemoryService } from '../../src/agents/memoryManager/services/MemoryService';
import type { Plugin } from 'obsidian';
import type { WorkspaceService } from '../../src/services/WorkspaceService';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';

/**
 * Defensive guard: MemoryService.deleteState must route through
 * IStorageAdapter.deleteState on the hybrid backend.
 *
 * Pre-fix (PR #216 M1), this method did a workspace round-trip
 * (getWorkspace + mutate workspace.sessions[sid].states[stateId] +
 * updateWorkspace), which silently no-ops on the hybrid backend because
 * states are first-class rows in the states table, not nested under
 * workspace.sessions. This test exists to catch any hand-edit that
 * reintroduces that pattern.
 */
describe('MemoryService.deleteState (hybrid-backend routing)', () => {
  it('routes through adapter.deleteState(stateId) when the storage adapter is ready', async () => {
    const deleteStateMock = jest.fn().mockResolvedValue(undefined);
    const adapter = {
      isReady: () => true,
      deleteState: deleteStateMock
    } as unknown as IStorageAdapter;

    // workspaceService should NEVER be called on the hybrid path — if it is,
    // we've reintroduced the broken workspace round-trip.
    const getWorkspace = jest.fn();
    const updateWorkspace = jest.fn();
    const workspaceService = { getWorkspace, updateWorkspace } as unknown as WorkspaceService;

    const plugin = {} as unknown as Plugin;
    const service = new MemoryService(plugin, workspaceService, adapter);

    await service.deleteState('workspace-1', 'session-1', 'state-1');

    expect(deleteStateMock).toHaveBeenCalledTimes(1);
    expect(deleteStateMock).toHaveBeenCalledWith('state-1');
    expect(getWorkspace).not.toHaveBeenCalled();
    expect(updateWorkspace).not.toHaveBeenCalled();
  });
});
