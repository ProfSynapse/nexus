import { App } from 'obsidian';
import { BaseAgent } from '../../src/agents/baseAgent';
import type { ITool } from '../../src/agents/interfaces/ITool';
import { ToolManagerAgent } from '../../src/agents/toolManager/toolManager';

class StubAgent extends BaseAgent {
  constructor() {
    super('webTools', 'Web tools test agent', '1.0.0');

    const tool: ITool<{ url: string }, { success: boolean; data?: { opened: string } }> = {
      slug: 'openWebpage',
      name: 'Open Webpage',
      description: 'Open a webpage',
      version: '1.0.0',
      async execute(params) {
        return {
          success: true,
          data: { opened: params.url }
        };
      },
      getParameterSchema() {
        return {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: 'URL to open'
            }
          },
          required: ['url']
        };
      },
      getResultSchema() {
        return {
          type: 'object',
          properties: {
            success: { type: 'boolean' }
          },
          required: ['success']
        };
      }
    };

    this.registerTool(tool);
  }
}

describe('ToolManagerAgent dynamic registry updates', () => {
  function createToolManager(): ToolManagerAgent {
    return new ToolManagerAgent(new App(), new Map(), {
      workspaces: [],
      customAgents: [],
      vaultRoot: []
    });
  }

  it('discovers and executes tools from agents registered after startup', async () => {
    const toolManager = createToolManager();
    const dynamicAgent = new StubAgent();

    toolManager.registerDynamicAgent(dynamicAgent);

    const getTools = toolManager.getTool('getTools');
    const discovery = await getTools?.execute({
      workspaceId: 'default',
      sessionId: 'session_test',
      memory: 'Testing dynamic app registration.',
      goal: 'Inspect dynamically registered tools.',
      tool: 'web-tools open-webpage'
    });

    expect(discovery).toMatchObject({
      success: true,
      data: {
        tools: [
          expect.objectContaining({
            agent: 'webTools',
            tool: 'openWebpage',
            command: 'web-tools open-webpage'
          })
        ]
      }
    });

    const useTools = toolManager.getTool('useTools');
    const execution = await useTools?.execute({
      workspaceId: 'default',
      sessionId: 'session_test',
      memory: 'Testing dynamic app registration.',
      goal: 'Execute a dynamically registered tool.',
      tool: 'web-tools open-webpage "https://example.com"'
    });

    expect(execution).toMatchObject({
      agent: 'webTools',
      tool: 'openWebpage',
      success: true,
      opened: 'https://example.com'
    });
  });

  it('throws when the same agent name is registered twice', () => {
    const toolManager = createToolManager();
    toolManager.registerDynamicAgent(new StubAgent());

    expect(() => toolManager.registerDynamicAgent(new StubAgent())).toThrow(
      'Agent webTools is already registered'
    );
  });

  it('removes dynamically unregistered agents from discovery', async () => {
    const toolManager = createToolManager();
    toolManager.registerDynamicAgent(new StubAgent());
    toolManager.unregisterDynamicAgent('webTools');

    const getTools = toolManager.getTool('getTools');
    const discovery = await getTools?.execute({
      workspaceId: 'default',
      sessionId: 'session_test',
      memory: 'Testing dynamic app removal.',
      goal: 'Ensure removed tools are no longer discoverable.',
      tool: 'web-tools'
    });

    expect(discovery).toMatchObject({
      success: false,
      error: expect.stringContaining('Unknown agent "web-tools"')
    });
  });
});
