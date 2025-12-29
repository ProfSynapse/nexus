import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

interface PromptsGetRequest {
    method: string;
    params?: {
        name: string;
        arguments?: Record<string, unknown>;
    };
}

interface PromptsGetResponse {
    description?: string;
    messages: Array<{
        role: 'user' | 'assistant';
        content: {
            type: 'text';
            text: string;
        };
    }>;
}

/**
 * Strategy for handling prompts get requests
 * Follows Strategy Pattern for clean request handling
 */
export class PromptsGetStrategy implements IRequestStrategy<PromptsGetRequest, PromptsGetResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies
    ) {}

    canHandle(request: PromptsGetRequest): boolean {
        return request.method === 'prompts/get';
    }

    async handle(request: PromptsGetRequest): Promise<PromptsGetResponse> {
        try {
            logger.systemLog('PromptsGetStrategy: Handling prompts get request');
            
            const promptName = request.params?.name;
            if (!promptName) {
                throw new McpError(ErrorCode.InvalidParams, 'Prompt name is required');
            }
            
            // Get the prompt content
            const promptContent = await this.dependencies.promptsListService.getPrompt(promptName);
            
            if (!promptContent) {
                throw new McpError(ErrorCode.InvalidParams, `Prompt "${promptName}" not found`);
            }
            
            // Return the prompt as a user message in MCP format
            return {
                messages: [
                    {
                        role: 'user',
                        content: {
                            type: 'text',
                            text: promptContent
                        }
                    }
                ]
            };
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'PromptsGetStrategy');
            throw new McpError(ErrorCode.InternalError, 'Failed to get prompt', error);
        }
    }
}