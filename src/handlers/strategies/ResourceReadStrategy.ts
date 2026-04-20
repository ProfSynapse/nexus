import { App } from 'obsidian';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IRequestStrategy } from './IRequestStrategy';
import { IRequestHandlerDependencies } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

interface ResourceReadRequest {
    method: string;
    params: {
        uri: string;
        uris?: string[];
    };
}

interface ResourceReadResponse {
    contents: Array<{
        uri: string;
        text: string;
        mimeType: string;
    }>;
}

/**
 * Strategy for handling resource read requests
 * Follows Strategy Pattern for clean request handling
 */
export class ResourceReadStrategy implements IRequestStrategy<ResourceReadRequest, ResourceReadResponse> {
    constructor(
        private dependencies: IRequestHandlerDependencies,
        private app: App
    ) {}

    canHandle(request: ResourceReadRequest): boolean {
        return request.method === 'resources/read';
    }

    async handle(request: ResourceReadRequest): Promise<ResourceReadResponse> {
        try {
            logger.systemLog('ResourceReadStrategy: Handling resource read request');
            
            const { uri, uris } = request.params;
            
            // Validate parameters
            if (!uri && (!uris || uris.length === 0)) {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    'Either uri or uris parameter is required'
                );
            }
            
            // Handle multiple URIs if provided
            if (uris && uris.length > 0) {
                return await this.dependencies.resourceReadService.readMultipleResources(uris);
            }
            
            // Handle single URI
            if (uri) {
                return await this.dependencies.resourceReadService.readResource(uri);
            }
            
            throw new McpError(
                ErrorCode.InvalidParams,
                'No valid URI provided for resource read'
            );
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ResourceReadStrategy');
            throw new McpError(ErrorCode.InternalError, 'Failed to read resource', error);
        }
    }
}