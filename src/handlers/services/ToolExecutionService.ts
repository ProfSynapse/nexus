import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IToolExecutionService, ToolExecutionResult } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';
import { getErrorMessage } from '../../utils/errorUtils';

export class ToolExecutionService implements IToolExecutionService {
    async executeAgent(
        agent: IAgent,
        tool: string,
        params: Record<string, unknown>
    ): Promise<ToolExecutionResult> {
        try {
            this.validateToolSpecificParams(agent.name, tool, params);
            const result = await agent.executeTool(tool, params);
            // Ensure result conforms to ToolExecutionResult
            if (result && typeof result === 'object' && 'success' in result) {
                return result as ToolExecutionResult;
            }
            // Wrap non-conforming results
            return { success: true, data: result };
        } catch (error) {
            logger.systemError(error as Error, `Tool Execution - ${agent.name}:${tool}`);
            throw error;
        }
    }

    private validateToolSpecificParams(agentName: string, tool: string, params: Record<string, unknown>): void {
        switch (agentName) {
            case 'memoryManager':
                this.validateMemoryManagerParams(tool, params);
                break;
            case 'storageManager':
                this.validateStorageManagerParams(tool, params);
                break;
            case 'contentManager':
                this.validateContentManagerParams(tool, params);
                break;
        }
    }

    private validateMemoryManagerParams(tool: string, params: Record<string, unknown>): void {
        if (tool === 'createState' && !params.name) {
            throw new McpError(
                ErrorCode.InvalidParams,
                'Missing required parameter: name for createState tool'
            );
        }
    }

    private validateStorageManagerParams(tool: string, params: Record<string, unknown>): void {
        if (['list', 'createFolder'].includes(tool) &&
            params.path === undefined) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `Missing required parameter: path for ${tool} tool`
            );
        }
    }

    private validateContentManagerParams(tool: string, params: Record<string, unknown>): void {
        if (tool === 'createContent') {
            if (!params.filePath) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Missing required parameter: filePath for createContent tool'
                );
            }
            if (params.content === undefined || params.content === null) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Missing required parameter: content for createContent tool'
                );
            }
        }
    }
}