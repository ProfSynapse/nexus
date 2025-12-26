import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { ITool } from '../../agents/interfaces/ITool';
import { logger } from '../../utils/logger';

interface ToolListRequest {
    method: string;
}

interface ToolListResponse {
    tools: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
    }>;
}

/**
 * Two-Tool Architecture: Returns only toolManager_getTools and toolManager_useTools
 *
 * This replaces the old 50+ tool surface with just 2 tools:
 * - toolManager_getTools: Discovery - returns tool schemas for LLM reference
 * - toolManager_useTools: Execution - single entry point with context-first design
 *
 * Token savings: ~95% reduction in upfront schemas (~15,000 → ~500 tokens)
 */
export class ToolListStrategy implements IRequestStrategy<ToolListRequest, ToolListResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies,
        private agents: Map<string, IAgent>,
        private isVaultEnabled: boolean,
        private vaultName?: string
    ) {}

    canHandle(request: ToolListRequest): boolean {
        return request.method === 'tools/list';
    }

    async handle(request: ToolListRequest): Promise<ToolListResponse> {
        try {
            // Two-Tool Architecture: Return only toolManager tools
            const toolManagerAgent = this.agents.get('toolManager');

            if (!toolManagerAgent) {
                logger.systemWarn('[ToolListStrategy] ToolManager agent not found - returning empty tools list');
                return { tools: [] };
            }

            // Get tools from toolManager (getTools and useTools)
            const toolManagerTools = toolManagerAgent.getTools();

            // Convert to MCP tool format
            // Use underscore separator (MCP requires ^[a-zA-Z0-9_-]{1,64}$ - no dots allowed)
            const tools = toolManagerTools.map((tool: ITool<unknown, unknown>) => ({
                name: `toolManager_${tool.slug}`,
                description: tool.description,
                inputSchema: tool.getParameterSchema() as Record<string, unknown>
            }));

            return { tools };
        } catch (error) {
            logger.systemError(error as Error, "Tool List Strategy");
            throw new McpError(ErrorCode.InternalError, 'Failed to list tools', error);
        }
    }
}