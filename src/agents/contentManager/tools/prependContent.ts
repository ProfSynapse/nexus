import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { PrependContentParams, PrependContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for prepending content to a file
 */
export class PrependContentTool extends BaseTool<PrependContentParams, PrependContentResult> {
  private app: App;

  /**
   * Create a new PrependContentTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'prependContent',
      'Prepend Content',
      'Prepend content to a file in the vault',
      '1.0.0'
    );

    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the prepend result
   */
  async execute(params: PrependContentParams): Promise<PrependContentResult> {
    try {
      const { filePath, content } = params;

      await ContentOperations.prependContent(this.app, filePath, content);

      // Success - LLM already knows filePath and content it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error prepending content: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   */
  getParameterSchema(): Record<string, unknown> {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to prepend to'
        },
        content: {
          type: 'string',
          description: 'Content to prepend to the file'
        }
      },
      required: ['filePath', 'content']
    };

    return this.getMergedSchema(customSchema);
  }

  /**
   * Get the JSON schema for the tool's result
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}
