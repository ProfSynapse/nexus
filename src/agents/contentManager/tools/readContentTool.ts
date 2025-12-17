import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReadContentParams, ReadContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import {parseWorkspaceContext} from '../../../utils/contextUtils';
import { MemoryService } from '../../memoryManager/services/MemoryService';
import { getErrorMessage, createErrorMessage } from '../../../utils/errorUtils';
import { addRecommendations, Recommendation } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';
import { getNexusPlugin } from '../../../utils/pluginLocator';
import { NexusPluginWithServices } from '../../memoryManager/modes/utils/pluginTypes';

/**
 * Tool for reading content from a file
 */
export class ReadContentTool extends BaseTool<ReadContentParams, ReadContentResult> {
  private app: App;
  private memoryService: MemoryService | null = null;
  
  /**
   * Create a new ReadContentTool
   * @param app Obsidian app instance
   * @param memoryService Optional MemoryService for activity recording
   */
  constructor(
    app: App,
    memoryService?: MemoryService | null
  ) {
    super(
      'readContent',
      'Read Content',
      'Read content from a file in the vault',
      '1.0.0'
    );
    
    this.app = app;
    this.memoryService = memoryService || null;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the file content
   */
  async execute(params: ReadContentParams): Promise<ReadContentResult> {
    try {
      const { filePath, limit, offset, includeLineNumbers, workspaceContext } = params;
      
      let content: string;
      let startLine: number | undefined;
      let endLine: number | undefined;
      
      // If both limit and offset are specified, read specific lines
      if (typeof limit === 'number' && typeof offset === 'number') {
        startLine = offset;
        endLine = offset + limit - 1;
        const lines = await ContentOperations.readLines(
          this.app,
          filePath,
          startLine,
          endLine,
          includeLineNumbers
        );
        content = lines.join('\n');
      } else if (includeLineNumbers) {
        // Read entire file with line numbers
        content = await ContentOperations.readContentWithLineNumbers(this.app, filePath);
      } else {
        // Read entire file
        content = await ContentOperations.readContent(this.app, filePath);
      }
      
      const resultData = {
        content,
        filePath,
        lineNumbersIncluded: includeLineNumbers,
        startLine,
        endLine
      };
      
      // Record this activity in workspace memory if applicable
      await this.recordActivity(params, resultData);
      
      const result = this.prepareResult(true, resultData, undefined, params.context, parseWorkspaceContext(workspaceContext) || undefined);
      
      // Generate nudges based on content
      const nudges = this.generateReadContentNudges(resultData);
      const resultWithNudges = addRecommendations(result, nudges);
      
      return resultWithNudges;
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error reading content: ', error), params.context, parseWorkspaceContext(params.workspaceContext) || undefined);
    }
  }
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    // Create the tool-specific schema
    const toolSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to read'
        },
        limit: {
          type: 'number',
          description: 'Optional number of lines to read'
        },
        offset: {
          type: 'number',
          description: 'Optional line number to start reading from (1-based)'
        },
        includeLineNumbers: {
          type: 'boolean',
          description: 'Whether to include line numbers in the output',
          default: false
        }
      },
      required: ['filePath']
    };

    // Merge with common schema (workspace context)
    return this.getMergedSchema(toolSchema);
  }
  
  /**
   * Record content reading activity in workspace memory
   * @param params Params used for reading content
   * @param resultData Result data containing content information
   */
  private async recordActivity(
    params: ReadContentParams,
    resultData: {
      content: string;
      filePath: string;
      lineNumbersIncluded?: boolean;
      startLine?: number;
      endLine?: number;
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
    let contentSnippet = resultData.content.substring(0, 100);
    if (resultData.content.length > 100) {
      contentSnippet += '...';
    }
    
    const readDescription = params.limit && params.offset 
      ? `Read lines ${params.offset}-${params.offset + params.limit - 1}` 
      : 'Read full content';
    
    const content = `${readDescription} from ${params.filePath}\nSnippet: ${contentSnippet}`;
    
    try {
      // Record activity using MemoryService - we've already checked it's not null
      await this.memoryService!.recordActivityTrace({
        workspaceId: parsedContext.workspaceId,
        type: 'content_read',
        content: content,
        timestamp: Date.now(),
        metadata: {
          tool: 'ReadContentTool',
          params: {
            filePath: params.filePath,
            limit: params.limit,
            offset: params.offset,
            includeLineNumbers: params.includeLineNumbers
          },
          result: {
            contentLength: content.length,
            startLine: params.offset || 0,
            endLine: params.limit && params.offset !== undefined ? params.offset + params.limit : undefined
          },
          relatedFiles: [params.filePath]
        },
        sessionId: params.context.sessionId || ''
      });
      
    } catch (error) {
      // Log but don't fail the main operation
      console.error('Failed to record content reading activity with memory service:', getErrorMessage(error));
    }
  }

  getResultSchema(): Record<string, unknown> {
    // Use the base result schema from BaseTool, which includes common result properties
    const baseSchema = super.getResultSchema();

    // Add tool-specific data properties
    baseSchema.properties.data = {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Content of the file'
        },
        filePath: {
          type: 'string',
          description: 'Path to the file'
        },
        lineNumbersIncluded: {
          type: 'boolean',
          description: 'Whether line numbers are included in the content'
        },
        startLine: {
          type: 'number',
          description: 'Starting line if offset was specified'
        },
        endLine: {
          type: 'number',
          description: 'Ending line if limit was specified'
        }
      },
      required: ['content', 'filePath']
    };
    
    return baseSchema;
  }

  /**
   * Generate nudges based on content reading results
   */
  private generateReadContentNudges(resultData: { content: string; filePath: string }): Recommendation[] {
    const nudges: Recommendation[] = [];

    // Check for large content (>7,000 characters)
    const largeContentNudge = NudgeHelpers.checkLargeContent(resultData.content.length);
    if (largeContentNudge) {
      nudges.push(largeContentNudge);
    }

    return nudges;
  }
}
