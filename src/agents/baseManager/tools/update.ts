import { App } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { UpdateBaseParams, BaseWriteResult } from '../types';
import { BaseFileOperations } from '../services/BaseFileOperations';
import { BaseValidator } from '../services/BaseValidator';
import { collectSections, formatValidationFailure } from '../services/baseConfigInput';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';
import { baseSectionSchemas } from './schemaFragments';

/**
 * Modify an EXISTING `.base` file.
 *
 * Merge semantics: only the top-level sections supplied are replaced;
 * everything else in the file is kept. This deliberately differs from
 * `canvas update`, which replaces whole arrays — a `.base` is a small
 * hand-tuned document a user also edits directly, so a model rewriting one view
 * must not be able to drop the user's other views (plan §4).
 *
 * The merged result — not the fragment — is what gets validated, so an edit
 * cannot leave the file referencing a formula the merge removed.
 */
export class UpdateBaseTool extends BaseTool<UpdateBaseParams, BaseWriteResult> {
  private app: App;

  constructor(app: App) {
    super(
      'update',
      'Update Base',
      'Modify an EXISTING base file (.base). Replaces ONLY the top-level sections you supply (filters, formulas, properties, summaries, views) and keeps the rest - unlike canvasManager.update, which replaces whole arrays. Fails if the base does not exist - use baseManager.write to create one. The merged config is validated before anything is written.',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Updating base', 'Updated base', 'Failed to update base'), params, tense, {
      keys: ['path'],
      fallback: 'base'
    });
  }

  async execute(params: UpdateBaseParams): Promise<BaseWriteResult> {
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

      if (Object.keys(sections).length === 0) {
        return this.prepareResult(
          false,
          undefined,
          'Nothing to update: supply at least one of config, filters, formulas, properties, summaries or views'
        );
      }

      // Existing content is read (and must parse) before the merge, so an
      // update never silently discards a section it cannot see.
      const source = await BaseFileOperations.readSource(this.app, path);
      const existing = BaseValidator.parseAndValidate(source);
      const parseFailure = existing.result.errors.find(issue => issue.code === 'yaml-parse');
      if (parseFailure) {
        return this.prepareResult(
          false,
          undefined,
          `${parseFailure.message}. Fix the file, or use baseManager.write to a new path.`
        );
      }

      const merged = { ...(existing.config ?? {}), ...sections } as Record<string, unknown>;

      const validation = BaseValidator.validate(merged, {
        knownProperties: BaseFileOperations.collectFrontmatterProperties(this.app)
      });

      if (!validation.valid) {
        return {
          ...this.prepareResult(false, undefined, formatValidationFailure(validation)),
          errors: validation.errors,
          warnings: validation.warnings
        };
      }

      const writtenPath = await BaseFileOperations.updateBase(this.app, path, merged);

      return {
        ...this.prepareResult(true, {
          path: writtenPath,
          sections: Object.keys(sections)
        }),
        ...(validation.warnings.length > 0 ? { warnings: validation.warnings } : {})
      };
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error updating base: ', error));
    }
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the existing base file (with or without .base extension)'
        },
        config: {
          type: 'string',
          description: 'Sections to replace, as YAML (preferred) or JSON. Only the top-level keys present here are replaced; the rest of the file is kept.'
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
        path: { type: 'string', description: 'Path of the updated base file' },
        sections: { type: 'array', items: { type: 'string' }, description: 'Top-level sections replaced by this call' }
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
