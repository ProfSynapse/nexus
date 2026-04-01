import { ChatTraceService } from '../../src/services/chat/ChatTraceService';

type WorkspaceServiceLike = {
  getWorkspace: jest.Mock;
  getWorkspaceByNameOrId: jest.Mock;
  createWorkspace: jest.Mock;
  addSession: jest.Mock;
};

type WorkspaceServiceLike = {
  getWorkspace: jest.Mock;
  getWorkspaceByNameOrId: jest.Mock;
  createWorkspace: jest.Mock;
  addSession: jest.Mock;
};

describe('ChatTraceService', () => {
  it('creates the default workspace with the canonical id when it is missing', async () => {
    const workspaceService = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue(null),
      createWorkspace: jest.fn().mockResolvedValue({
        id: 'default',
        name: 'Default Workspace'
      }),
      addSession: jest.fn().mockResolvedValue({
        id: 'session-1'
      })
    } as WorkspaceServiceLike;

    const service = new ChatTraceService({ workspaceService });
    const context = await service.initializeSession('conv-1', 'default', 'session-1');

    expect(workspaceService.createWorkspace).toHaveBeenCalledWith(
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

  it('reuses a legacy default workspace found by name instead of creating a duplicate', async () => {
    const workspaceService = {
      getWorkspace: jest.fn().mockResolvedValue(null),
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
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
