/**
 * BaseValidator — structural + reference-integrity validation of a `.base`
 * config, run automatically by `base write` / `base update` BEFORE anything
 * reaches disk. There is deliberately no `validate` tool: an optional
 * correctness step is one a model skips (plan §4).
 *
 * Scope, from plan §2: we own the file, Obsidian owns the engine. We can prove
 * that `formula.days_left` is referenced but never defined; we cannot prove an
 * expression is semantically correct without Obsidian's evaluator, and we never
 * reimplement that language. Everything expression-shaped here is therefore a
 * WARNING at most.
 *
 * All findings are collected — validation never short-circuits at the first
 * error — following the precedent set by `SkillValidator.validate()`.
 *
 * Mobile-safe: no Node built-ins; YAML goes through Obsidian's `parseYaml`
 * (never the `yaml` npm package, which is desktop-only).
 */

import { parseYaml } from 'obsidian';
import type {
  BaseValidationCode,
  BaseValidationIssue,
  BaseValidationResult,
  BasesConfigFile
} from '../types';

/** Top-level keys Obsidian's `BasesConfigFile` defines. Anything else is an error. */
export const TOP_LEVEL_KEYS = ['filters', 'properties', 'formulas', 'summaries', 'views'] as const;

/** View types Obsidian ships. Outside this set is a WARNING, never an error. */
export const BUILT_IN_VIEW_TYPES = ['table', 'cards', 'list', 'map'] as const;

/** Built-in summary formula names (plan §6). */
export const BUILT_IN_SUMMARIES = [
  'Average', 'Min', 'Max', 'Sum', 'Range', 'Median', 'Stddev',
  'Earliest', 'Latest', 'Checked', 'Unchecked', 'Empty', 'Filled', 'Unique'
] as const;

const FILTER_KEYS = ['and', 'or', 'not'] as const;

/** Property-id namespaces (kepano's three namespaces: bare/`note.*`, `file.*`, `formula.*`). */
const FORMULA_PREFIX = 'formula.';
const FILE_PREFIX = 'file.';
const NOTE_PREFIX = 'note.';

export interface BaseValidationOptions {
  /**
   * Frontmatter property names that exist somewhere in the vault. Supplied,
   * an `order` entry naming a property no note has produces the
   * `unused-property` WARNING. Omitted, that rule is skipped entirely — it is
   * the one rule that needs the vault, and a validator called without one
   * must not invent findings.
   */
  knownProperties?: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Describe a value's kind for a message, without dumping its contents. */
function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

class Collector {
  readonly errors: BaseValidationIssue[] = [];
  readonly warnings: BaseValidationIssue[] = [];

  error(path: string, code: BaseValidationCode, message: string): void {
    this.errors.push({ path, code, message });
  }

  warn(path: string, code: BaseValidationCode, message: string): void {
    this.warnings.push({ path, code, message });
  }

  result(): BaseValidationResult {
    return { valid: this.errors.length === 0, errors: this.errors, warnings: this.warnings };
  }
}

export class BaseValidator {
  /**
   * Parse a YAML/JSON source string and validate it.
   *
   * A parse failure — and ONLY a parse failure — returns no config: there is
   * nothing to hand back. A document that parses but is structurally invalid
   * still returns its config alongside the errors, because that is exactly what
   * a caller needs in order to read it, or to merge a fix into it. `result.valid`
   * is the gate for writing, not the presence of `config`.
   *
   * An empty document is treated as an empty base (`{}`), which is what
   * Obsidian renders for an empty `.base` file.
   */
  static parseAndValidate(
    source: string,
    options: BaseValidationOptions = {}
  ): { config?: BasesConfigFile; result: BaseValidationResult } {
    let parsed: unknown;
    try {
      parsed = parseYaml(source);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        result: {
          valid: false,
          errors: [{ path: '', code: 'yaml-parse', message: `Base file is not valid YAML: ${message}` }],
          warnings: []
        }
      };
    }

    const config = parsed === null || parsed === undefined ? {} : parsed;
    const result = this.validate(config, options);
    return { config, result };
  }

  /**
   * Validate an already-parsed config object. Accepts `unknown` on purpose:
   * the input is caller-supplied and the typings describe what a VALID file
   * looks like, not what arrived.
   */
  static validate(config: unknown, options: BaseValidationOptions = {}): BaseValidationResult {
    const collector = new Collector();

    if (!isPlainObject(config)) {
      collector.error(
        '',
        'invalid-shape',
        `Base config must be a YAML mapping of ${TOP_LEVEL_KEYS.join('/')}; got ${kindOf(config)}`
      );
      return collector.result();
    }

    // --- unknown-key: no top-level keys outside the documented schema --------
    for (const key of Object.keys(config)) {
      if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
        collector.error(
          key,
          'unknown-key',
          `Unknown top-level key "${key}"; allowed keys are ${TOP_LEVEL_KEYS.join(', ')}`
        );
      }
    }

    const formulas = this.validateStringMap(collector, config.formulas, 'formulas');
    const summaries = this.validateStringMap(collector, config.summaries, 'summaries');
    const formulaNames = new Set(Object.keys(formulas));
    const summaryNames = new Set<string>([...BUILT_IN_SUMMARIES, ...Object.keys(summaries)]);

    // --- filters: global -----------------------------------------------------
    if (config.filters !== undefined) {
      this.validateFilter(collector, config.filters, 'filters');
    }

    // --- properties ----------------------------------------------------------
    if (config.properties !== undefined) {
      if (!isPlainObject(config.properties)) {
        collector.error(
          'properties',
          'invalid-shape',
          `properties must be a mapping of property id to settings; got ${kindOf(config.properties)}`
        );
      } else {
        for (const [propertyId, settings] of Object.entries(config.properties)) {
          if (!isPlainObject(settings)) {
            collector.error(
              `properties.${propertyId}`,
              'invalid-shape',
              `properties.${propertyId} must be a mapping (e.g. displayName: "..."); got ${kindOf(settings)}`
            );
          }
          this.checkFormulaReference(collector, propertyId, formulaNames, `properties.${propertyId}`);
        }
      }
    }

    // --- views ---------------------------------------------------------------
    if (config.views !== undefined) {
      if (!Array.isArray(config.views)) {
        collector.error('views', 'invalid-shape', `views must be an array; got ${kindOf(config.views)}`);
      } else {
        config.views.forEach((view, index) => {
          this.validateView(collector, view, `views[${index}]`, formulaNames, summaryNames, options);
        });
      }
    }

    // --- duration-arithmetic across every expression we hold ------------------
    for (const [name, expression] of Object.entries({ ...formulas })) {
      this.checkDurationArithmetic(collector, expression, `formulas.${name}`);
    }
    for (const [name, expression] of Object.entries({ ...summaries })) {
      this.checkDurationArithmetic(collector, expression, `summaries.${name}`);
    }

    return collector.result();
  }

  // --------------------------------------------------------------------------
  // Sections
  // --------------------------------------------------------------------------

  /** `formulas` / `summaries`: a flat map of name -> expression string. */
  private static validateStringMap(
    collector: Collector,
    value: unknown,
    section: string
  ): Record<string, string> {
    if (value === undefined) return {};

    if (!isPlainObject(value)) {
      collector.error(
        section,
        'invalid-shape',
        `${section} must be a mapping of name to expression string; got ${kindOf(value)}`
      );
      return {};
    }

    const out: Record<string, string> = {};
    for (const [name, expression] of Object.entries(value)) {
      if (typeof expression !== 'string') {
        collector.error(
          `${section}.${name}`,
          'invalid-shape',
          `${section}.${name} must be an expression string; got ${kindOf(expression)}`
        );
        continue;
      }
      out[name] = expression;
    }
    return out;
  }

  /**
   * A filter is a string, or an object with EXACTLY ONE key from and|or|not
   * whose value is an array of filters. Recursive.
   */
  private static validateFilter(collector: Collector, filter: unknown, path: string): void {
    if (typeof filter === 'string') return;

    if (!isPlainObject(filter)) {
      collector.error(
        path,
        'filter-arity',
        `filter must be an expression string or an object with exactly one of ${FILTER_KEYS.join('|')}; got ${kindOf(filter)}`
      );
      return;
    }

    const keys = Object.keys(filter);
    if (keys.length !== 1) {
      collector.error(
        path,
        'filter-arity',
        `filter object has ${keys.length} keys (${keys.join(', ')}); exactly one of ${FILTER_KEYS.join('|')} is allowed`
      );
      return;
    }

    const [key] = keys;
    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
      collector.error(
        path,
        'filter-arity',
        `filter object key "${key}" is not one of ${FILTER_KEYS.join('|')}`
      );
      return;
    }

    const children = filter[key];
    if (!Array.isArray(children)) {
      collector.error(
        `${path}.${key}`,
        'filter-arity',
        `${key} must hold an array of filters; got ${kindOf(children)}`
      );
      return;
    }

    children.forEach((child, index) => {
      this.validateFilter(collector, child, `${path}.${key}[${index}]`);
    });
  }

  private static validateView(
    collector: Collector,
    view: unknown,
    path: string,
    formulaNames: ReadonlySet<string>,
    summaryNames: ReadonlySet<string>,
    options: BaseValidationOptions
  ): void {
    if (!isPlainObject(view)) {
      collector.error(path, 'invalid-shape', `${path} must be a mapping with type and name; got ${kindOf(view)}`);
      return;
    }

    // type — required, but an UNKNOWN type is only a warning: the API types it
    // as `string` precisely because plugins register their own view types via
    // registerBasesView, including our own `nexus-analyze`. Rejecting unknown
    // types would reject files Obsidian renders fine, including ours.
    if (typeof view.type !== 'string' || view.type.trim() === '') {
      collector.error(`${path}.type`, 'invalid-shape', `${path}.type must be a non-empty string`);
    } else if (!(BUILT_IN_VIEW_TYPES as readonly string[]).includes(view.type)) {
      collector.warn(
        `${path}.type`,
        'unknown-view-type',
        `view type "${view.type}" is not one of ${BUILT_IN_VIEW_TYPES.join('|')} — valid if a plugin registers it, otherwise the view will not render`
      );
    }

    if (typeof view.name !== 'string' || view.name.trim() === '') {
      collector.error(`${path}.name`, 'invalid-shape', `${path}.name must be a non-empty string`);
    }

    if (view.filters !== undefined) {
      this.validateFilter(collector, view.filters, `${path}.filters`);
    }

    if (view.limit !== undefined && typeof view.limit !== 'number') {
      collector.error(`${path}.limit`, 'invalid-shape', `${path}.limit must be a number; got ${kindOf(view.limit)}`);
    }

    // groupBy.direction — ASC or DESC.
    if (view.groupBy !== undefined) {
      if (!isPlainObject(view.groupBy)) {
        collector.error(
          `${path}.groupBy`,
          'invalid-shape',
          `${path}.groupBy must be a mapping with property and optional direction; got ${kindOf(view.groupBy)}`
        );
      } else {
        const direction = view.groupBy.direction;
        if (direction !== undefined && direction !== 'ASC' && direction !== 'DESC') {
          collector.error(
            `${path}.groupBy.direction`,
            'group-direction',
            `groupBy.direction must be "ASC" or "DESC"; got ${typeof direction === 'string' ? `"${direction}"` : kindOf(direction)}`
          );
        }
        if (view.groupBy.property !== undefined && typeof view.groupBy.property !== 'string') {
          collector.error(
            `${path}.groupBy.property`,
            'invalid-shape',
            `${path}.groupBy.property must be a property id string; got ${kindOf(view.groupBy.property)}`
          );
        }
      }
    }

    // order — the displayed columns.
    if (view.order !== undefined) {
      if (!Array.isArray(view.order)) {
        collector.error(`${path}.order`, 'invalid-shape', `${path}.order must be an array of property ids; got ${kindOf(view.order)}`);
      } else {
        view.order.forEach((entry, index) => {
          const entryPath = `${path}.order[${index}]`;
          if (typeof entry !== 'string') {
            collector.error(entryPath, 'invalid-shape', `${entryPath} must be a property id string; got ${kindOf(entry)}`);
            return;
          }
          this.checkFormulaReference(collector, entry, formulaNames, entryPath);
          this.checkKnownProperty(collector, entry, entryPath, options);
        });
      }
    }

    // summaries — property id -> summary formula name.
    if (view.summaries !== undefined) {
      if (!isPlainObject(view.summaries)) {
        collector.error(
          `${path}.summaries`,
          'invalid-shape',
          `${path}.summaries must be a mapping of property id to summary name; got ${kindOf(view.summaries)}`
        );
      } else {
        for (const [propertyId, summaryName] of Object.entries(view.summaries)) {
          const entryPath = `${path}.summaries.${propertyId}`;
          this.checkFormulaReference(collector, propertyId, formulaNames, entryPath);

          if (typeof summaryName !== 'string') {
            collector.error(entryPath, 'invalid-shape', `${entryPath} must name a summary formula; got ${kindOf(summaryName)}`);
            continue;
          }
          if (!summaryNames.has(summaryName)) {
            collector.error(
              entryPath,
              'unknown-summary',
              `summary "${summaryName}" is neither a built-in (${BUILT_IN_SUMMARIES.join(', ')}) nor a key in the top-level summaries section`
            );
          }
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Rules reused across sections
  // --------------------------------------------------------------------------

  /** `formula.X` anywhere must resolve to a key in the top-level `formulas`. */
  private static checkFormulaReference(
    collector: Collector,
    propertyId: string,
    formulaNames: ReadonlySet<string>,
    path: string
  ): void {
    if (!propertyId.startsWith(FORMULA_PREFIX)) return;

    const name = propertyId.slice(FORMULA_PREFIX.length);
    if (!formulaNames.has(name)) {
      collector.error(
        path,
        'unknown-formula',
        `${path} references ${propertyId}, which is not defined in formulas`
      );
    }
  }

  /**
   * A frontmatter property no note currently has. Warning only: the property
   * may be about to exist, and a base over an empty vault is legitimate.
   */
  private static checkKnownProperty(
    collector: Collector,
    propertyId: string,
    path: string,
    options: BaseValidationOptions
  ): void {
    const known = options.knownProperties;
    if (!known) return;
    if (propertyId.startsWith(FILE_PREFIX) || propertyId.startsWith(FORMULA_PREFIX)) return;

    const bare = propertyId.startsWith(NOTE_PREFIX) ? propertyId.slice(NOTE_PREFIX.length) : propertyId;
    if (bare === '' || known.has(bare)) return;

    collector.warn(
      path,
      'unused-property',
      `no note in the vault currently has the frontmatter property "${bare}" — the column will be empty`
    );
  }

  /**
   * kepano's documented number-one authoring error: subtracting two dates
   * yields a Duration, which has no `.round()`/`.floor()`/`.ceil()`. A numeric
   * field (`.days`, `.hours`, …) must be accessed first.
   *
   * Warning, not error: we are pattern-matching an expression language we do
   * not parse, so this must never veto a write.
   */
  private static checkDurationArithmetic(collector: Collector, expression: string, path: string): void {
    const rounding = /\)\s*\.\s*(round|floor|ceil)\s*\(/g;

    let match: RegExpExecArray | null;
    while ((match = rounding.exec(expression)) !== null) {
      const inner = this.enclosedGroup(expression, match.index);
      if (inner !== null && this.hasTopLevelSubtraction(inner)) {
        collector.warn(
          path,
          'duration-arithmetic',
          `(${inner.trim()}).${match[1]}(...) — subtracting dates yields a Duration, which has no .${match[1]}(); access .days/.hours/.minutes/.seconds first`
        );
      }
    }
  }

  /**
   * Text inside the parenthesis group that closes at `closeIndex`, or null if
   * the expression is unbalanced (which the engine, not us, will complain about).
   */
  private static enclosedGroup(expression: string, closeIndex: number): string | null {
    let depth = 0;
    for (let i = closeIndex; i >= 0; i--) {
      const char = expression[i];
      if (char === ')') depth++;
      else if (char === '(') {
        depth--;
        if (depth === 0) return expression.slice(i + 1, closeIndex);
      }
    }
    return null;
  }

  /** A `-` used as a binary operator at paren depth 0 (ignores unary minus). */
  private static hasTopLevelSubtraction(expression: string): boolean {
    let depth = 0;
    for (let i = 0; i < expression.length; i++) {
      const char = expression[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === '-' && depth === 0) {
        const before = expression.slice(0, i).trimEnd();
        // Unary minus: nothing, or another operator, precedes it.
        if (before !== '' && !/[+\-*/%<>=!&|,([]$/.test(before)) return true;
      }
    }
    return false;
  }
}
