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
import { getErrorMessage } from '../../../utils/errorUtils';
import { SchemaData } from '../toolManager';

/**
 * Internal-only tools hidden from external MCP clients (Claude Desktop)
 * These tools require internal chat context and won't work via MCP.
 */
const INTERNAL_ONLY_TOOLS = new Set<string>([
  'subagent'  // Internal chat UI only - requires conversation context
]);

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
    this.version = '1.0.0';
    this.agentRegistry = agentRegistry;

    // Build description AFTER agentRegistry is set (uses actual registered agents)
    this.description = this.buildDescription(schemaData);
  }

  /**
   * Build the dynamic description from actual registered agents
   * Filters out internal-only tools that should not be exposed to MCP clients
   */
  private buildDescription(schemaData: SchemaData): string {
    const lines = [
      'Get parameter schemas for specific tools.',
      '',
      'REQUIRED: Specify at least one agent and tool in the request array.',
      'Example: { "request": [{ "agent": "storageManager", "tools": ["list"] }] }',
      ''
    ];

    // Build from actual registered agents (single source of truth)
    // Filter out internal-only tools that shouldn't be exposed externally
    lines.push('Agents:');
    for (const [agentName, agent] of this.agentRegistry) {
      if (agentName === 'toolManager') continue;
      const tools = agent.getTools()
        .map(t => t.slug)
        .filter(slug => !INTERNAL_ONLY_TOOLS.has(slug));
      // Only list agent if it has visible tools
      if (tools.length > 0) {
        lines.push(`${agentName}: [${tools.join(',')}]`);
      }
    }

    // Custom agents section
    if (schemaData.customAgents.length > 0) {
      lines.push('');
      lines.push('Custom Agents:');
      for (const agent of schemaData.customAgents) {
        lines.push(`- "${agent.name}": ${agent.description || 'No description'}`);
      }
    }

    // Workspaces section
    lines.push('');
    lines.push('Workspaces: [default' + (schemaData.workspaces.length > 0 ? ',' + schemaData.workspaces.map(w => w.name).join(',') : '') + ']');

    // Vault structure section (compact)
    if (schemaData.vaultRoot.length > 0) {
      const folders = schemaData.vaultRoot.slice(0, 5);
      if (schemaData.vaultRoot.length > 5) folders.push('...');
      lines.push('Vault: [' + folders.join(',') + ']');
    }

    return lines.join('\n');
  }

  /**
   * Execute the tool
   * @param params Tool parameters with request array
   * @returns Promise that resolves with tool schemas
   */
  async execute(params: GetToolsParams): Promise<GetToolsResult> {
    try {
      const { request } = params;
      const resultSchemas: ToolSchema[] = [];
      const notFound: string[] = [];

      // REQUIRE at least 1 agent/tool - don't allow empty requests
      if (!request || !Array.isArray(request) || request.length === 0) {
        return {
          success: false,
          error: 'Request array is required. Example: { "request": [{ "agent": "storageManager", "tools": ["list"] }] }. See tool description for available agents and tools.'
        };
      }

      // Process each request item in the array
      for (const item of request) {
        const agentName = item.agent;
        const toolNames = item.tools;

        // Validate item structure
        if (!agentName || typeof agentName !== 'string') {
          notFound.push('Missing or invalid "agent" field in request item');
          continue;
        }

        const agent = this.agentRegistry.get(agentName);
        if (!agent) {
          notFound.push(`Agent "${agentName}" not found`);
          continue;
        }

        // Validate tools array
        if (!toolNames || !Array.isArray(toolNames) || toolNames.length === 0) {
          notFound.push(`Agent "${agentName}" requires "tools" array with at least one tool name`);
          continue;
        }

        // Get specific tools (skip internal-only tools)
        for (const toolSlug of toolNames) {
          if (INTERNAL_ONLY_TOOLS.has(toolSlug)) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${agentName}"`);
            continue;
          }
          const tool = agent.getTool(toolSlug);
          if (!tool) {
            notFound.push(`Tool "${toolSlug}" not found in agent "${agentName}"`);
            continue;
          }
          const schema = this.buildToolSchema(agentName, tool);
          resultSchemas.push(schema);
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
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                description: 'Agent name (e.g., "storageManager", "contentManager", "promptManager")'
              },
              tools: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                description: 'Tool names to get schemas for'
              }
            },
            required: ['agent', 'tools']
          },
          minItems: 1,
          description: 'REQUIRED: Array of agent/tools requests. Example: [{ "agent": "storageManager", "tools": ["list"] }]'
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
