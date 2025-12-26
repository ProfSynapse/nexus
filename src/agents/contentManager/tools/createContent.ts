import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { CreateContentParams, CreateContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for creating a new file with content
 * Follows Single Responsibility Principle - only handles content creation
 * File change detection is handled automatically by FileEventManager
 */
export class CreateContentTool extends BaseTool<CreateContentParams, CreateContentResult> {
  private app: App;

  /**
   * Create a new CreateContentTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'createContent',
      'Create Content',
      'Create a new file with content in the vault',
      '1.0.0'
    );

    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the creation result
   */
  async execute(params: CreateContentParams): Promise<CreateContentResult> {
    try {
      const { content, workspaceContext } = params;
      let { filePath } = params;

      // Normalize empty/root paths - generate a filename if only directory is specified
      if (!filePath || filePath === '/' || filePath === '.') {
        // Generate a unique filename in root
        const timestamp = Date.now();
        filePath = `untitled-${timestamp}.md`;
      } else if (filePath.endsWith('/') || filePath.endsWith('.')) {
        // Path is a directory - generate filename in that directory
        const dir = filePath.endsWith('.') ? '' : filePath.slice(0, -1);
        const timestamp = Date.now();
        filePath = dir ? `${dir}/untitled-${timestamp}.md` : `untitled-${timestamp}.md`;
      }

      if (content === undefined || content === null) {
        return this.prepareResult(false, undefined, 'Content is required');
      }

      // Create file
      await ContentOperations.createContent(this.app, filePath, content);

      // Success - LLM already knows the filePath it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error creating file: ', error));
    }
  }
  
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): Record<string, unknown> {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to create (REQUIRED)'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file (REQUIRED)'
        }
      },
      required: ['filePath', 'content']
    };
    
    return this.getMergedSchema(customSchema);
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
