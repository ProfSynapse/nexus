import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CopyParams, CopyResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Location: src/agents/storageManager/tools/copy.ts
 * Purpose: Duplicate a file to a new location
 * Relationships: Uses FileOperations for copy logic
 */

/**
 * Tool for copying/duplicating files
 */
export class CopyTool extends BaseTool<CopyParams, CopyResult> {
  private app: App;

  /**
   * Create a new CopyTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'copy',
      'Copy',
      'Duplicate a file',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of copying the file
   */
  async execute(params: CopyParams): Promise<CopyResult> {
    try {
      if (!params.path) {
        return this.prepareResult(false, undefined, 'Source path is required');
      }

      if (!params.newPath) {
        return this.prepareResult(false, undefined, 'Destination path is required');
      }

      await FileOperations.duplicateNote(
        this.app,
        params.path,
        params.newPath,
        params.overwrite || false,
        false // autoIncrement not supported in simplified API
      );

      // Success - LLM already knows the paths it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to copy file: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Source file path'
        },
        newPath: {
          type: 'string',
          description: 'Destination path for the copy'
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if destination exists (default: false)',
          default: false
        }
      },
      required: ['path', 'newPath']
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
