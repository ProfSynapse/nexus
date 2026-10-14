import { ChatTraceService } from '../../src/services/chat/ChatTraceService';

type WorkspaceServiceLike = {
  getWorkspace: jest.Mock;
  ensureWorkspace: jest.Mock;
  createWorkspace: jest.Mock;
  addSession: jest.Mock;
};

describe('ChatTraceService', () => {
  it('ensures the default workspace with the canonical id when the lookup misses it', async () => {
    const workspaceService = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      ensureWorkspace: jest.fn().mockResolvedValue({
        id: 'default',
        name: 'Default Workspace'
      }),
      createWorkspace: jest.fn(),
      addSession: jest.fn().mockResolvedValue({
        id: 'session-1'
      })
    } as WorkspaceServiceLike;

    const service = new ChatTraceService({ workspaceService });
    const context = await service.initializeSession('conv-1', 'default', 'session-1');

    // Never a bare create: the miss above may be the startup legacy fallback.
    expect(workspaceService.createWorkspace).not.toHaveBeenCalled();
    expect(workspaceService.ensureWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'default',
        name: 'Default Workspace'
      })
    );
    expect(workspaceService.addSession).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({ id: 'session-1' })
    );
    expect(context.workspaceId).toBe('default');
  });

  it('uses the legacy default workspace ensureWorkspace adopted by name', async () => {
    const workspaceService = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      ensureWorkspace: jest.fn().mockResolvedValue({
        id: 'ws_legacy_default',
        name: 'Default Workspace'
      }),
      createWorkspace: jest.fn(),
      addSession: jest.fn().mockResolvedValue({
        id: 'session-1'
      })
    } as WorkspaceServiceLike;

    const service = new ChatTraceService({ workspaceService });
    const context = await service.initializeSession('conv-1', 'default', 'session-1');

    expect(workspaceService.createWorkspace).not.toHaveBeenCalled();
    expect(workspaceService.addSession).toHaveBeenCalledWith(
      'ws_legacy_default',
      expect.objectContaining({ id: 'session-1' })
    );
    expect(context.workspaceId).toBe('ws_legacy_default');
  });
});
