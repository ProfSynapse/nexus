import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies, PromptDefinition } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

interface PromptsListRequest {
    method: string;
    params?: {
        category?: string;
    };
}

interface PromptsListResponse {
    prompts: PromptDefinition[];
}

/**
 * Strategy for handling prompts list requests
 * Follows Strategy Pattern for clean request handling
 */
export class PromptsListStrategy implements IRequestStrategy<PromptsListRequest, PromptsListResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies
    ) {}

    canHandle(request: PromptsListRequest): boolean {
        return request.method === 'prompts/list';
    }

    async handle(request: PromptsListRequest): Promise<PromptsListResponse> {
        try {
            
            const category = request.params?.category;
            
            if (category) {
                return await this.dependencies.promptsListService.listPromptsByCategory(category);
            } else {
                return await this.dependencies.promptsListService.listPrompts();
            }
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'PromptsListStrategy');
            throw new McpError(ErrorCode.InternalError, 'Failed to list prompts', error);
        }
    }
}