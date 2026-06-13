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

  it('records canonical metadata without duplicating bulky legacy params and result blocks', async () => {
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
    const largeParams = 'x'.repeat(20_000);
    const largeResult = 'y'.repeat(40_000);

    await service.captureToolCall(
      'contentManager_read',
      {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        filePath: 'Projects/A.md',
        prompt: largeParams,
        context: {
          memory: 'Trace payload regression test.',
          goal: 'Avoid duplicate legacy storage.'
        }
      },
      {
        success: true,
        content: largeResult,
        filePath: 'Projects/A.md'
      },
      true,
      12
    );

    const trace = memoryService.recordActivityTrace.mock.calls[0][0];
    expect(trace.metadata).toEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          arguments: expect.objectContaining({
            prompt: largeParams,
            filePath: 'Projects/A.md'
          }),
          files: ['Projects/A.md']
        }),
        outcome: { success: true }
      })
    );
    expect(trace.metadata.legacy).toBeUndefined();
    expect(JSON.stringify(trace.metadata)).not.toContain(largeResult);
  });

  it('records compact canonical useTools batch results for search expansion', async () => {
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
    const bulkyResult = 'z'.repeat(40_000);

    await service.captureToolCall(
      'toolManager_useTools',
      {
        workspaceId: 'Workspace Name',
        sessionId: 'session-1',
        tool: 'content write "batch/probe.md" "hello", content read "batch/probe.md"'
      },
      {
        success: true,
        data: {
          results: [
            {
              agent: 'contentManager',
              tool: 'write',
              success: true,
              params: { path: 'batch/probe.md', body: bulkyResult },
              content: bulkyResult
            },
            {
              agent: 'contentManager',
              tool: 'read',
              success: true,
              content: bulkyResult
            }
          ]
        }
      },
      true,
      12
    );

    const trace = memoryService.recordActivityTrace.mock.calls[0][0];
    expect(trace.metadata.batch).toEqual({
      results: [
        {
          agent: 'contentManager',
          tool: 'write',
          success: true,
          params: { path: 'batch/probe.md' }
        },
        {
          agent: 'contentManager',
          tool: 'read',
          success: true
        }
      ]
    });
    expect(trace.metadata.legacy).toBeUndefined();
    expect(JSON.stringify(trace.metadata)).not.toContain(bulkyResult);
  });

  describe('retrieval-feedback capture (Phase 0)', () => {
    function makeService() {
      const memoryService = {
        recordActivityTrace: jest.fn().mockResolvedValue('trace-1')
      };
      const sessionContextManager = {
        getWorkspaceContext: jest.fn().mockReturnValue(null),
        setWorkspaceContext: jest.fn()
      };
      const workspaceService = {
        getWorkspaceByNameOrId: jest.fn().mockResolvedValue({ id: 'workspace-uuid', name: 'Workspace Name' })
      };
      const service = new ToolCallTraceService(
        memoryService as never,
        sessionContextManager as never,
        workspaceService as never,
        {} as never
      );
      return { service, memoryService };
    }

    const recorded = (memoryService: { recordActivityTrace: jest.Mock }) =>
      memoryService.recordActivityTrace.mock.calls[0][0];

    it('captures returned note candidates for a direct semantic searchContent call', async () => {
      const { service, memoryService } = makeService();

      await service.captureToolCall(
        'searchManager_content',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', query: 'graph theory', semantic: true },
        { success: true, results: [{ filePath: 'Notes/A.md' }, { filePath: 'Notes/B.md' }] },
        true,
        12
      );

      const retrieval = recorded(memoryService).metadata.outcome.retrieval;
      expect(retrieval.candidates).toEqual([{ path: 'Notes/A.md' }, { path: 'Notes/B.md' }]);
      expect(typeof retrieval.groupId).toBe('string');
      expect(retrieval.groupId.length).toBeGreaterThan(0);
    });

    it('captures memory-surface candidates by id and preserves an exposed score', async () => {
      const { service, memoryService } = makeService();

      await service.captureToolCall(
        'searchManager_memory',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', query: 'last sprint' },
        { success: true, results: [{ id: 'trace-9', similarity: 0.82 }, { id: 'state-3' }] },
        true,
        12
      );

      const retrieval = recorded(memoryService).metadata.outcome.retrieval;
      expect(retrieval.candidates).toEqual([{ path: 'trace-9', score: 0.82 }, { path: 'state-3' }]);
    });

    it('captures candidates per search sub-result inside a useTools batch', async () => {
      const { service, memoryService } = makeService();

      await service.captureToolCall(
        'toolManager_useTools',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', tool: 'search content "graph theory"' },
        {
          success: true,
          data: {
            results: [
              {
                agent: 'searchManager',
                tool: 'content',
                success: true,
                results: [{ filePath: 'Notes/A.md' }, { filePath: 'Notes/B.md' }]
              }
            ]
          }
        },
        true,
        12
      );

      const [batchResult] = recorded(memoryService).metadata.batch.results;
      expect(batchResult.candidates).toEqual([{ path: 'Notes/A.md' }, { path: 'Notes/B.md' }]);
      expect(typeof batchResult.groupId).toBe('string');
    });

    it('caps the candidate list to bound trace size', async () => {
      const { service, memoryService } = makeService();
      const results = Array.from({ length: 40 }, (_, i) => ({ filePath: `Notes/${i}.md` }));

      await service.captureToolCall(
        'searchManager_content',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', query: 'x', semantic: true },
        { success: true, results },
        true,
        12
      );

      expect(recorded(memoryService).metadata.outcome.retrieval.candidates).toHaveLength(25);
    });

    it('does NOT attach retrieval for a failed search', async () => {
      const { service, memoryService } = makeService();

      await service.captureToolCall(
        'searchManager_content',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', query: 'x', semantic: true },
        { success: false, error: 'boom' },
        false,
        12
      );

      expect(recorded(memoryService).metadata.outcome.retrieval).toBeUndefined();
    });

    it('does NOT attach retrieval for a non-retrieval tool (read)', async () => {
      const { service, memoryService } = makeService();

      await service.captureToolCall(
        'contentManager_read',
        { workspaceId: 'Workspace Name', sessionId: 'session-1', filePath: 'Notes/A.md' },
        { success: true, content: 'hello', filePath: 'Notes/A.md', results: [{ filePath: 'Notes/A.md' }] },
        true,
        12
      );

      expect(recorded(memoryService).metadata.outcome.retrieval).toBeUndefined();
    });
  });
});
