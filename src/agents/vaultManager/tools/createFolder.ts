import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CreateFolderParams, CreateFolderResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool to create a new folder
 */
export class CreateFolderTool extends BaseTool<CreateFolderParams, CreateFolderResult> {
  private app: App;

  /**
   * Create a new CreateFolderTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'createFolder',
      'Create Folder',
      'Create a new folder in the vault',
      '1.0.0'
    );
    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: CreateFolderParams): Promise<CreateFolderResult> {
    try {
      if (!params.path) {
        return this.prepareResult(false, undefined, 'Path is required');
      }

      if (typeof FileOperations?.createFolder === 'function') {
        await FileOperations.createFolder(this.app, params.path);
      } else {
        const existingFolder = this.app.vault.getAbstractFileByPath(params.path);
        if (!existingFolder) {
          await this.app.vault.createFolder(params.path);
        }
      }

      // Success - LLM already knows the path it passed
      return this.prepareResult(true);
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
