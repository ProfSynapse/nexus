import { App } from 'obsidian';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

interface ResourceListRequest {
    method: string;
    params?: {
        pathPrefix?: string;
    };
}

interface ResourceListResponse {
    resources: Array<{
        uri: string;
        name: string;
        mimeType: string;
    }>;
}

/**
 * Strategy for handling resource list requests
 * Follows Strategy Pattern for clean request handling
 */
export class ResourceListStrategy implements IRequestStrategy<ResourceListRequest, ResourceListResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies,
        private app: App
    ) {}

    canHandle(request: ResourceListRequest): boolean {
        return request.method === 'resources/list';
    }

    async handle(request: ResourceListRequest): Promise<ResourceListResponse> {
        try {
            
            const pathPrefix = request.params?.pathPrefix;
            
            if (pathPrefix) {
                return await this.dependencies.resourceListService.listResourcesByPath(pathPrefix);
            } else {
                return await this.dependencies.resourceListService.listResources();
            }
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ResourceListStrategy');
            throw new McpError(ErrorCode.InternalError, 'Failed to list resources', error);
        }
    }
}