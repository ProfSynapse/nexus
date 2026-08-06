/**
 * getTools must put the REAL workspace names in front of the caller.
 *
 * Background: the boot-time schema snapshot is routinely empty (the storage
 * adapter is created seconds after agents register), and nothing ever
 * refreshed it. An agent choosing a workspace therefore saw either nothing or
 * a description asserting "default" was the only workspace — so it inferred a
 * name from the user's phrasing, and loadWorkspace failed on a workspace that
 * never existed. These tests pin the grounding behavior that replaced that.
 */

import { GetToolsTool } from '../../src/agents/toolManager/tools/getTools';
import type { SchemaData, WorkspaceNameProvider } from '../../src/agents/toolManager/toolManager';
import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';

function makeTool(slug: string): ITool<Record<string, unknown>, { success: boolean }> {
  return {
    slug,
    name: slug,
    description: `${slug} tool`,
    version: '1.0.0',
    async execute() {
      return { success: true };
    },
    getParameterSchema() {
      return { type: 'object', properties: {} };
    },
    getResultSchema() {
      return { type: 'object', properties: {} };
    }
  };
}

function makeRegistry(): Map<string, IAgent> {
  const tools = [makeTool('list')];
  const agent = {
    name: 'storageManager',
    description: 'Storage',
    version: '1.0.0',
    getTools: () => tools,
    getTool: (slug: string) => tools.find(tool => tool.slug === slug),
    executeTool: async () => ({ success: true })
  } as unknown as IAgent;

  return new Map<string, IAgent>([['storageManager', agent]]);
}

const EMPTY_SNAPSHOT: SchemaData = {
  workspaces: [],
  customAgents: [],
  vaultRoot: []
};

const DISCOVERY = { tool: 'storage' } as never;

describe('GetToolsTool live workspace grounding', () => {
  it('returns live workspace names even when the boot snapshot was empty', async () => {
    const provider: WorkspaceNameProvider = async () => [
      { name: 'The Silicon Zone' },
      { name: 'Blog Testing Workspace' }
    ];

    const tool = new GetToolsTool(makeRegistry(), EMPTY_SNAPSHOT, provider);
    const result = await tool.execute(DISCOVERY);

    expect(result.success).toBe(true);
    expect(result.data?.workspaces).toEqual([
      'default',
      'The Silicon Zone',
      'Blog Testing Workspace'
    ]);
    expect(result.data?.workspacesNote).toContain('do not infer a workspace name');
  });

  it('heals the stale description so later tools/list reads are correct', async () => {
    const provider: WorkspaceNameProvider = async () => [{ name: 'The Silicon Zone' }];
    const tool = new GetToolsTool(makeRegistry(), EMPTY_SNAPSHOT, provider);

    // Before any live lookup the description must NOT claim default is the
    // only workspace — that false certainty is what produced invented names.
    expect(tool.description).not.toContain('never invent one): [default]');
    expect(tool.description).toContain('The getTools RESULT carries the live list');

    await tool.execute(DISCOVERY);

    expect(tool.description).toContain('[default,The Silicon Zone]');
  });

  it('caches within the TTL so repeated discovery does not re-query storage', async () => {
    let calls = 0;
    const provider: WorkspaceNameProvider = async () => {
      calls += 1;
      return [{ name: 'The Silicon Zone' }];
    };

    const tool = new GetToolsTool(makeRegistry(), EMPTY_SNAPSHOT, provider);
    await tool.execute(DISCOVERY);
    await tool.execute(DISCOVERY);

    expect(calls).toBe(1);
  });

  it('falls back to the boot snapshot when the live lookup throws', async () => {
    const provider: WorkspaceNameProvider = async () => {
      throw new Error('storage wedged');
    };
    const snapshot: SchemaData = {
      ...EMPTY_SNAPSHOT,
      workspaces: [{ name: 'Snapshot Workspace' }]
    };

    const tool = new GetToolsTool(makeRegistry(), snapshot, provider);
    const result = await tool.execute(DISCOVERY);

    expect(result.success).toBe(true);
    expect(result.data?.workspaces).toEqual(['default', 'Snapshot Workspace']);
  });

  it('still succeeds with only "default" when no workspaces exist', async () => {
    const provider: WorkspaceNameProvider = async () => [];
    const tool = new GetToolsTool(makeRegistry(), EMPTY_SNAPSHOT, provider);

    const result = await tool.execute(DISCOVERY);

    expect(result.success).toBe(true);
    expect(result.data?.workspaces).toEqual(['default']);
  });
});

/**
 * A tool may return `data` alongside sibling top-level fields. The batch
 * formatter used to keep only `data`, which silently discarded
 * loadWorkspace's `resolution` note — so an auto-resolved near-miss reached
 * the caller looking like an ordinary successful load, with no indication
 * that a different workspace had been opened.
 */
describe('ToolBatchExecutionService result payload', () => {
  const { ToolBatchExecutionService } = jest.requireActual(
    '../../src/agents/toolManager/services/ToolBatchExecutionService'
  );

  function serviceWith(toolResult: Record<string, unknown>) {
    const tool = {
      slug: 'loadWorkspace',
      name: 'Load Workspace',
      description: 'Load a workspace',
      version: '1.0.0',
      execute: async () => toolResult,
      getParameterSchema: () => ({ type: 'object', properties: {} }),
      getResultSchema: () => ({ type: 'object', properties: {} })
    };
    const agent = {
      name: 'memoryManager',
      description: 'Memory',
      version: '1.0.0',
      getTools: () => [tool],
      getTool: () => tool,
      executeTool: async () => toolResult
    };
    return new ToolBatchExecutionService(
      {} as never,
      new Map([['memoryManager', agent]]),
      []
    );
  }

  const context = {
    workspaceId: 'default',
    sessionId: 'test',
    memory: 'testing payload retention',
    goal: 'verify sibling fields survive'
  };

  it('keeps sibling top-level fields alongside data', async () => {
    const service = serviceWith({
      success: true,
      data: { context: { name: 'Blog Testing Workspace' } },
      resolution: { requested: 'Blog Testing', autoResolved: true }
    });

    const result = await service.execute({
      context,
      calls: [{ agent: 'memoryManager', tool: 'loadWorkspace', params: {} }]
    } as never);

    const payload = JSON.stringify(result);
    expect(payload).toContain('autoResolved');
    expect(payload).toContain('Blog Testing Workspace');
  });

  it('does not let a sibling field overwrite a key inside data', async () => {
    const service = serviceWith({
      success: true,
      data: { note: 'from data' },
      note: 'from sibling'
    });

    const result = await service.execute({
      context,
      calls: [{ agent: 'memoryManager', tool: 'loadWorkspace', params: {} }]
    } as never);

    expect(JSON.stringify(result)).toContain('from data');
  });
});
