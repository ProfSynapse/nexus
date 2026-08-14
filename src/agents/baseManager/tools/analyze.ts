import { App, Plugin } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { AnalyzeBaseParams, AnalyzeBaseResult } from '../types';
import { BaseFileOperations } from '../services/BaseFileOperations';
import { BaseValidator } from '../services/BaseValidator';
import { BaseAnalyzeError, BaseQueryRunner } from '../services/BaseQueryRunner';
import type { HarvestedResult } from '../services/baseResultHarvester';
import { createErrorMessage } from '../../../utils/errorUtils';
import { JSONSchema } from '../../../types/schema/JSONSchemaTypes';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

/**
 * Default row bound. A base over a real vault is thousands of rows and this
 * output lands in a model's context, so the answer is bounded by default and
 * says what it left out rather than returning everything.
 */
export const DEFAULT_ANALYZE_LIMIT = 25;

/** Hard ceiling, so a caller cannot ask for a context-destroying answer by accident. */
export const MAX_ANALYZE_LIMIT = 1000;

/**
 * Execute a `.base` and return the rows a user would see.
 *
 * The mechanism (a headless Bases view, an off-screen render, a scratch file)
 * lives in `BaseQueryRunner`; this tool owns the argument contract, the bounding
 * and the failure contract.
 *
 * ## Bounding is not optional
 *
 * `limit` defaults to {@link DEFAULT_ANALYZE_LIMIT} and the result always
 * reports `rowCount` (matched) against `returned` (serialised) with an explicit
 * `truncated` flag. Rows are never silently dropped: a caller that wants more
 * asks for more.
 *
 * ## Failure contract
 *
 * On `success: false` the batch formatter keeps only `agent`, `tool`, `success`
 * and `error` — every structured sibling field is dropped before an MCP caller
 * sees it (the same constraint `write`/`update` hit in Phase 2). So every
 * failure here puts the whole diagnosis in the message, including what Obsidian
 * painted into the render host.
 *
 * ## Zero rows is genuinely ambiguous, and says so
 *
 * Bases evaluates a filter it cannot understand as "no rows" and reports the
 * failure NOWHERE: not as an exception, not in the query result, not in the
 * console, and not in the DOM. Measured on Obsidian 1.13.7, a view whose filter
 * calls an undefined function and a view whose filter simply matches nothing
 * render byte-identical HTML (4975 bytes each, modulo the view name) and log
 * nothing. Obsidian's own `base:query` CLI returns `[]` for both.
 *
 * The design plan expected the rendered container text to carry the failure. It
 * does not — the only text there is the Bases toolbar chrome
 * ("…resultsSort0Filter1PropertiesSearchNewShowing 0"), which is present on
 * every run, healthy or not. So `analyze` does the one honest thing available:
 * it returns the empty result and warns that empty has two meanings. Turning
 * zero rows into a failure was tried first and is worse — it makes every
 * legitimately empty base look broken.
 */
export class AnalyzeBaseTool extends BaseTool<AnalyzeBaseParams, AnalyzeBaseResult> {
  private app: App;
  private plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    super(
      'analyze',
      'Analyze Base',
      'Execute a base file (.base) and return the rows it produces - filters applied, formulas evaluated, exactly what the base shows in Obsidian',
      '1.0.0'
    );
    this.app = app;
    this.plugin = plugin;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Running base', 'Ran base', 'Failed to run base'), params, tense, {
      keys: ['path'],
      fallback: 'base'
    });
  }

  async execute(params: AnalyzeBaseParams): Promise<AnalyzeBaseResult> {
    try {
      const { path } = params;
      if (typeof path !== 'string' || path.trim() === '') {
        return this.prepareResult(false, undefined, 'path is required');
      }

      const limit = this.resolveLimit(params.limit);
      if (limit instanceof Error) {
        return this.prepareResult(false, undefined, limit.message);
      }

      const source = await BaseFileOperations.readSource(this.app, path);
      const { config } = BaseValidator.parseAndValidate(source);
      if (!config) {
        return this.prepareResult(false, undefined, `Base file is not valid YAML, so it cannot be executed: ${BaseFileOperations.normalizePath(path)}`);
      }

      const normalizedPath = BaseFileOperations.normalizePath(path);
      const run = await BaseQueryRunner.run({
        app: this.app,
        plugin: this.plugin,
        sourcePath: normalizedPath,
        config,
        viewName: typeof params.view === 'string' ? params.view : undefined,
        limit
      });

      const { harvest } = run;
      const warnings = this.collectWarnings(source, harvest);

      return this.prepareResult(true, {
        path: normalizedPath,
        view: run.view,
        properties: harvest.properties,
        propertiesSource: harvest.propertiesSource,
        rowCount: harvest.rowCount,
        returned: harvest.returned,
        truncated: harvest.truncated,
        limit,
        grouped: harvest.grouped,
        ...(harvest.rows ? { rows: harvest.rows } : {}),
        ...(harvest.groups ? { groups: harvest.groups } : {}),
        ...(harvest.summaries ? { summaries: harvest.summaries } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        elapsedMs: run.elapsedMs
      });
    } catch (error) {
      if (error instanceof BaseAnalyzeError) {
        return this.prepareResult(false, undefined, error.message);
      }
      return this.prepareResult(false, undefined, createErrorMessage('Error analyzing base: ', error));
    }
  }

  /** Clamp rather than trust: the schema validates nothing at runtime. */
  private resolveLimit(raw: unknown): number | Error {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_ANALYZE_LIMIT;

    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(parsed)) {
      return new Error(`limit must be a number between 1 and ${MAX_ANALYZE_LIMIT}`);
    }

    const rounded = Math.floor(parsed);
    if (rounded < 1) {
      return new Error(`limit must be at least 1 (got ${rounded})`);
    }

    return Math.min(rounded, MAX_ANALYZE_LIMIT);
  }

  /**
   * Caveats about this run, in the caller's language.
   *
   * The `this` warning is narrower than it first looks. `this` resolves against
   * the file the base is embedded in, and `analyze` runs through an embed — but
   * the embed is rendered with the ORIGINAL base file as its source path, so
   * `this` resolves to that base file, exactly as it does when the base is
   * opened in a tab. [VERIFIED 2026-08-14, Obsidian 1.13.7: a formula
   * `this.file.name` returns the source base's name, not the scratch copy's.]
   * What still differs is the case where the user normally embeds this base in
   * a note: there `this` is that note, and the rows differ. Hence a warning, not
   * a refusal. Detected on the raw source rather than the parsed config so a
   * `this` inside any expression, anywhere, is caught.
   */
  private collectWarnings(source: string, harvest: HarvestedResult): string[] {
    const warnings: string[] = [];

    if (harvest.rowCount === 0) {
      warnings.push(
        'No rows matched. Note that Bases returns zero rows both when the filters genuinely match nothing AND when it cannot evaluate a filter or formula - it reports no error for the second case. If you expected rows, check the filter expressions with baseManager.read.'
      );
    }

    if (/(^|[^\w.])this\b/.test(source)) {
      warnings.push(
        'This base uses `this`. analyze resolves it to the base file itself, which matches what you see when the base is opened in a tab. If this base is normally embedded in a note, `this` means that note instead and the rows there will differ.'
      );
    }

    if (harvest.propertiesSource === 'allProperties') {
      warnings.push(
        'This view declares no `order`, so Obsidian reports no chosen columns. Columns were taken from every property in the result set instead.'
      );
    }

    if (harvest.propertiesTruncated) {
      warnings.push('The property list was capped at 30 columns.');
    }

    return warnings;
  }

  getParameterSchema(): JSONSchema {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the base file (with or without .base extension)'
        },
        view: {
          type: 'string',
          description: 'Name of the view to execute (default: the first view in the file). Use baseManager.read to see the view names.'
        },
        limit: {
          type: 'number',
          description: `Maximum rows to return (default: ${DEFAULT_ANALYZE_LIMIT}, max: ${MAX_ANALYZE_LIMIT}). rowCount always reports how many rows matched, so a truncated answer still says what it left out.`,
          default: DEFAULT_ANALYZE_LIMIT
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
        view: { type: 'object', description: 'The view that was executed: { name, type }' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Property ids in column order - these are the keys of every row (file.name, note.status, formula.days_left)' },
        propertiesSource: { type: 'string', description: '"view" when the base declares its columns, "allProperties" when it does not and every available property was used' },
        rowCount: { type: 'number', description: 'Rows the query matched, before limit' },
        returned: { type: 'number', description: 'Rows actually returned' },
        truncated: { type: 'boolean', description: 'True when returned < rowCount' },
        limit: { type: 'number', description: 'Row limit applied to this call' },
        grouped: { type: 'boolean', description: 'True when the view declares groupBy; rows then live inside groups' },
        rows: { type: 'array', items: { type: 'object' }, description: 'Rows, each keyed by property id and always carrying file.path (ungrouped views)' },
        groups: { type: 'array', items: { type: 'object' }, description: 'Groups, each { key, rowCount, rows } (grouped views)' },
        summaries: { type: 'object', description: 'Footer aggregates: property id -> { summary name -> value }' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Caveats about this run' },
        elapsedMs: { type: 'number', description: 'Wall time of the execution' }
      },
      required: ['path', 'view', 'properties', 'rowCount', 'returned', 'truncated', 'limit', 'grouped', 'elapsedMs']
    };

    return baseSchema;
  }
}
