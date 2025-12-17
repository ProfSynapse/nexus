/**
 * GetToolsTool - Discovery tool for the two-tool architecture
 * Returns tool schemas for requested agents/tools
 *
 * Note: This tool implements ITool directly instead of extending BaseTool
 * because it's a discovery tool that doesn't require context parameters.
 */

import { ITool } from '../../interfaces/ITool';
import { GetToolsParams, GetToolsResult, ToolSchema, getToolContextSchema } from '../types';
import { IAgent } from '../../interfaces/IAgent';
import { AGENT_REGISTRY } from '../../../config/agents';
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaData } from '../toolManager';

/**
 * Tool for discovering available tools and their schemas
 * Implements ITool directly since it doesn't need context parameters
 */
export class GetToolsTool implements ITool<GetToolsParams, GetToolsResult> {
  slug: string;
  name: string;
  description: string;
  version: string;

  private agentRegistry: Map<string, IAgent>;

  /**
   * Create a new GetToolsTool
   * @param agentRegistry Map of agent name to agent instance
   * @param schemaData Dynamic data for description (workspaces, custom agents, vault structure)
   */
  constructor(agentRegistry: Map<string, IAgent>, schemaData: SchemaData) {
    this.slug = 'getTools';
    this.name = 'Get Tools';
    this.description = this.buildDescription(schemaData);
    this.version = '1.0.0';

    this.agentRegistry = agentRegistry;
  }

  /**
   * Build the dynamic description with all available info
   */
  private buildDescription(schemaData: SchemaData): string {
    const lines = [
      'Get parameter schemas for specific tools. You MUST specify which tools you need.',
      ''
    ];

    // System tools section
    lines.push('System Tools:');
    for (const [agentName, config] of Object.entries(AGENT_REGISTRY)) {
      if (agentName === 'toolManager') continue;
      const toolArray = JSON.stringify(config.tools);
      lines.push(`${agentName}: ${toolArray}`);
    }

    // Custom agents section
    if (schemaData.customAgents.length > 0) {
      lines.push('');
      lines.push('Your Custom Agents:');
      for (const agent of schemaData.customAgents) {
        lines.push(`- "${agent.name}": ${agent.description || 'No description'}`);
      }
    }

    // Workspaces section
    lines.push('');
    lines.push('Your Workspaces:');
    lines.push('- "default": Global workspace (always available)');
    for (const workspace of schemaData.workspaces) {
      lines.push(`- "${workspace.name}": ${workspace.description || 'No description'}`);
    }

    // Vault structure section
    if (schemaData.vaultRoot.length > 0) {
      lines.push('');
      lines.push('Vault Root:');
      for (const item of schemaData.vaultRoot.slice(0, 10)) { // Limit to 10 items
        lines.push(`- /${item}`);
      }
      if (schemaData.vaultRoot.length > 10) {
        lines.push(`- ... and ${schemaData.vaultRoot.length - 10} more`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Execute the tool
   * @param params Tool parameters with request map
   * @returns Promise that resolves with tool schemas
   */
  async execute(params: GetToolsParams): Promise<GetToolsResult> {
    try {
      const { request } = params;
      const resultSchemas: ToolSchema[] = [];
      const notFound: string[] = [];

      // If no request provided, return empty with helpful message
      if (!request || Object.keys(request).length === 0) {
        return {
          success: true,
          data: { tools: [] },
          error: 'No request provided. Use format: { "request": { "agentName": ["tool1"] } }'
        };
      }

      // Process each agent in the request
      for (const [agentName, toolNames] of Object.entries(request)) {
        const agent = this.agentRegistry.get(agentName);
        if (!agent) {
          notFound.push(`Agent "${agentName}" not found`);
          continue;
        }

        // null, undefined, or empty array is NOT allowed - must specify tools
        if (!toolNames || toolNames.length === 0) {
          notFound.push(`Agent "${agentName}" requires specific tool names - use getTools description to see available tools`);
          continue;
        } else {
          // Get specific tools
          for (const toolSlug of toolNames) {
            const tool = agent.getTool(toolSlug);
            if (!tool) {
              notFound.push(`Tool "${toolSlug}" not found in agent "${agentName}"`);
              continue;
            }
            const schema = this.buildToolSchema(agentName, tool);
            resultSchemas.push(schema);
          }
        }
      }

      // Build result
      const result: GetToolsResult = {
        success: true,
        data: { tools: resultSchemas }
      };

      // Add warning about not found items
      if (notFound.length > 0) {
        result.error = `Some items not found: ${notFound.join(', ')}`;
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: `Error getting tools: ${getErrorMessage(error)}`
      };
    }
  }

  /**
   * Build a ToolSchema from an agent and tool
   */
  private buildToolSchema(agentName: string, tool: { slug: string; description: string; getParameterSchema(): unknown }): ToolSchema {
    // Get the full parameter schema
    const fullSchema = tool.getParameterSchema() as Record<string, unknown>;

    // Strip common parameters (context, workspaceContext) - LLM doesn't need to see these
    // since useTool handles context at the top level
    const strippedSchema = this.stripCommonParams(fullSchema);

    return {
      agent: agentName,
      tool: tool.slug,
      description: tool.description,
      inputSchema: strippedSchema
    };
  }

  /**
   * Strip common parameters from schema that are handled by useTool
   */
  private stripCommonParams(schema: Record<string, unknown>): Record<string, unknown> {
    const result = { ...schema };

    // Remove common params from properties
    if (result.properties && typeof result.properties === 'object') {
      const props = { ...(result.properties as Record<string, unknown>) };
      delete props.context;
      delete props.workspaceContext;
      result.properties = props;
    }

    // Remove from required array if present
    if (result.required && Array.isArray(result.required)) {
      result.required = result.required.filter(
        (r: string) => r !== 'context' && r !== 'workspaceContext'
      );
    }

    return result;
  }

  /**
   * Get the JSON schema for the tool's parameters
   * Context is REQUIRED - provides session tracking and memory/goal for traces
   */
  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        context: getToolContextSchema(),
        request: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1
          },
          description: 'Map of agent names to tool arrays. You MUST specify which tools you need. Example: { "vaultManager": ["listDirectory"], "contentManager": ["readContent", "createContent"] }'
        }
      },
      required: ['context', 'request']
    };
  }

  /**
   * Get the JSON schema for the tool's result
   */
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
                  agent: { type: 'string', description: 'Agent name' },
                  tool: { type: 'string', description: 'Tool name' },
                  description: { type: 'string', description: 'Tool description' },
                  inputSchema: { type: 'object', description: 'Parameter schema' }
                },
                required: ['agent', 'tool', 'description', 'inputSchema']
              }
            }
          }
        }
      },
      required: ['success']
    };
  }
}
