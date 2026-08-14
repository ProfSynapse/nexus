import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReadBaseParams, ReadBaseResult, BasesConfigFile } from '../types';
import { BaseFileOperations } from '../services/BaseFileOperations';
import { BaseValidator } from '../services/BaseValidator';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

/**
 * Read a `.base` file and return its parsed config.
 *
 * A file that does not parse as YAML is an error, not an empty config: silently
 * returning `{}` would invite an `update` that overwrites the user's broken —
 * but recoverable — file with nothing.
 */
export class ReadBaseTool extends BaseTool<ReadBaseParams, ReadBaseResult> {
  private app: App;

  constructor(app: App) {
    super(
      'read',
      'Read Base',
      'Read a base file (.base) and return its parsed config: filters, formulas, properties, summaries and views',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Reading base', 'Read base', 'Failed to read base'), params, tense, {
      keys: ['path'],
      fallback: 'base'
    });
  }

  async execute(params: ReadBaseParams): Promise<ReadBaseResult> {
    try {
      const { path } = params;
      if (typeof path !== 'string' || path.trim() === '') {
        return this.prepareResult(false, undefined, 'path is required');
      }

      const source = await BaseFileOperations.readSource(this.app, path);
      const { config, result } = BaseValidator.parseAndValidate(source);

      // Only a parse failure blocks the read — a structurally invalid but
      // parseable base is exactly what a caller needs to see in order to fix it,
      // so its config comes back with the errors rather than instead of them.
      if (!config) {
        const parseError = result.errors.find(issue => issue.code === 'yaml-parse');
        return this.prepareResult(false, undefined, parseError?.message ?? 'Base file is not valid YAML');
      }

      const parsed: BasesConfigFile = config ?? {};
      const views = Array.isArray(parsed.views) ? parsed.views : [];

      return this.prepareResult(true, {
        path: BaseFileOperations.normalizePath(path),
        config: parsed,
        viewCount: views.length,
        formulaCount: parsed.formulas ? Object.keys(parsed.formulas).length : 0,
        viewNames: views.map(view => (typeof view?.name === 'string' ? view.name : '')).filter(Boolean),
        // Surfaced on a successful read so a caller who is about to edit the
        // file learns what is already wrong with it, rather than discovering it
        // when their own update is rejected.
        ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
      });
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error reading base: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the base file (with or without .base extension)'
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
        path: { type: 'string', description: 'Path to the base file' },
        config: { type: 'object', description: 'Parsed base config (filters, formulas, properties, summaries, views)' },
        viewCount: { type: 'number', description: 'Number of views' },
        formulaCount: { type: 'number', description: 'Number of formulas' },
        viewNames: { type: 'array', items: { type: 'string' }, description: 'Names of the views, in file order' },
        errors: { type: 'array', items: { type: 'object' }, description: 'Structural problems in the file as it stands, each with path, code and message' },
        warnings: { type: 'array', items: { type: 'object' }, description: 'Non-blocking findings, each with path, code and message' }
      },
      required: ['path', 'config', 'viewCount', 'formulaCount', 'viewNames']
    };

    return baseSchema;
  }
}
