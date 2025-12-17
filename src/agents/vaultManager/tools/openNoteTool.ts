import { App, TFile, WorkspaceLeaf } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { OpenNoteParams, OpenNoteResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { smartNormalizePath } from '../../../utils/pathUtils';
import { parseWorkspaceContext } from '../../../utils/contextUtils';

/**
 * Tool to open a note in the vault
 */
export class OpenNoteTool extends BaseTool<OpenNoteParams, OpenNoteResult> {
  private app: App;

  /**
   * Create a new OpenNoteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'openNote',
      'Open Note',
      'Open a note in the vault',
      '1.0.0'
    );
    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: OpenNoteParams): Promise<OpenNoteResult> {
    try {
      // Validate parameters
      if (!params.path) {
        return this.prepareResult(false, undefined, 'Path is required');
      }

      // Apply smart normalization for note operations (includes .md extension handling)
      const normalizedPath = smartNormalizePath(params.path, false, 'NOTE');

      // Get the file
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (!file || !(file instanceof TFile)) {
        return this.prepareResult(false, undefined, `Note not found at path: ${normalizedPath}`);
      }

      // Determine how to open the file
      const mode = params.mode || 'current';
      let leaf: WorkspaceLeaf;

      switch (mode) {
        case 'tab':
          leaf = this.app.workspace.getLeaf('tab');
          break;
        case 'split':
          leaf = this.app.workspace.getLeaf('split');
          break;
        case 'window':
          leaf = this.app.workspace.getLeaf('window');
          break;
        case 'current':
        default:
          leaf = this.app.workspace.getLeaf(false);
          break;
      }

      // Open the file
      await leaf.openFile(file);

      // Focus if requested
      if (params.focus !== false) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
      }

      return this.prepareResult(true, {
          path: file.path,
          opened: true,
          mode: mode
        }, undefined, params.context, parseWorkspaceContext(params.workspaceContext) || undefined);

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to open note: ', error));
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
          description: 'Path to the note to open'
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the note (tab, split, window, or current)',
          default: 'current'
        },
        focus: {
          type: 'boolean',
          description: 'Whether to focus the opened note',
          default: true
        }
      },
      required: ['path']
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the result schema
   */
  getResultSchema(): any {
    const baseSchema = super.getResultSchema();

    // Extend the base schema to include our specific data
    baseSchema.properties.data = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        opened: { type: 'boolean' },
        mode: { type: 'string' }
      }
    };

    return baseSchema;
  }
}
