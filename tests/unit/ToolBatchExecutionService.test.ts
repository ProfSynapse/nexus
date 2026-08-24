import { ToolBatchExecutionService } from '../../src/agents/toolManager/services/ToolBatchExecutionService';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import type { ToolExecutionPolicy } from '../../src/agents/policy/ToolExecutionPolicy';

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

function createPolicyTool(
  slug: string,
  executionPolicy: ToolExecutionPolicy,
  execute: jest.Mock = jest.fn().mockResolvedValue({ success: true })
): ITool {
  return {
    slug,
    name: slug,
    description: '',
    version: '1.0.0',
    execute,
    getParameterSchema: jest.fn(),
    getResultSchema: jest.fn(),
    getExecutionPolicy: () => executionPolicy,
  };
}

function createMultiToolAgent(name: string, tools: ITool[]): IAgent {
  return {
    name,
    description: '',
    version: '1.0.0',
    getTools: () => tools,
    getTool: (slug: string) => tools.find(tool => tool.slug === slug),
    initialize: jest.fn().mockResolvedValue(undefined),
    executeTool: jest.fn(),
    setAgentManager: jest.fn(),
  };
}

const context = {
  workspaceId: 'default',
  sessionId: 'policy tests',
  memory: 'Testing policy enforcement',
  goal: 'Run a safe batch',
};

describe('ToolBatchExecutionService', () => {
  it('runs a parallel batch only when every tool is explicitly parallel-safe', async () => {
    let active = 0;
    let maxActive = 0;
    const execute = jest.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { success: true };
    });
    const safeRead: ToolExecutionPolicy = {
      effect: 'read', parallelSafe: true, replay: 'safe', undo: 'none'
    };
    const tools = [
      createPolicyTool('readOne', safeRead, execute),
      createPolicyTool('readTwo', safeRead, execute),
    ];
    const registry = new Map<string, IAgent>([
      ['contentManager', createMultiToolAgent('contentManager', tools)],
    ]);
    const service = new ToolBatchExecutionService({} as never, registry);

    const result = await service.execute({
      context,
      strategy: 'parallel',
      calls: tools.map(tool => ({ agent: 'contentManager', tool: tool.slug, params: {} })),
    });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(2);
  });

  it('rejects a mixed parallel batch before observers or tools run', async () => {
    const readExecute = jest.fn().mockResolvedValue({ success: true });
    const writeExecute = jest.fn().mockResolvedValue({ success: true });
    const tools = [
      createPolicyTool('read', {
        effect: 'read', parallelSafe: true, replay: 'safe', undo: 'none'
      }, readExecute),
      createPolicyTool('write', {
        effect: 'vault-write', parallelSafe: false, replay: 'deduplicate', undo: 'vault-preimage'
      }, writeExecute),
    ];
    const registry = new Map<string, IAgent>([
      ['contentManager', createMultiToolAgent('contentManager', tools)],
    ]);
    const service = new ToolBatchExecutionService({} as never, registry);
    const onBatchStarted = jest.fn();

    const result = await service.execute({
      context,
      strategy: 'parallel',
      calls: [
        { agent: 'contentManager', tool: 'read', params: {} },
        { agent: 'contentManager', tool: 'write', params: {} },
      ],
    }, { observer: { onBatchStarted } });

    expect(result).toEqual({
      success: false,
      error: 'Parallel execution rejected because these commands are not parallel-safe: "content write". Retry the batch with strategy "serial".',
    });
    expect(onBatchStarted).not.toHaveBeenCalled();
    expect(readExecute).not.toHaveBeenCalled();
    expect(writeExecute).not.toHaveBeenCalled();
  });

  it('keeps serial execution available for tools that are not parallel-safe', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true });
    const tool = createPolicyTool('write', {
      effect: 'vault-write', parallelSafe: false, replay: 'deduplicate', undo: 'vault-preimage'
    }, execute);
    const registry = new Map<string, IAgent>([
      ['contentManager', createMultiToolAgent('contentManager', [tool])],
    ]);
    const service = new ToolBatchExecutionService({} as never, registry);

    const result = await service.execute({
      context,
      strategy: 'serial',
      calls: [{ agent: 'contentManager', tool: 'write', params: {} }],
    });

    expect(result.success).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not persist read-only results but still receipts writes', async () => {
    const read = createPolicyTool('read', {
      effect: 'read', parallelSafe: true, replay: 'safe', undo: 'none'
    }, jest.fn().mockResolvedValue({ success: true, content: 'private note body' }));
    const write = createPolicyTool('write', {
      effect: 'vault-write', parallelSafe: false, replay: 'deduplicate', undo: 'vault-preimage'
    });
    const operationService = {
      execute: jest.fn(async (_input, dispatch: () => Promise<unknown>) => dispatch()),
    };
    const registry = new Map<string, IAgent>([
      ['contentManager', createMultiToolAgent('contentManager', [read, write])],
    ]);
    const service = new ToolBatchExecutionService(
      {} as never,
      registry,
      [],
      operationService as never
    );

    await service.execute({ context, calls: [{ agent: 'contentManager', tool: 'read', params: {} }] });
    expect(operationService.execute).not.toHaveBeenCalled();

    await service.execute({ context, calls: [{ agent: 'contentManager', tool: 'write', params: {} }] });
    expect(operationService.execute).toHaveBeenCalledTimes(1);
  });

  it('does not inject the ambient chat sessionId into unscoped searchMemory calls', async () => {
    const execute = jest.fn().mockResolvedValue({ success: true, results: [] });
    const tool = {
      slug: 'memory',
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
          tool: 'memory',
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
      slug: 'memory',
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
          tool: 'memory',
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
