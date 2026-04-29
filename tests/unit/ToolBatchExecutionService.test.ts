import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';

function createAgent(tool: ITool): IAgent {
  return {
    name: 'searchManager',
    description: 'Search manager',
    version: '1.0.0',
    getTools: () => [tool],
    getTool: (slug: string) => slug === tool.slug ? tool : undefined,
    initialize: jest.fn().mockResolvedValue(undefined),
    executeTool: jest.fn(),
    setAgentManager: jest.fn()
  };
}

describe('ToolBatchExecutionService', () => {
  it('does not inject the ambient chat sessionId into unscoped searchMemory calls', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true, results: [] });
    const tool = {
      slug: 'searchMemory',
      name: 'Search memory',
      description: '',
      version: '1.0.0',
      execute,
      getParameterSchema: jest.fn(),
      getResultSchema: jest.fn()
    } as unknown as ITool;
    const agentRegistry = new Map<string, IAgent>([
      ['searchManager', createAgent(tool)]
    ]);
    const service = new ToolBatchExecutionService({} as never, agentRegistry);

    await service.execute({
      context: {
        workspaceId: 'default',
        sessionId: 'focused trace session',
        memory: 'Memory summary',
        goal: 'Search workspace traces'
      },
      calls: [
        {
          agent: 'searchManager',
          tool: 'searchMemory',
          params: { query: 'replaced.md', memoryTypes: ['traces'] }
        }
      ]
    });

    expect(execute).toHaveBeenCalledWith(expect.not.objectContaining({
      sessionId: 'focused trace session'
    }));
  });

  it('preserves an explicit searchMemory session filter', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true, results: [] });
    const tool = {
      slug: 'searchMemory',
      name: 'Search memory',
      description: '',
      version: '1.0.0',
      execute,
      getParameterSchema: jest.fn(),
      getResultSchema: jest.fn()
    } as unknown as ITool;
    const agentRegistry = new Map<string, IAgent>([
      ['searchManager', createAgent(tool)]
    ]);
    const service = new ToolBatchExecutionService({} as never, agentRegistry);

    await service.execute({
      context: {
        workspaceId: 'default',
        sessionId: 'ambient chat session',
        memory: 'Memory summary',
        goal: 'Search one named session'
      },
      calls: [
        {
          agent: 'searchManager',
          tool: 'searchMemory',
          params: {
            query: 'replaced.md',
            memoryTypes: ['traces'],
            sessionName: 'focused trace session'
          }
        }
      ]
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      sessionName: 'focused trace session'
    }));
  });
});
