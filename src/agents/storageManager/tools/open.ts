import { App, TFile, WorkspaceLeaf } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { OpenParams, OpenResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { smartNormalizePath } from '../../../utils/pathUtils';

/**
 * Location: src/agents/storageManager/tools/open.ts
 * Purpose: Open a file in the Obsidian editor
 * Relationships: Uses Obsidian workspace API for file opening
 */

/**
 * Tool to open a file in the vault
 */
export class OpenTool extends BaseTool<OpenParams, OpenResult> {
  private app: App;

  /**
   * Create a new OpenTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'open',
      'Open',
      'Open a file in the editor',
      '1.0.0'
    );
    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise resolving to the result
   */
  async execute(params: OpenParams): Promise<OpenResult> {
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
        return this.prepareResult(
          false,
          undefined,
          `File not found: "${normalizedPath}". Use list to see available files, or searchContent to find files by name.`
        );
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
        });

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Failed to open file: ', error));
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
          description: 'Path to the file to open'
        },
        mode: {
          type: 'string',
          enum: ['tab', 'split', 'window', 'current'],
          description: 'Where to open the file (tab, split, window, or current)',
          default: 'current'
        },
        focus: {
          type: 'boolean',
          description: 'Whether to focus the opened file',
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
