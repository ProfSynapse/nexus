import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReplaceContentParams, ReplaceContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for replacing content in a file
 */
export class ReplaceContentTool extends BaseTool<ReplaceContentParams, ReplaceContentResult> {
  private app: App;

  /**
   * Create a new ReplaceContentTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'replaceContent',
      'Replace Content',
      'Replace content in a file in the vault',
      '1.0.0'
    );

    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the replace result
   */
  async execute(params: ReplaceContentParams): Promise<ReplaceContentResult> {
    try {
      const { filePath, oldContent, newContent, similarityThreshold = 0.95 } = params;

      await ContentOperations.replaceContent(
        this.app,
        filePath,
        oldContent,
        newContent,
        similarityThreshold
      );

      // Success - LLM already knows filePath and content it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error replacing content: ', error));
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
          description: 'Path to the file to modify'
        },
        oldContent: {
          type: 'string',
          description: 'Content to replace'
        },
        newContent: {
          type: 'string',
          description: 'Content to replace with'
        },
        similarityThreshold: {
          type: 'number',
          description: 'Threshold for fuzzy matching (0.0 to 1.0, where 1.0 is exact match)',
          default: 0.95,
          minimum: 0.0,
          maximum: 1.0
        }
      },
      required: ['filePath', 'oldContent', 'newContent']
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
        success: { type: 'boolean', description: 'Whether the operation succeeded' },
        error: { type: 'string', description: 'Error message if failed (includes recovery guidance)' }
      },
      required: ['success']
    };
  }
}
