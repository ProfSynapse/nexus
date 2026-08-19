import type { IAgent } from '../../src/agents/interfaces/IAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { buildToolManagerMcpCatalog } from '../../src/agents/toolManager/services/ToolManagerMcpCatalog';

describe('buildToolManagerMcpCatalog', () => {
  it('serializes the exact externally exposed MCP names and schemas', () => {
    const tool = {
      slug: 'getTools',
      description: 'Discover tools',
      getParameterSchema: () => ({
        type: 'object',
        properties: { tool: { type: 'string' } },
        required: ['tool'],
      }),
    } as ITool;
    const agent = { getTools: () => [tool] } as IAgent;

    expect(buildToolManagerMcpCatalog(agent)).toEqual([
      {
        name: 'toolManager_getTools',
        description: 'Discover tools',
        inputSchema: {
          type: 'object',
          properties: { tool: { type: 'string' } },
          required: ['tool'],
        },
      },
    ]);
  });
});
