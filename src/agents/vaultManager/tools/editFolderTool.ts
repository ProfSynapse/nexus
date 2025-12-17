import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CommonParameters, CommonResult } from '../../../types';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Arguments for editing a folder
 */
export interface EditFolderParams extends CommonParameters {
  /**
   * Path to the folder to edit
   */
  path: string;

  /**
   * New path for the folder
   */
  newPath: string;
}

/**
 * Result of editing a folder
 */
export interface EditFolderResult extends CommonResult {
  /**
   * Path to the folder
   */
  path?: string;

  /**
   * New path for the folder
   */
  newPath?: string;
}

/**
 * Tool for editing a folder
 */
export class EditFolderTool extends BaseTool<EditFolderParams, EditFolderResult> {
  private app: App;

  /**
   * Create a new EditFolderTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'editFolder',
      'Edit Folder',
      'Edit a folder in the vault',
      '1.0.0'
    );
    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: EditFolderParams): Promise<EditFolderResult> {
    try {
      if (!params.path) {
        return this.prepareResult(false, undefined, 'Path is required');
      }

      if (!params.newPath) {
        return this.prepareResult(false, undefined, 'New path is required');
      }

      // Rename the folder using the Obsidian Vault API
      try {
        await this.app.vault.adapter.rename(params.path, params.newPath);
      } catch (renameError) {
        return this.prepareResult(false, undefined, createErrorMessage('Failed to rename folder: ', renameError));
      }

      return this.prepareResult(true, { path: params.path, newPath: params.newPath });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to edit folder: ', error));
    }
  }

  /**
   * Get the parameter schema
   */
  getParameterSchema(): any {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the folder to edit'
        },
        newPath: {
          type: 'string',
          description: 'New path for the folder'
        }
      },
      required: ['path', 'newPath']
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the result schema
   */
  getResultSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation was successful'
        },
        error: {
          type: 'string',
          description: 'Error message if operation failed'
        },
        path: {
          type: 'string',
          description: 'Path to the folder'
        },
        newPath: {
          type: 'string',
          description: 'New path for the folder'
        }
      },
      required: ['success']
    };
  }
}
