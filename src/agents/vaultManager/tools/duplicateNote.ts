import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DuplicateNoteParams, DuplicateNoteResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for duplicating a note
 */
export class DuplicateNoteTool extends BaseTool<DuplicateNoteParams, DuplicateNoteResult> {
  private app: App;

  /**
   * Create a new DuplicateNoteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'duplicateNote',
      'Duplicate Note',
      'Create a duplicate of an existing note',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of duplicating the note
   */
  async execute(params: DuplicateNoteParams): Promise<DuplicateNoteResult> {
    try {
      if (!params.sourcePath) {
        return this.prepareResult(false, undefined, 'Source path is required');
      }

      if (!params.targetPath) {
        return this.prepareResult(false, undefined, 'Target path is required');
      }

      await FileOperations.duplicateNote(
        this.app,
        params.sourcePath,
        params.targetPath,
        params.overwrite || false,
        params.autoIncrement || false
      );

      // Success - LLM already knows the paths it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to duplicate note: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    // Create the tool-specific schema
    const toolSchema = {
      type: 'object',
      properties: {
        sourcePath: {
          type: 'string',
          description: 'Path to the source note to duplicate (REQUIRED)'
        },
        targetPath: {
          type: 'string',
          description: 'Path for the duplicate note (REQUIRED)'
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite if target already exists',
          default: false
        },
        autoIncrement: {
          type: 'boolean',
          description: 'Whether to auto-increment filename if target exists (takes precedence over overwrite)',
          default: false
        }
      },
      required: ['sourcePath', 'targetPath']
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
