import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReplaceByLineParams, ReplaceByLineResult } from '../types';
import { ContentOperations } from '../utils/ContentOperations';
import { parseWorkspaceContext } from '../../../utils/contextUtils';

/**
 * Tool for replacing content by line number in a file
 */
export class ReplaceByLineTool extends BaseTool<ReplaceByLineParams, ReplaceByLineResult> {
  private app: App;
  
  /**
   * Create a new ReplaceByLineTool
   * @param app Obsidian app instance
   */
  constructor(app: App) {
    super(
      'replaceByLine',
      'Replace By Line',
      'Replace content by line number in a file in the vault',
      '1.0.0'
    );
    
    this.app = app;
  }
  
  /**
   * Execute the tool
   * @param params Tool parameters
   * @returns Promise that resolves with the replace result
   */
  async execute(params: ReplaceByLineParams): Promise<ReplaceByLineResult> {
    try {
      const { filePath, startLine, endLine, newContent, workspaceContext } = params;
      
      const linesReplaced = await ContentOperations.replaceByLine(
        this.app,
        filePath,
        startLine,
        endLine,
        newContent
      );
      
      // File change detection are handled automatically by FileEventManager
      
      const response = this.prepareResult(true, {
          filePath,
          linesReplaced
        }, undefined, params.context, parseWorkspaceContext(workspaceContext) || undefined);
      
      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.prepareResult(false, undefined, errorMessage, params.context, parseWorkspaceContext(params.workspaceContext) || undefined);
    }
  }
  
  
  /**
   * Get the JSON schema for the tool's parameters
   * @returns JSON schema object
   */
  getParameterSchema(): any {
    const customSchema = {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file to modify'
        },
        startLine: {
          type: 'number',
          description: 'Start line number (1-based)'
        },
        endLine: {
          type: 'number',
          description: 'End line number (1-based, inclusive)'
        },
        newContent: {
          type: 'string',
          description: 'Content to replace with'
        }
      },
      required: ['filePath', 'startLine', 'endLine', 'newContent']
    };
    
    return this.getMergedSchema(customSchema);
  }
  
  /**
   * Get the JSON schema for the tool's result
   * @returns JSON schema object
   */
  getResultSchema(): any {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if success is false'
        },
        data: {
          type: 'object',
          properties: {
            filePath: {
              type: 'string',
              description: 'Path to the file'
            },
            linesReplaced: {
              type: 'number',
              description: 'Number of lines replaced'
            }
          },
          required: ['filePath', 'linesReplaced']
        },
        workspaceContext: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: 'ID of the workspace'
            },
            workspacePath: {
              type: 'array',
              items: {
                type: 'string'
              },
              description: 'Path of the workspace'
            },
            activeWorkspace: {
              type: 'boolean',
              description: 'Whether this is the active workspace'
            }
          }
        },
      },
      required: ['success']
    };
  }
}