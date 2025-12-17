import { App, Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CreateFolderParams, CreateFolderResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { MemoryService } from "../../memoryManager/services/MemoryService";
import {parseWorkspaceContext} from '../../../utils/contextUtils';
import { createErrorMessage } from '../../../utils/errorUtils';
import { getNexusPlugin } from '../../../utils/pluginLocator';

/**
 * Type guard to check if plugin has services with memoryService
 */
interface PluginWithServices extends Plugin {
  services: {
    memoryService: MemoryService;
  };
}

/**
 * Type guard to check if object has services property with memoryService
 */
function hasMemoryService(plugin: Plugin | null): plugin is PluginWithServices {
  return plugin !== null &&
         'services' in plugin &&
         typeof plugin.services === 'object' &&
         plugin.services !== null &&
         'memoryService' in plugin.services &&
         plugin.services.memoryService !== undefined &&
         plugin.services.memoryService !== null;
}

/**
 * Tool to create a new folder
 */
export class CreateFolderTool extends BaseTool<CreateFolderParams, CreateFolderResult> {
  private app: App;
  private memoryService: MemoryService | null = null;

  /**
   * Create a new CreateFolderTool
   * @param app Obsidian app instance
   * @param memoryService Optional memory service for activity recording
   */
  constructor(app: App, memoryService?: MemoryService | null) {
    super(
      'createFolder',
      'Create Folder',
      'Create a new folder in the vault',
      '1.0.0'
    );
    this.app = app;
    this.memoryService = memoryService || null;

    // Try to get memory service from plugin if not provided
    if (!this.memoryService) {
      try {
        const plugin = getNexusPlugin<PluginWithServices>(this.app);
        if (hasMemoryService(plugin)) {
          this.memoryService = plugin.services?.memoryService || null;
        }
      } catch (error) {
        console.error('Failed to get memory service:', error);
      }
    }
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: CreateFolderParams): Promise<CreateFolderResult> {
    try {
      // Validate parameters
      if (!params.path) {
        return this.prepareResult(false, undefined, 'Path is required');
      }

      // Create the folder using existing utility if available
      let result: { path: string; existed: boolean };

      if (typeof FileOperations?.createFolder === 'function') {
        const existed = await FileOperations.createFolder(this.app, params.path);
        result = { path: params.path, existed };
      }
      // Otherwise use default implementation
      else {
        // Check if folder already exists
        const existingFolder = this.app.vault.getAbstractFileByPath(params.path);
        if (existingFolder) {
          result = { path: params.path, existed: true };
        } else {
          // Create the folder
          await this.app.vault.createFolder(params.path);
          result = { path: params.path, existed: false };
        }
      }

      // Record this activity in workspace memory if applicable
      const parsedContext = parseWorkspaceContext(params.workspaceContext) || undefined;
  if (parsedContext?.workspaceId) {
        await this.recordActivity(params, result);
      }

      return this.prepareResult(true, result, undefined, params.context, parseWorkspaceContext(params.workspaceContext) || undefined);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to create folder: ', error));
    }
  }

  /**
   * Get the parameter schema
   */
  getParameterSchema(): Record<string, any> {
    // Create the tool-specific schema
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the folder to create (REQUIRED)'
        }
      },
      required: ['path']
    };

    // Merge with common schema (workspace context)
    return this.getMergedSchema(toolSchema);
  }

  /**
   * Record folder creation activity in workspace memory
   * @param params Params used for folder creation
   * @param result Result of folder creation operation
   */
  private async recordActivity(
    params: CreateFolderParams,
    result: { path: string; existed: boolean }
  ): Promise<void> {
    // Parse workspace context
    const parsedContext = parseWorkspaceContext(params.workspaceContext) || undefined;

    if (!parsedContext?.workspaceId || !this.memoryService) {
      return; // Skip if no workspace context or memory service
    }

    try {
      // Create a descriptive content about this operation
      const content = `${result.existed ? 'Found existing' : 'Created new'} folder: ${params.path}`;

      // Record the activity using memory service
      await this.memoryService.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'research', // Using supported activity type
        content,
        timestamp: Date.now(),
          metadata: {
            tool: 'CreateFolderTool',
            params: {
              path: params.path
            },
            result: {
              existed: result.existed
            },
            relatedFiles: []
          },
          sessionId: params.context.sessionId
        }
      );
    } catch (error) {
      // Log but don't fail the main operation
      console.error('Failed to record folder creation activity:', createErrorMessage('', error));

      // Try to get memory service from plugin if not available
      if (!this.memoryService) {
        try {
          const plugin = getNexusPlugin<PluginWithServices>(this.app);
          if (hasMemoryService(plugin)) {
            this.memoryService = plugin.services?.memoryService || null;
            // Try again with the newly found service
            await this.recordActivity(params, result);
          }
        } catch (retryError) {
          console.error('Error accessing memory service for retry:', createErrorMessage('', retryError));
        }
      }
    }
  }

  /**
   * Get the result schema
   */
  getResultSchema(): Record<string, any> {
    const baseSchema = super.getResultSchema();

    // Extend the base schema to include our specific data
    baseSchema.properties.data = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the created folder'
        },
        existed: {
          type: 'boolean',
          description: 'Whether the folder already existed'
        }
      }
    };

    return baseSchema;
  }
}
