import type { IAgent } from '../../interfaces/IAgent';
import type { ITool } from '../../interfaces/ITool';

export interface ToolManagerMcpDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Serialize ToolManager's public MCP surface. The MCP request handler and the
 * release schema exporter share this function so the committed catalog cannot
 * drift from what `tools/list` actually returns.
 */
export function buildToolManagerMcpCatalog(agent: IAgent): ToolManagerMcpDefinition[] {
  return agent.getTools().map((tool: ITool<unknown, unknown>) => ({
    name: `toolManager_${tool.slug}`,
    description: tool.description,
    inputSchema: tool.getParameterSchema(),
  }));
}
