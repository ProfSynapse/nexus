import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { WriteBaseParams, BaseWriteResult } from '../types';
import { BaseFileOperations } from '../services/BaseFileOperations';
import { BaseValidator } from '../services/BaseValidator';
import {
  collectSections,
  formatValidationFailure,
  DEFAULT_NEW_BASE,
  SECTION_KEYS
} from '../services/baseConfigInput';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';
import { baseSectionSchemas } from './schemaFragments';

/**
 * Create a NEW `.base` file. Validates first: nothing reaches disk unless the
 * config passes, and the rejection names every problem with its path and code
 * so they can be fixed in one pass.
 */
export class WriteBaseTool extends BaseTool<WriteBaseParams, BaseWriteResult> {
  private app: App;

  constructor(app: App) {
    super(
      'write',
      'Write Base',
      'Create a NEW base file (.base). Fails if the base already exists - use baseManager.update to modify an existing one. The config is validated before anything is written; a rejection lists every problem with its path and code.',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Creating base', 'Created base', 'Failed to create base'), params, tense, {
      keys: ['path'],
      fallback: 'base'
    });
  }

  async execute(params: WriteBaseParams): Promise<BaseWriteResult> {
    try {
      const { path } = params;
      if (typeof path !== 'string' || path.trim() === '') {
        return this.prepareResult(false, undefined, 'path is required');
      }

      let sections: Record<string, unknown>;
      try {
        sections = collectSections(params);
      } catch (error) {
        return this.prepareResult(false, undefined, error instanceof Error ? error.message : String(error));
      }

      const config = Object.keys(sections).length > 0 ? sections : { ...DEFAULT_NEW_BASE };

      const validation = BaseValidator.validate(config, {
        knownProperties: BaseFileOperations.collectFrontmatterProperties(this.app)
      });

      if (!validation.valid) {
        return {
          ...this.prepareResult(false, undefined, formatValidationFailure(validation)),
          errors: validation.errors,
          warnings: validation.warnings
        };
      }

      const writtenPath = await BaseFileOperations.writeBase(this.app, path, config);

      return {
        ...this.prepareResult(true, {
          path: writtenPath,
          sections: SECTION_KEYS.filter(key => key in config)
        }),
        ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {})
      };
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error creating base: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path for the new base file (with or without .base extension)'
        },
        config: {
          type: 'string',
          description: 'Whole base config as YAML (preferred) or JSON. Top-level keys: filters, formulas, properties, summaries, views. Individual section arguments below override what this contains. Defaults to a single empty table view when nothing is supplied.'
        },
        ...baseSectionSchemas()
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
        path: { type: 'string', description: 'Path of the created base file' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Top-level sections written' }
      },
      required: ['path', 'sections']
    };
    baseSchema.properties.warnings = {
      type: 'array',
      description: 'Non-blocking validation warnings, each with path, code and message',
      items: { type: 'object' }
    };
    baseSchema.properties.errors = {
      type: 'array',
      description: 'Blocking validation errors when success is false (also rendered into error)',
      items: { type: 'object' }
    };

    return baseSchema;
  }
}
