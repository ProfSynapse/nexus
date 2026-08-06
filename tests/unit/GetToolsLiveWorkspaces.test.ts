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
