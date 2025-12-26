import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DeleteContentParams, DeleteContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for deleting content from a file
 * Follows Single Responsibility Principle - only handles content deletion
 * File change detection are handled automatically by FileEventManager
 */
export class DeleteContentTool extends BaseTool<DeleteContentParams, DeleteContentResult> {
  private app: App;

  /**
   * Create a new DeleteContentTool
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
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the delete result
   */
  async execute(params: DeleteContentParams): Promise<DeleteContentResult> {
    try {
      const { filePath, content, similarityThreshold = 0.95 } = params;

      await ContentOperations.deleteContent(this.app, filePath, content, similarityThreshold);

      // Success - LLM already knows what it deleted
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error deleting content: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the file to modify' },
        content: { type: 'string', description: 'Content to delete' },
        similarityThreshold: { type: 'number', description: 'Fuzzy match threshold (0.0-1.0)', default: 0.95 }
      },
      required: ['filePath', 'content']
    };
    return this.getMergedSchema(customSchema);
  }

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
