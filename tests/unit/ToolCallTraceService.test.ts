import { ToolCallTraceService } from '../../src/services/trace/ToolCallTraceService';

describe('ToolCallTraceService', () => {
  it('resolves top-level workspace names before recording useTools traces', async () => {
    const memoryService = {
      recordActivityTrace: jest.fn().mockResolvedValue('trace-1')
    };
    const sessionContextManager = {
      getWorkspaceContext: jest.fn().mockReturnValue(null),
      setWorkspaceContext: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Workspace Name'
      })
    };
    const service = new ToolCallTraceService(
      memoryService as never,
      sessionContextManager as never,
      workspaceService as never,
      {} as never
    );

    await service.captureToolCall(
      'toolManager_useTools',
      {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        _displaySessionId: 'Focused trace session',
        memory: 'Testing recent activity.',
        goal: 'Record a file read.',
        tool: 'content read "Projects/A.md"'
      },
      { success: true },
      true,
      12
    );

    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Workspace Name');
    expect(memoryService.recordActivityTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-uuid',
        sessionId: 'session-1',
        type: 'tool_call',
        metadata: expect.objectContaining({
          context: expect.objectContaining({
            workspaceId: 'workspace-uuid',
            sessionId: 'session-1',
            sessionName: 'Focused trace session',
            memory: 'Testing recent activity.',
            goal: 'Record a file read.'
          })
        })
      })
    );
  });

  it('prefers an explicit workspace over stale session workspace context', async () => {
    const memoryService = {
      recordActivityTrace: jest.fn().mockResolvedValue('trace-1')
    };
    const sessionContextManager = {
      getWorkspaceContext: jest.fn().mockReturnValue({
        workspaceId: 'session-workspace'
      }),
      setWorkspaceContext: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'envelope-workspace-uuid',
        name: 'Envelope workspace'
      })
    };
    const service = new ToolCallTraceService(
      memoryService as never,
      sessionContextManager as never,
      workspaceService as never,
      {} as never
    );

    await service.captureToolCall(
      'toolManager_useTools',
      {
        workspaceId: 'Envelope workspace',
        sessionId: 'session-1',
        tool: 'content read "Projects/A.md"'
      },
      { success: true },
      true,
      12
    );

    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Envelope workspace');
    expect(memoryService.recordActivityTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'envelope-workspace-uuid',
        sessionId: 'session-1'
      })
    );
  });

  it('uses a load-workspace command handle when the envelope is still default', async () => {
    const memoryService = {
      recordActivityTrace: jest.fn().mockResolvedValue('trace-1')
    };
    const sessionContextManager = {
      getWorkspaceContext: jest.fn().mockReturnValue({ workspaceId: 'default' }),
      setWorkspaceContext: jest.fn()
    };
    const workspaceService = {
      getWorkspaceByNameOrId: jest.fn().mockResolvedValue({
        id: 'workspace-uuid',
        name: 'Human Workspace'
      })
    };
    const service = new ToolCallTraceService(
      memoryService as never,
      sessionContextManager as never,
      workspaceService as never,
      {} as never
    );

    await service.captureToolCall(
      'toolManager_useTools',
      {
        workspaceId: 'default',
        sessionId: 'session-1',
        tool: 'memory load-workspace "Human Workspace"'
      },
      { success: true },
      true,
      12
    );

    expect(workspaceService.getWorkspaceByNameOrId).toHaveBeenCalledWith('Human Workspace');
    expect(sessionContextManager.setWorkspaceContext).toHaveBeenCalledWith('session-1', {
      workspaceId: 'workspace-uuid'
    });
    expect(memoryService.recordActivityTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-uuid',
        sessionId: 'session-1'
      })
    );
  });
});
