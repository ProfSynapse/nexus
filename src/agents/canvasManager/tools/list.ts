import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ListCanvasParams, ListCanvasResult } from '../types';
import { CanvasOperations } from '../utils/CanvasOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

/**
 * List canvas files in the vault
 */
export class ListCanvasTool extends BaseTool<ListCanvasParams, ListCanvasResult> {
  private app: App;

  constructor(app: App) {
    super(
      'list',
      'List Canvases',
      'List canvas files in the vault with node/edge counts',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: ListCanvasParams): Promise<ListCanvasResult> {
    try {
      const { folder, recursive = true } = params;

      const canvasFiles = CanvasOperations.getCanvasFiles(this.app, folder, recursive);

      // Sort by modified date (newest first)
      canvasFiles.sort((a, b) => b.stat.mtime - a.stat.mtime);

      // Get summary for each canvas
      const canvases = await Promise.all(
        canvasFiles.map(async (file) => {
          const summary = await CanvasOperations.getCanvasSummary(this.app, file);
          return {
            path: file.path,
            name: file.basename,
            modified: file.stat.mtime,
            nodeCount: summary.nodeCount,
            edgeCount: summary.edgeCount
          };
        })
      );

      return this.prepareResult(true, {
        canvases,
        total: canvases.length
      });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error listing canvases: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Folder to search (default: vault root). Example: "projects/diagrams"'
        },
        recursive: {
          type: 'boolean',
          description: 'Search subfolders (default: true)',
          default: true
        }
      },
      required: []
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
    const baseSchema = super.getResultSchema() as { properties: Record<string, unknown> };

    baseSchema.properties.data = {
      type: 'object',
      properties: {
        canvases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to canvas file' },
              name: { type: 'string', description: 'Canvas filename (without extension)' },
              modified: { type: 'number', description: 'Last modified timestamp' },
              nodeCount: { type: 'number', description: 'Number of nodes' },
              edgeCount: { type: 'number', description: 'Number of edges' }
            }
          },
          description: 'List of canvas files'
        },
        total: {
          type: 'number',
          description: 'Total number of canvases found'
        }
      },
      required: ['canvases', 'total']
    };

    return baseSchema;
  }
}
