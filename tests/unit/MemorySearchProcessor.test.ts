import { MemorySearchProcessor } from '../../src/agents/searchManager/services/MemorySearchProcessor';

describe('MemorySearchProcessor', () => {
  it('expands useTools traces so nested file activity is searchable', async () => {
    const storageAdapter = {
      searchTraces: jest.fn().mockResolvedValue([
        {
          id: 'trace-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          timestamp: 100,
          type: 'tool_call',
          content: 'Used tools',
          metadata: {
            tool: { agent: 'toolManager', mode: 'useTools' },
            legacy: {
              result: {
                success: true,
                data: {
                  results: [
                    {
                      agent: 'contentManager',
                      tool: 'write',
                      success: true,
                      params: { path: 'e2e-adoption-activity/probe.md' }
                    },
                    {
                      agent: 'contentManager',
                      tool: 'replace',
                      success: true,
                      params: { path: 'e2e-adoption-activity/replaced.md' }
                    }
                  ]
                }
              }
            }
          }
        }
      ]),
      getTraces: jest.fn().mockResolvedValue({ items: [] })
    };
    const processor = new MemorySearchProcessor(
      {} as never,
      undefined,
      undefined,
      storageAdapter as never
    );

    const results = await processor.executeSearch('replaced.md', {
      workspaceId: 'workspace-1',
      memoryTypes: ['traces']
    });

    expect(results).toHaveLength(1);
    expect(results[0].trace).toEqual(
      expect.objectContaining({
        content: 'Updated e2e-adoption-activity/replaced.md'
      })
    );
  });

  it('searches activity text derived from useTools CLI commands when result params are omitted', async () => {
    const storageAdapter = {
      searchTraces: jest.fn().mockResolvedValue([]),
      getTraces: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'trace-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            timestamp: 100,
            type: 'tool_call',
            content: 'Used tool',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              input: {
                arguments: {
                  tool: 'content write "e2e-focused-trace/probe.md" "sentinel text"'
                }
              },
              legacy: {
                result: {
                  agent: 'contentManager',
                  tool: 'write',
                  success: true
                }
              }
            }
          }
        ]
      })
    };
    const processor = new MemorySearchProcessor(
      {} as never,
      undefined,
      undefined,
      storageAdapter as never
    );

    const results = await processor.executeSearch('Wrote', {
      workspaceId: 'workspace-1',
      memoryTypes: ['traces']
    });

    expect(results).toHaveLength(1);
    expect(results[0].trace).toEqual(
      expect.objectContaining({
        content: 'Wrote e2e-focused-trace/probe.md'
      })
    );
  });

  it('resolves the storage adapter lazily at search time', async () => {
    let storageAdapter: {
      searchTraces: jest.Mock;
      getTraces: jest.Mock;
    } | undefined;
    const getStorageAdapter = jest.fn(() => storageAdapter);
    const processor = new MemorySearchProcessor(
      {} as never,
      undefined,
      undefined,
      getStorageAdapter as never
    );

    storageAdapter = {
      searchTraces: jest.fn().mockResolvedValue([
        {
          id: 'trace-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          timestamp: 100,
          type: 'tool_call',
          content: 'Used tool',
          metadata: {
            tool: { agent: 'toolManager', mode: 'useTools' },
            input: {
              arguments: {
                tool: 'content write "claude-desktop-trace-run-4/probe.md" "sentinel text"'
              }
            },
            legacy: {
              result: {
                agent: 'contentManager',
                tool: 'write',
                success: true
              }
            }
          }
        }
      ]),
      getTraces: jest.fn().mockResolvedValue({ items: [] })
    };

    const results = await processor.executeSearch('probe.md', {
      workspaceId: 'workspace-1',
      memoryTypes: ['traces']
    });

    expect(getStorageAdapter).toHaveBeenCalled();
    expect(storageAdapter.searchTraces).toHaveBeenCalledWith('workspace-1', 'probe.md', undefined);
    expect(results).toHaveLength(1);
    expect(results[0].trace).toEqual(
      expect.objectContaining({
        content: 'Wrote claude-desktop-trace-run-4/probe.md'
      })
    );
  });

  it('uses MemoryService traces when no storage adapter is wired into search', async () => {
    const memoryService = {
      getMemoryTraces: jest.fn().mockResolvedValue({
        items: [
          {
            id: 'trace-1',
            workspaceId: 'workspace-1',
            sessionId: 'session-1',
            timestamp: 100,
            type: 'tool_call',
            content: 'Used tool',
            metadata: {
              tool: { agent: 'toolManager', mode: 'useTools' },
              input: {
                arguments: {
                  tool: 'content replace "claude-desktop-trace-run-3/replaced.md" "old value" "new value" 1 1'
                }
              },
              legacy: {
                result: {
                  agent: 'contentManager',
                  tool: 'replace',
                  success: true
                }
              }
            }
          }
        ]
      })
    };
    const processor = new MemorySearchProcessor(
      {} as never,
      undefined,
      undefined,
      undefined,
      memoryService as never
    );

    const results = await processor.executeSearch('Updated', {
      workspaceId: 'workspace-1',
      memoryTypes: ['traces']
    });

    expect(memoryService.getMemoryTraces).toHaveBeenCalledWith('workspace-1', undefined, { pageSize: 20 });
    expect(results).toHaveLength(1);
    expect(results[0].trace).toEqual(
      expect.objectContaining({
        content: 'Updated claude-desktop-trace-run-3/replaced.md'
      })
    );
  });
});
