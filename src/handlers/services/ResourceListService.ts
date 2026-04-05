import { App } from 'obsidian';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IResourceListService } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

/**
 * Resource interface for MCP resource listing
 */
interface Resource {
    uri: string;
    name: string;
    mimeType: string;
}

/**
 * Service for listing vault resources
 * Applies Single Responsibility Principle by focusing solely on resource enumeration
 */
export class ResourceListService implements IResourceListService {
    constructor(private app: App) {}

    /**
     * Get all vault resources as MCP resources
     * @returns Promise resolving to array of resources
     */
    listResources(): Promise<{ resources: Resource[] }> {
        try {

            const resources: Resource[] = [];
            const files = this.app.vault.getMarkdownFiles();

            for (const file of files) {
                resources.push({
                    uri: `obsidian://${file.path}`,
                    name: file.basename,
                    mimeType: "text/markdown"
                });
            }

            return Promise.resolve({ resources });
        } catch (error) {
            logger.systemError(error as Error, 'ResourceListService');
            throw new McpError(ErrorCode.InternalError, 'Failed to list resources', error);
        }
    }

    /**
     * Get resources filtered by path prefix (future enhancement)
     * @param pathPrefix Optional path prefix to filter resources
     * @returns Promise resolving to filtered resources
     */
    async listResourcesByPath(pathPrefix?: string): Promise<{ resources: Resource[] }> {
        try {
            const allResources = await this.listResources();
            
            if (!pathPrefix) {
                return allResources;
            }
            
            const filteredResources = allResources.resources.filter(resource => 
                resource.uri.includes(pathPrefix)
            );
            
            return { resources: filteredResources };
        } catch (error) {
            logger.systemError(error as Error, 'ResourceListService');
            throw new McpError(ErrorCode.InternalError, 'Failed to list resources by path', error);
        }
    }
}