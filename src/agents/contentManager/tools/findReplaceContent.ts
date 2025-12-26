import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { FindReplaceContentParams, FindReplaceContentResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { createErrorMessage } from '../../../utils/errorUtils';

/**
 * Tool for find and replace operations in a file
 */
export class FindReplaceContentTool extends BaseTool<FindReplaceContentParams, FindReplaceContentResult> {
  private app: App;

  /**
   * Create a new FindReplaceContentTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'findReplaceContent',
      'Find and Replace Content',
      'Find and replace text in a file in the vault',
      '1.0.0'
    );

    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the find and replace result
   */
  async execute(params: FindReplaceContentParams): Promise<FindReplaceContentResult> {
    try {
      const {
        filePath,
        findText,
        replaceText,
        replaceAll = false,
        caseSensitive = true,
        wholeWord = false
      } = params;

      await ContentOperations.findReplaceContent(
        this.app,
        filePath,
        findText,
        replaceText,
        replaceAll,
        caseSensitive,
        wholeWord
      );

      // Success - LLM already knows filePath and text it passed
      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error in find and replace: ', error));
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
        findText: {
          type: 'string',
          description: 'Text to find'
        },
        replaceText: {
          type: 'string',
          description: 'Text to replace with'
        },
        replaceAll: {
          type: 'boolean',
          description: 'Whether to replace all occurrences or just the first one',
          default: false
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Whether the search should be case sensitive',
          default: true
        },
        wholeWord: {
          type: 'boolean',
          description: 'Whether to use whole word matching',
          default: false
        }
      },
      required: ['filePath', 'findText', 'replaceText']
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
