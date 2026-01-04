import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { UpdateCanvasParams, UpdateCanvasResult } from '../types';
import { CanvasOperations } from '../utils/CanvasOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

/**
 * Update an EXISTING canvas file (fails if doesn't exist)
 */
export class UpdateCanvasTool extends BaseTool<UpdateCanvasParams, UpdateCanvasResult> {
  private app: App;

  constructor(app: App) {
    super(
      'update',
      'Update Canvas',
      'Modify an EXISTING canvas file. Replaces nodes and/or edges arrays. Fails if canvas does not exist - use canvasManager.write to create new canvases.',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: UpdateCanvasParams): Promise<UpdateCanvasResult> {
    try {
      const { path, nodes, edges } = params;

      // Read existing canvas to merge with updates
      const existingData = await CanvasOperations.readCanvas(this.app, path);

      // Build updated data - only replace what was provided
      const updatedData = {
        ...existingData,
        nodes: nodes !== undefined ? nodes : existingData.nodes,
        edges: edges !== undefined ? edges : existingData.edges
      };

      // Validate edges reference valid nodes
      const validation = CanvasOperations.validateEdges(updatedData);

      if (!validation.valid) {
        return this.prepareResult(false, undefined, `Invalid edge references: ${validation.errors.join('; ')}`);
      }

      await CanvasOperations.updateCanvas(this.app, path, updatedData);

      return this.prepareResult(true);
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error updating canvas: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the existing canvas file (with or without .canvas extension)'
        },
        nodes: {
          type: 'array',
          description: 'Full nodes array (replaces existing nodes). Omit to keep existing nodes.',
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
          description: 'Full edges array (replaces existing edges). Omit to keep existing edges.',
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
