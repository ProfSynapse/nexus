import { SearchManagerAgent } from '../../src/agents/searchManager/searchManager';

describe('SearchManagerAgent', () => {
  it('wires the storage adapter lazily even when memory and workspace services are injected', async () => {
    const storageAdapter = {
      searchTraces: jest.fn().mockResolvedValue([
        {
          id: 'trace-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          timestamp: 100,
          type: 'tool_call',
          content: 'Wrote claude-desktop-trace-run-4/probe.md',
          metadata: { tool: { agent: 'contentManager', mode: 'write' } }
        }
      ]),
      getTraces: jest.fn().mockResolvedValue({ items: [] })
    };
    const getServiceIfReady = jest.fn((name: string) => (
      name === 'hybridStorageAdapter' ? storageAdapter : undefined
    ));
    const plugin = {
      app: undefined,
      getServiceContainer: () => ({ getServiceIfReady }),
      settings: { settings: { memory: {} } }
    };
    const app = {
      plugins: {
        getPlugin: jest.fn((id: string) => id === 'nexus' ? plugin : null)
      }
    };
    plugin.app = app;

    const agent = new SearchManagerAgent(
      app as never,
      false,
      {} as never,
      {} as never
    );

    const result = await agent.executeTool('searchMemory', {
      query: 'probe.md',
      workspaceId: 'workspace-1',
      memoryTypes: ['traces'],
      context: { workspaceId: 'workspace-1', sessionId: '', memory: '', goal: '' }
    });

    expect(result.success).toBe(true);
    expect(getServiceIfReady).toHaveBeenCalledWith('hybridStorageAdapter');
    expect(storageAdapter.searchTraces).toHaveBeenCalledWith('workspace-1', 'probe.md', undefined);
  });
});
