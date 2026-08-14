import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ListBaseParams, ListBaseResult } from '../types';
import { BaseFileOperations } from '../services/BaseFileOperations';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';

/**
 * List `.base` files in the vault with view/formula counts.
 */
export class ListBaseTool extends BaseTool<ListBaseParams, ListBaseResult> {
  private app: App;

  constructor(app: App) {
    super(
      'list',
      'List Bases',
      'List base files (.base) in the vault with view and formula counts',
      '1.0.0'
    );
    this.app = app;
  }

  async execute(params: ListBaseParams): Promise<ListBaseResult> {
    try {
      const { folder, recursive = true } = params;

      const files = BaseFileOperations.getBaseFiles(this.app, folder, recursive);
      files.sort((a, b) => b.stat.mtime - a.stat.mtime);

      const bases = await Promise.all(files.map(file => BaseFileOperations.summarize(this.app, file)));

      return this.prepareResult(true, {
        bases,
        total: bases.length
      });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error listing bases: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Folder to search (default: whole vault). Example: "projects/dashboards"'
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
        bases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to the base file' },
              name: { type: 'string', description: 'File name without extension' },
              modified: { type: 'number', description: 'Last modified timestamp' },
              views: { type: 'number', description: 'Number of views' },
              formulas: { type: 'number', description: 'Number of formulas' },
              hasGlobalFilters: { type: 'boolean', description: 'Whether the base has top-level filters' },
              error: { type: 'string', description: 'Present when the file could not be parsed as YAML' }
            }
          },
          description: 'Base files found'
        },
        total: { type: 'number', description: 'Total number of bases found' }
      },
      required: ['bases', 'total']
    };

    return baseSchema;
  }
}
