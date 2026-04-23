import { ITool } from '../../interfaces/ITool';
import { IAgent } from '../../interfaces/IAgent';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaData } from '../toolManager';
import { GetToolsParams, GetToolsResult } from '../types';
import { ToolCliNormalizer } from '../services/ToolCliNormalizer';

const INTERNAL_ONLY_TOOLS = new Set<string>([]);

export class GetToolsTool implements ITool<GetToolsParams, GetToolsResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  private agentRegistry: Map<string, IAgent>;
  private cliNormalizer: ToolCliNormalizer;
  private schemaData: SchemaData;

  constructor(agentRegistry: Map<string, IAgent>, schemaData: SchemaData) {
    this.slug = 'getTools';
    this.name = 'Get Tools';
    this.version = '1.0.0';
    this.agentRegistry = agentRegistry;
    this.cliNormalizer = new ToolCliNormalizer(agentRegistry);
    this.schemaData = schemaData;
    this.description = this.buildDescription(schemaData);
  }

  refreshDescription(schemaData?: SchemaData): void {
    if (schemaData) {
      this.schemaData = schemaData;
    }
    this.description = this.buildDescription(this.schemaData);
  }

  private buildDescription(schemaData: SchemaData): string {
    const lines = [
      'REQUIRED FIRST STEP: You MUST call getTools BEFORE calling useTools.',
      'This returns CLI-oriented command metadata for the tools you need next.',
      'Send workspaceId, sessionId, memory, goal, and constraints at the top level.',
      'Do not send a nested "context" object or legacy "request" array.',
      '',
      'Workflow: 1) Call getTools with one or more selectors → 2) Call useTools with one or more CLI-style commands',
      'Known-good example: {"workspaceId":"default","sessionId":"session_123","memory":"Summarize work so far.","goal":"Inspect available storage tools.","tool":"storage move, content read"}',
      'Example selectors: tool="--help", tool="storage", tool="storage move", tool="storage move, content read"',
      '',
      'Agents:'
    ];

    for (const [agentName, agent] of this.agentRegistry) {
      if (agentName === 'toolManager') continue;
      const tools = agent.getTools()
        .map(tool => tool.slug)
        .filter(slug => !INTERNAL_ONLY_TOOLS.has(slug));
      if (tools.length > 0) {
        lines.push(`${agentName}: [${tools.join(',')}]`);
      }
    }

    if (schemaData.customAgents.length > 0) {
      lines.push('');
      lines.push('Custom Agents:');
      for (const agent of schemaData.customAgents) {
        lines.push(`- "${agent.name}": ${agent.description || 'No description'}`);
      }
    }

    lines.push('');
    lines.push(`Workspaces: [default${schemaData.workspaces.length > 0 ? `,${schemaData.workspaces.map(w => w.name).join(',')}` : ''}]`);

    if (schemaData.vaultRoot.length > 0) {
      const folders = schemaData.vaultRoot.slice(0, 5);
      if (schemaData.vaultRoot.length > 5) folders.push('...');
      lines.push(`Vault: [${folders.join(',')}]`);
    }

    return lines.join('\n');
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- implements ITool.execute() async interface
  async execute(params: GetToolsParams): Promise<GetToolsResult> {
    try {
      const requests = this.cliNormalizer.normalizeDiscoveryRequests(params);
      const resultSchemas = [];
      const notFound: string[] = [];

      for (const item of requests) {
        const agent = this.agentRegistry.get(item.agent);
        if (!agent) {
          notFound.push(`Agent "${item.agent}" not found`);
          continue;
        }

        if (!item.tools || item.tools.length === 0) {
          const allTools = agent.getTools().filter(tool => !INTERNAL_ONLY_TOOLS.has(tool.slug));
          for (const tool of allTools) {
            resultSchemas.push(this.cliNormalizer.buildCliSchema(item.agent, tool));
          }
          continue;
        }

        for (const toolSlug of item.tools) {
          if (INTERNAL_ONLY_TOOLS.has(toolSlug)) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${item.agent}"`);
            continue;
          }

          const tool = agent.getTool(toolSlug);
          if (!tool) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${item.agent}"`);
            continue;
          }

          resultSchemas.push(this.cliNormalizer.buildCliSchema(item.agent, tool));
        }
      }

      return {
        success: true,
        ...(notFound.length > 0 ? { error: `Some items not found: ${notFound.join(', ')}` } : {}),
        data: {
          tools: resultSchemas
        }
      };
    } catch (error) {
      return {
        success: false,
        error: `Error getting tools: ${getErrorMessage(error)}`
      };
    }
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: 'Workspace ID. Optional. Defaults to "default".'
        },
        sessionId: {
          type: 'string',
          description: 'Session identifier for traces. Optional; auto-generated if omitted.'
        },
        memory: {
          type: 'string',
          description: 'Brief summary of the conversation so far.'
        },
        goal: {
          type: 'string',
          description: 'Brief statement of the current objective.'
        },
        constraints: {
          type: 'string',
          description: 'Optional rules or limits.'
        },
        tool: {
          type: 'string',
          description: 'CLI-style selector string. Supports one or more selectors separated by commas. Examples: "--help", "storage", "storage move", "storage move, content read".'
        }
      },
      required: ['workspaceId', 'sessionId', 'memory', 'goal', 'tool']
    };
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        error: { type: 'string' },
        data: {
          type: 'object',
          properties: {
            tools: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  agent: { type: 'string' },
                  tool: { type: 'string' },
                  description: { type: 'string' },
                  command: { type: 'string' },
                  usage: { type: 'string' },
                  arguments: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        flag: { type: 'string' },
                        type: { type: 'string' },
                        required: { type: 'boolean' },
                        positional: { type: 'boolean' },
                        description: { type: 'string' }
                      },
                      required: ['name', 'flag', 'type', 'required', 'positional']
                    }
                  },
                  examples: {
                    type: 'array',
                    items: { type: 'string' }
                  }
                },
                required: ['agent', 'tool', 'description', 'command', 'usage', 'arguments', 'examples']
              }
            }
          }
        }
      },
      required: ['success']
    };
  }
}
