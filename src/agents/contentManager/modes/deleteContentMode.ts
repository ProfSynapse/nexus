import { App } from 'obsidian';
import { BaseMode } from '../../baseMode';
import { DeleteContentParams, DeleteContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage, getErrorMessage } from '../../../utils/errorUtils';
import { parseWorkspaceContext } from '../../../utils/contextUtils';
import { MemoryService } from '../../memoryManager/services/MemoryService';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { NexusPluginWithServices } from '../../memoryManager/modes/utils/pluginTypes';

/**
 * Mode for deleting content from a file
 * Follows Single Responsibility Principle - only handles content deletion
 * File change detection are handled automatically by FileEventManager
 */
export class DeleteContentMode extends BaseMode<DeleteContentParams, DeleteContentResult> {
  private app: App;
  private memoryService: MemoryService | null = null;
  
  /**
   * Create a new DeleteContentMode
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'deleteContent',
      'Delete Content',
      'Delete content from a file in the vault',
      '1.0.0'
    );
    
    this.app = app;
  }
  
  /**
   * Execute the mode
   * @param params Mode parameters
   * @returns Promise that resolves with the delete result
   */
  async execute(params: DeleteContentParams): Promise<DeleteContentResult> {
    try {
      const { filePath, content, similarityThreshold = 0.95, workspaceContext } = params;
      
      const deletions = await ContentOperations.deleteContent(
        this.app,
        filePath,
        content,
        similarityThreshold
      );
      
      // File change detection are handled automatically by FileEventManager
      
      const resultData = {
        filePath,
        deletions
      };
      
      // Record session activity for memory tracking
      await this.recordActivity(params, resultData);
      
      const response = this.prepareResult(true, resultData, undefined, params.context, parseWorkspaceContext(workspaceContext) || undefined);
      
      return response;
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error deleting content: ', error), params.context, parseWorkspaceContext(params.workspaceContext) || undefined);
    }
  }
  
  
  /**
   * Get the JSON schema for the mode's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to modify'
        },
        content: {
          type: 'string',
          description: 'Content to delete'
        },
        similarityThreshold: {
          type: 'number',
          description: 'Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)',
          default: 0.95,
          minimum: 0.0,
          maximum: 1.0
        }
      },
      required: ['filePath', 'content']
    };
    
    return this.getMergedSchema(customSchema);
  }
  
  /**
   * Get the JSON schema for the mode's result
   * @returns JSON schema object
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if success is false'
        },
        data: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file'
            },
            deletions: {
              type: 'number',
              description: 'Number of deletions made'
            }
          },
          required: ['filePath', 'deletions']
        },
        workspaceContext: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: 'ID of the workspace'
            },
            workspacePath: {
              type: 'array',
              items: {
                type: 'string'
              },
              description: 'Path of the workspace'
            },
            activeWorkspace: {
              type: 'boolean',
              description: 'Whether this is the active workspace'
            }
          }
        },
      },
      required: ['success']
    };
  }
  
  /**
   * Record content deletion activity in workspace memory
   * @param params Params used for deleting content
   * @param resultData Result data containing deletion information
   */
  private async recordActivity(
    params: DeleteContentParams,
    resultData: {
      filePath: string;
      deletions: number;
    }
  ): Promise<void> {
    // Parse workspace context
    const parsedContext = parseWorkspaceContext(params.workspaceContext) || undefined;
    
    // Skip if no workspace context
    if (!parsedContext?.workspaceId) {
      return;
    }
    
    // Skip if no memory service
    if (!this.memoryService) {
      try {
        // Try to get the memory service from the plugin
        const plugin = getNexusPlugin<NexusPluginWithServices>(this.app);
        if (plugin?.services?.memoryService) {
          this.memoryService = plugin.services.memoryService;
        } else {
          // No memory service available, skip activity recording
          return;
        }
      } catch (error) {
        console.error('Failed to get memory service from plugin:', getErrorMessage(error));
        return;
      }
    }
    
    // Create a descriptive content about this operation
    let contentSnippet = params.content.substring(0, 100);
    if (params.content.length > 100) {
      contentSnippet += '...';
    }
    
    const content = `Deleted content from ${params.filePath} (${resultData.deletions} deletions)\nDeleted: ${contentSnippet}`;
    
    try {
      await this.memoryService!.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'content',
        content: content,
        timestamp: Date.now(),
        metadata: {
          tool: 'contentManager.deleteContent',
          params: { filePath: params.filePath },
          result: resultData,
          relatedFiles: [params.filePath]
        },
        sessionId: params.context.sessionId
      });
    } catch (error) {
      console.error('Failed to record delete content activity:', getErrorMessage(error));
    }
  }
}
