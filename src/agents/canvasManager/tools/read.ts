import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReadCanvasParams, ReadCanvasResult, CanvasData } from '../types';
import { CanvasOperations } from '../utils/CanvasOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

/**
 * Read the structure of a canvas file (nodes and edges)
 */
export class ReadCanvasTool extends BaseTool<ReadCanvasParams, ReadCanvasResult> {
  private app: App;

  constructor(app: App) {
    super(
      'read',
      'Read Canvas',
      'Read the structure of a canvas file (nodes and edges)',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: ReadCanvasParams): Promise<ReadCanvasResult> {
    try {
      const { path } = params;

      const canvasPath = CanvasOperations.normalizePath(path);
      const canvasData = await CanvasOperations.readCanvas(this.app, path);

      const nodes = canvasData.nodes || [];
      const edges = canvasData.edges || [];

      return this.prepareResult(true, {
        path: canvasPath,
        nodes,
        edges,
        nodeCount: nodes.length,
        edgeCount: edges.length
      });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error reading canvas: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the canvas file (with or without .canvas extension)'
        }
      },
      required: ['path']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
    const baseSchema = super.getResultSchema() as { properties: Record<string, unknown> };

    baseSchema.properties.data = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the canvas file' },
        nodes: { type: 'array', description: 'Array of canvas nodes' },
        edges: { type: 'array', description: 'Array of canvas edges' },
        nodeCount: { type: 'number', description: 'Number of nodes' },
        edgeCount: { type: 'number', description: 'Number of edges' }
      },
      required: ['path', 'nodes', 'edges', 'nodeCount', 'edgeCount']
    };

    return baseSchema;
  }
}
