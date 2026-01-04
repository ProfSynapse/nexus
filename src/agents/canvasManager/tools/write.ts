import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { WriteCanvasParams, WriteCanvasResult } from '../types';
import { CanvasOperations } from '../utils/CanvasOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

/**
 * Create a NEW canvas file (fails if already exists)
 */
export class WriteCanvasTool extends BaseTool<WriteCanvasParams, WriteCanvasResult> {
  private app: App;

  constructor(app: App) {
    super(
      'write',
      'Write Canvas',
      'Create a NEW canvas file. Fails if canvas already exists - use canvasManager.update to modify existing canvases.',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: WriteCanvasParams): Promise<WriteCanvasResult> {
    try {
      const { path, nodes, edges } = params;

      // Validate edges reference valid nodes
      const canvasData = { nodes: nodes || [], edges: edges || [] };
      const validation = CanvasOperations.validateEdges(canvasData);

      if (!validation.valid) {
        return this.prepareResult(false, undefined, `Invalid edge references: ${validation.errors.join('; ')}`);
      }

      await CanvasOperations.writeCanvas(this.app, path, canvasData);

      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error creating canvas: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new canvas file (with or without .canvas extension)'
        },
        nodes: {
          type: 'array',
          description: 'Initial nodes. Each node needs: type (text/file/link/group), x, y, width, height. IDs auto-generated if missing.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique ID (auto-generated if missing)' },
              type: { type: 'string', enum: ['text', 'file', 'link', 'group'], description: 'Node type' },
              x: { type: 'number', description: 'X position' },
              y: { type: 'number', description: 'Y position' },
              width: { type: 'number', description: 'Width in pixels' },
              height: { type: 'number', description: 'Height in pixels' },
              color: { type: 'string', description: 'Color: "1"-"6" (preset) or "#RRGGBB" (custom)' },
              text: { type: 'string', description: 'For text nodes: markdown content' },
              file: { type: 'string', description: 'For file nodes: path to vault file' },
              subpath: { type: 'string', description: 'For file nodes: heading/block reference (starts with #)' },
              url: { type: 'string', description: 'For link nodes: external URL' },
              label: { type: 'string', description: 'For group nodes: label text' }
            },
            required: ['type', 'x', 'y', 'width', 'height']
          }
        },
        edges: {
          type: 'array',
          description: 'Initial edges connecting nodes',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique ID (auto-generated if missing)' },
              fromNode: { type: 'string', description: 'Source node ID' },
              toNode: { type: 'string', description: 'Target node ID' },
              fromSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: 'Connection side on source' },
              toSide: { type: 'string', enum: ['top', 'right', 'bottom', 'left'], description: 'Connection side on target' },
              fromEnd: { type: 'string', enum: ['none', 'arrow'], description: 'Source endpoint style (default: none)' },
              toEnd: { type: 'string', enum: ['none', 'arrow'], description: 'Target endpoint style (default: arrow)' },
              color: { type: 'string', description: 'Edge color' },
              label: { type: 'string', description: 'Edge label' }
            },
            required: ['fromNode', 'toNode']
          }
        }
      },
      required: ['path']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): JSONSchema {
    return super.getResultSchema();
  }
}
