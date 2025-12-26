import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DeleteFolderParams, DeleteFolderResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for deleting a folder
 */
export class DeleteFolderTool extends BaseTool<DeleteFolderParams, DeleteFolderResult> {
  private app: App;

  /**
   * Create a new DeleteFolderTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'deleteFolder',
      'Delete Folder',
      'Delete a folder',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of deleting the folder
   */
  async execute(params: DeleteFolderParams): Promise<DeleteFolderResult> {
    const { path, recursive } = params;

    try {
      await FileOperations.deleteFolder(this.app, path, recursive);

      // Success - LLM already knows the path it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to delete folder: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the folder'
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to delete recursively'
        }
      },
      required: ['path'],
      description: 'Delete a folder'
    };

    // Merge with common schema (sessionId and context)
    return this.getMergedSchema(toolSchema);
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
