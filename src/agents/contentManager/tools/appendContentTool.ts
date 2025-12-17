import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { AppendContentParams, AppendContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage, getErrorMessage } from '../../../utils/errorUtils';
import { parseWorkspaceContext } from '../../../utils/contextUtils';
import { MemoryService } from '../../memoryManager/services/MemoryService';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { NexusPluginWithServices } from '../../memoryManager/modes/utils/pluginTypes';

/**
 * Tool for appending content to a file
 */
export class AppendContentTool extends BaseTool<AppendContentParams, AppendContentResult> {
  private app: App;
  private memoryService: MemoryService | null = null;
  
  /**
   * Create a new AppendContentTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'appendContent',
      'Append Content',
      'Append content to a file in the vault',
      '1.0.0'
    );
    
    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the append result
   */
  async execute(params: AppendContentParams): Promise<AppendContentResult> {
    try {
      const { filePath, content, workspaceContext } = params;
      
      const result = await ContentOperations.appendContent(this.app, filePath, content);
      
      // File change detection are handled automatically by FileEventManager
      
      const resultData = {
        filePath,
        appendedLength: result.appendedLength,
        totalLength: result.totalLength
      };
      
      // Record session activity for memory tracking
      await this.recordActivity(params, resultData);
      
      const response = this.prepareResult(true, resultData, undefined, params.context, parseWorkspaceContext(workspaceContext) || undefined);
      
      return response;
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error appending content: ', error), params.context, parseWorkspaceContext(params.workspaceContext) || undefined);
    }
  }
  
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to append to'
        },
        content: {
          type: 'string',
          description: 'Content to append to the file'
        }
      },
      required: ['filePath', 'content']
    };
    
    return this.getMergedSchema(customSchema);
  }
  
  /**
   * Get the JSON schema for the tool's result
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
            appendedLength: {
              type: 'number',
              description: 'Length of the content appended'
            },
            totalLength: {
              type: 'number',
              description: 'Total length of the file after appending'
            }
          },
          required: ['filePath', 'appendedLength', 'totalLength']
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
   * Record content appending activity in workspace memory
   * @param params Params used for appending content
   * @param resultData Result data containing append information
   */
  private async recordActivity(
    params: AppendContentParams,
    resultData: {
      filePath: string;
      appendedLength: number;
      totalLength: number;
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
    
    const content = `Appended to file ${params.filePath} (${resultData.appendedLength} chars added, ${resultData.totalLength} total)\nContent: ${contentSnippet}`;
    
    try {
      await this.memoryService!.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'content',
        content: content,
        timestamp: Date.now(),
        metadata: {
          tool: 'contentManager.appendContent',
          params: { filePath: params.filePath },
          result: resultData,
          relatedFiles: [params.filePath]
        },
        sessionId: params.context.sessionId
      });
    } catch (error) {
      console.error('Failed to record append content activity:', getErrorMessage(error));
    }
  }
}
