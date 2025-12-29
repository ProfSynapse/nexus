import { App, TFile, TFolder } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { MoveParams, MoveResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { normalizePath } from '../../../utils/pathUtils';

/**
 * Location: src/agents/storageManager/tools/move.ts
 * Purpose: Move or rename files and folders (auto-detects type)
 * Relationships: Uses FileOperations for move logic
 */

/**
 * Tool for moving or renaming files and folders
 */
export class MoveTool extends BaseTool<MoveParams, MoveResult> {
  private app: App;

  /**
   * Create a new MoveTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'move',
      'Move',
      'Move or rename a file or folder',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of moving the file or folder
   */
  async execute(params: MoveParams): Promise<MoveResult> {
    const { path, newPath, overwrite } = params;

    try {
      // Normalize paths
      const normalizedPath = normalizePath(path);

      // Check if source exists and determine type
      const sourceItem = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!sourceItem) {
        return this.prepareResult(
          false,
          undefined,
          `File or folder not found: "${path}". Use list to see available items, or searchContent to find files by name.`
        );
      }

      // Auto-detect and move accordingly
      if (sourceItem instanceof TFile) {
        await FileOperations.moveNote(this.app, path, newPath, overwrite);
      } else if (sourceItem instanceof TFolder) {
        await FileOperations.moveFolder(this.app, path, newPath, overwrite);
      } else {
        return this.prepareResult(false, undefined, `Unknown item type at path: ${path}`);
      }

      // Success - LLM already knows the paths it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to move: ', error));
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
          description: 'Source path (file or folder)'
        },
        newPath: {
          type: 'string',
          description: 'Destination path'
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if destination exists (default: false)',
          default: false
        }
      },
      required: ['path', 'newPath'],
      description: 'Move or rename a file or folder (auto-detects type)'
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
