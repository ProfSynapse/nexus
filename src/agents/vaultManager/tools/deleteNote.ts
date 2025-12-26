import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { DeleteNoteParams, DeleteNoteResult } from '../types';
import { FileOperations } from '../utils/FileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for deleting a note
 */
export class DeleteNoteTool extends BaseTool<DeleteNoteParams, DeleteNoteResult> {
  private app: App;

  /**
   * Create a new DeleteNoteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'deleteNote',
      'Delete Note',
      'Delete a note from the vault',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the result of deleting the note
   */
  async execute(params: DeleteNoteParams): Promise<DeleteNoteResult> {
    const { path } = params;

    try {
      await FileOperations.deleteNote(this.app, path);

      // Success - LLM already knows the path it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to delete note: ', error));
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
          description: 'Path to the note to delete'
        }
      },
      required: ['path'],
      description: 'Delete a note from the vault'
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
