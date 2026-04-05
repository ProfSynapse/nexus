import { App, TFile } from 'obsidian';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { IResourceReadService } from '../interfaces/IRequestHandlerServices';
import { logger } from '../../utils/logger';

/**
 * Resource content interface for MCP resource reading
 */
interface ResourceContent {
    uri: string;
    text: string;
    mimeType: string;
}

/**
 * Service for reading vault resource content
 * Applies Single Responsibility Principle by focusing solely on resource content retrieval
 */
export class ResourceReadService implements IResourceReadService {
    constructor(private app: App) {}

    /**
     * Read resource content by URI
     * @param uri Resource URI to read
     * @returns Promise resolving to resource content
     */
    async readResource(uri: string): Promise<{ contents: ResourceContent[] }> {
        try {
            logger.systemLog(`ResourceReadService: Reading resource ${uri}`);
            
            const content = await this.getResourceContent(uri);
            
            return {
                contents: [{
                    uri,
                    text: content,
                    mimeType: "text/markdown"
                }]
            };
        } catch (error) {
            if (error instanceof McpError) {
                throw error;
            }
            logger.systemError(error as Error, 'ResourceReadService');
            throw new McpError(ErrorCode.InternalError, 'Failed to read resource', error);
        }
    }

    /**
     * Read multiple resources by URIs (future enhancement)
     * @param uris Array of resource URIs to read
     * @returns Promise resolving to array of resource contents
     */
    async readMultipleResources(uris: string[]): Promise<{ contents: ResourceContent[] }> {
        try {
            logger.systemLog(`ResourceReadService: Reading ${uris.length} resources`);
            
            const contents: ResourceContent[] = [];
            
            for (const uri of uris) {
                try {
                    const content = await this.getResourceContent(uri);
                    contents.push({
                        uri,
                        text: content,
                        mimeType: "text/markdown"
                    });
                } catch {
                    logger.systemWarn(`ResourceReadService: Failed to read resource ${uri}`);
                    // Continue with other resources, but log the failure
                }
            }
            
            return { contents };
        } catch (error) {
            logger.systemError(error as Error, 'ResourceReadService');
            throw new McpError(ErrorCode.InternalError, 'Failed to read multiple resources', error);
        }
    }

    /**
     * Get resource content from vault file
     * @param uri Resource URI
     * @returns Promise resolving to file content
     * @private
     */
    private async getResourceContent(uri: string): Promise<string> {
        // Parse obsidian:// URI to get file path
        const path = this.parseResourceUri(uri);
        
        // Get file from vault
        const file = this.app.vault.getAbstractFileByPath(path);
        
        if (!(file instanceof TFile)) {
            throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
        }
        
        // Read file content
        return await this.app.vault.read(file);
    }


    /**
     * Parse resource URI to extract file path
     * @param uri Resource URI (e.g., "obsidian://path/to/file.md")
     * @returns File path
     * @private
     */
    private parseResourceUri(uri: string): string {
        if (!uri.startsWith('obsidian://')) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid resource URI format: ${uri}`);
        }
        
        return uri.replace('obsidian://', '');
    }

    /**
     * Check if resource exists in vault
     * @param uri Resource URI
     * @returns Promise resolving to boolean
     */
    resourceExists(uri: string): Promise<boolean> {
        try {
            const path = this.parseResourceUri(uri);
            const file = this.app.vault.getAbstractFileByPath(path);
            return Promise.resolve(file instanceof TFile);
        } catch {
            logger.systemWarn(`ResourceReadService: Resource existence check failed for ${uri}`);
            return Promise.resolve(false);
        }
    }
}
