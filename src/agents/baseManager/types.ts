/**
 * Types for the base manager agent (`.base` files — Obsidian Bases).
 *
 * The config schema itself is NOT hand-rolled: `BasesConfigFile`,
 * `BasesConfigFileFilter` and `BasesConfigFileView` are public Obsidian API
 * (`@since 1.10.0`) and are re-exported here so the shape tracks Obsidian
 * across app updates instead of drifting. See
 * `docs/plans/bases-manager-agent-plan.md` §5.
 *
 * These are TYPE-ONLY re-exports. Nothing here dereferences the `obsidian`
 * module at runtime, so importing this file is safe on an app older than
 * 1.10.0 where the Bases API does not exist.
 */

import type { CommonParameters, CommonResult } from '../../types/mcp/AgentTypes';
import type { BasesConfigFile, BasesConfigFileFilter, BasesConfigFileView } from 'obsidian';

export type { BasesConfigFile, BasesConfigFileFilter, BasesConfigFileView };

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validation codes. Errors reject the write; warnings let it proceed.
 * Plan §6 defines the rule behind each code.
 *
 * `invalid-shape` is the one code not named in §6: it covers "a key exists but
 * holds the wrong kind of value" (`views: "table"`, a view with no `name`).
 * Without it the walker would have to either crash or silently skip malformed
 * input, and both are worse than a precise rejection.
 */
export type BaseValidationCode =
  | 'yaml-parse'
  | 'unknown-key'
  | 'invalid-shape'
  | 'filter-arity'
  | 'group-direction'
  | 'unknown-formula'
  | 'unknown-summary'
  | 'unknown-view-type'
  | 'duration-arithmetic'
  | 'unused-property';

/** One validation finding, addressable so a caller can fix it independently. */
export interface BaseValidationIssue {
  /** Dotted/indexed path into the config, e.g. `views[0].order[3]`. */
  path: string;
  code: BaseValidationCode;
  message: string;
}

export interface BaseValidationResult {
  /** True when `errors` is empty. Warnings do not affect validity. */
  valid: boolean;
  errors: BaseValidationIssue[];
  warnings: BaseValidationIssue[];
}

// ============================================================================
// TOOL PARAMETERS / RESULTS
// ============================================================================

/** Per-file summary returned by `base list`. */
export interface BaseFileSummary {
  path: string;
  name: string;
  modified: number;
  views: number;
  formulas: number;
  hasGlobalFilters: boolean;
  /** Set when the file could not be parsed as YAML; counts are then 0. */
  error?: string;
}

// 1. Read
export interface ReadBaseParams extends CommonParameters {
  /** Path to the base file (with or without the `.base` extension). */
  path: string;
}

export interface ReadBaseResult extends CommonResult {
  data?: {
    path: string;
    config: BasesConfigFile;
    viewCount: number;
    formulaCount: number;
    viewNames: string[];
    /** Structural problems in the file as it stands (the read still succeeds). */
    errors?: BaseValidationIssue[];
    warnings?: BaseValidationIssue[];
  };
}

// 2. Write (create NEW)
export interface WriteBaseParams extends CommonParameters {
  /** Path for the new base file. */
  path: string;
  /** Whole config as a YAML or JSON string, or an object. */
  config?: string | Record<string, unknown>;
  /** Individual top-level sections, merged over `config`. */
  filters?: string | Record<string, unknown>;
  formulas?: string | Record<string, unknown>;
  properties?: string | Record<string, unknown>;
  summaries?: string | Record<string, unknown>;
  views?: string | unknown[];
}

/**
 * Validation findings ride on the result object. NOTE: on failure the
 * `useTools` batch formatter keeps only `error`, so the rejection message
 * itself also renders every issue — see `formatValidationFailure`.
 */
export interface BaseWriteResult extends CommonResult {
  errors?: BaseValidationIssue[];
  warnings?: BaseValidationIssue[];
  data?: {
    path: string;
    /** Top-level sections written (write) or replaced (update). */
    sections: string[];
  };
}

// 3. Update (modify EXISTING)
export type UpdateBaseParams = WriteBaseParams;

// 4. List
export interface ListBaseParams extends CommonParameters {
  /** Folder to search (default: whole vault). */
  folder?: string;
  /** Search subfolders (default: true). */
  recursive?: boolean;
}

export interface ListBaseResult extends CommonResult {
  data?: {
    bases: BaseFileSummary[];
    total: number;
  };
}

// 5. Analyze (execute the query)
export interface AnalyzeBaseParams extends CommonParameters {
  /** Path to the base file (with or without the `.base` extension). */
  path: string;
  /** View to execute (default: the first view in the file). */
  view?: string;
  /** Maximum rows to return (default: `DEFAULT_ANALYZE_LIMIT`). */
  limit?: number;
}

/** One row: property id → value, always including `file.path`. */
export type BaseAnalyzeRow = Record<string, string | number | boolean | null | (string | number | boolean | null)[]>;

export interface BaseAnalyzeGroup {
  /** Display value of the groupBy key, or null for the "no value" group. */
  key: string | null;
  rowCount: number;
  rows: BaseAnalyzeRow[];
}

export interface AnalyzeBaseResult extends CommonResult {
  data?: {
    path: string;
    view: { name: string; type: string };
    /** Property ids in column order — the keys of every row. */
    properties: string[];
    /** `view` when the base declares its columns; `allProperties` when it does not. */
    propertiesSource: 'view' | 'allProperties';
    /** Rows the query matched, before `limit`. */
    rowCount: number;
    /** Rows actually returned. */
    returned: number;
    truncated: boolean;
    limit: number;
    grouped: boolean;
    /** Present when the view does not group. */
    rows?: BaseAnalyzeRow[];
    /** Present when the view groups; rows live inside the groups. */
    groups?: BaseAnalyzeGroup[];
    /** Footer aggregates: property id → { summary name → value }. */
    summaries?: Record<string, Record<string, unknown>>;
    /** Non-blocking caveats about this specific run. */
    warnings?: string[];
    elapsedMs: number;
  };
}
