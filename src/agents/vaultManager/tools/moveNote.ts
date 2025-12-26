import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { MoveNoteParams, MoveNoteResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for moving a note
 */
export class MoveNoteTool extends BaseTool<MoveNoteParams, MoveNoteResult> {
  private app: App;

  /**
   * Create a new MoveNoteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'moveNote',
      'Move Note',
      'Move a note to a new location',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of moving the note
   */
  async execute(params: MoveNoteParams): Promise<MoveNoteResult> {
    const { path, newPath, overwrite } = params;

    try {
      await FileOperations.moveNote(this.app, path, newPath, overwrite);

      // Success - LLM already knows the paths it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to move note: ', error));
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
          description: 'Path to the note'
        },
        newPath: {
          type: 'string',
          description: 'New path for the note'
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite if a note already exists at the new path'
        }
      },
      required: ['path', 'newPath'],
      description: 'Move a note to a new location'
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
