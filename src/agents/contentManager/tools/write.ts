import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { WriteParams, WriteResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Location: src/agents/contentManager/tools/write.ts
 *
 * Simplified write tool for ContentManager.
 * Creates a new file or overwrites an existing file.
 *
 * Key Design:
 * - Default behavior is safe (no overwrite)
 * - Explicit overwrite flag required to replace existing files
 * - Clear error messages guide recovery
 *
 * Relationships:
 * - Uses ContentOperations utility for file operations
 * - Part of CRUA architecture (Create operation)
 * - Follows write tool response stripping principle (returns { success: true } only)
 */
export class WriteTool extends BaseTool<WriteParams, WriteResult> {
  private app: App;

  /**
   * Create a new WriteTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'write',
      'Write',
      'Create a new file or overwrite existing file',
      '1.0.0'
    );

    this.app = app;
  }

  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the creation result
   */
  async execute(params: WriteParams): Promise<WriteResult> {
    try {
      const { content, overwrite = false } = params;
      let { path } = params;

      // Normalize empty/root paths - generate a filename if only directory is specified
      if (!path || path === '/' || path === '.') {
        const timestamp = Date.now();
        path = `untitled-${timestamp}.md`;
      } else if (path.endsWith('/') || path.endsWith('.')) {
        const dir = path.endsWith('.') ? '' : path.slice(0, -1);
        const timestamp = Date.now();
        path = dir ? `${dir}/untitled-${timestamp}.md` : `untitled-${timestamp}.md`;
      }

      if (content === undefined || content === null) {
        return this.prepareResult(false, undefined, 'Content is required');
      }

      // Normalize path (remove leading slash)
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (existingFile) {
        if (!overwrite) {
          return this.prepareResult(false, undefined,
            `File already exists: "${path}". Use read to view it, update to modify it, or write with overwrite: true to replace it completely.`
          );
        }

        // Overwrite existing file
        if (!(existingFile instanceof TFile)) {
          return this.prepareResult(false, undefined,
            `Path is a folder, not a file: "${path}". Use listDirectory to see its contents.`
          );
        }

        await this.app.vault.modify(existingFile, content);
      } else {
        // Create new file
        await ContentOperations.createContent(this.app, path, content);
      }

      // Success - LLM already knows the path and content it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error writing file: ', error));
    }
  }

  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to create or overwrite'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite if file exists (default: false)',
          default: false
        }
      },
      required: ['path', 'content']
    };

    return this.getMergedSchema(toolSchema);
  }

  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
