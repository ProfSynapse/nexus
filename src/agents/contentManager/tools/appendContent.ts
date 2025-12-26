import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { AppendContentParams, AppendContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for appending content to a file
 */
export class AppendContentTool extends BaseTool<AppendContentParams, AppendContentResult> {
  private app: App;

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
      const { filePath, content } = params;

      await ContentOperations.appendContent(this.app, filePath, content);

      // Success - LLM already knows filePath and content it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error appending content: ', error));
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
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
