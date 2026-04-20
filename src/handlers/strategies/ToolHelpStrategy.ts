import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies } from '../interfaces/IRequestHandlerServices';
import { IAgent } from '../../agents/interfaces/IAgent';
import { logger } from '../../utils/logger';

interface ToolHelpRequest {
    method: string;
    params: {
        name: string;
        arguments: {
            mode: string;
        };
    };
}

interface ToolHelpResponse {
    content: Array<{
        type: string;
        text: string;
    }>;
}

/**
 * Strategy for handling tool help requests
 * Follows Strategy Pattern for clean request handling
 */
export class ToolHelpStrategy implements IRequestStrategy<ToolHelpRequest, ToolHelpResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies,
        private getAgent: (name: string) => IAgent
    ) {}

    canHandle(request: ToolHelpRequest): boolean {
        return request.method === 'tools/help';
    }

    async handle(request: ToolHelpRequest): Promise<ToolHelpResponse> {
        try {
            logger.systemLog('ToolHelpStrategy: Handling tool help request');
            
            const { name: toolName, arguments: args } = request.params;
            const { mode } = args;
            
            // Validate required parameters
            if (!toolName) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Tool name is required for help request'
                );
            }
            
            if (!mode) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Mode parameter is required for tool help'
                );
            }
            
            // Generate help using the service
            return await this.dependencies.toolHelpService.generateToolHelp(
                this.getAgent,
                toolName,
                mode
            );
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ToolHelpStrategy');
            throw new McpError(ErrorCode.InternalError, 'Failed to get tool help', error);
        }
    }
}