/**
 * Shared argument handling for `base write` / `base update`.
 *
 * Both tools accept the same two ways of naming content — a whole `--config`
 * document, or individual `--filters` / `--formulas` / `--properties` /
 * `--summaries` / `--views` sections — and both must reject before touching
 * disk. Keeping the assembly and the rejection formatting here is what makes
 * `update`'s merge semantics provably the same validation as `write`'s.
 */

import type { BaseValidationIssue, BaseValidationResult, WriteBaseParams } from '../types';
import { BaseFileOperations } from './BaseFileOperations';

/** Top-level sections a caller may supply, in file order. */
export const SECTION_KEYS = ['filters', 'formulas', 'properties', 'summaries', 'views'] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

/**
 * What a new base gets when the caller names no content at all: one empty
 * table view, which Obsidian renders immediately. An empty document would
 * technically be a valid `.base` file and a useless one.
 */
export const DEFAULT_NEW_BASE = { views: [{ type: 'table', name: 'Table' }] };

/**
 * Assemble the sections a caller supplied. `--config` provides the base layer,
 * individual section flags override it. Strings are parsed as YAML (JSON is a
 * subset, so both work).
 *
 * @throws Error when a supplied value is neither valid YAML nor JSON, or when
 * `--config` is not a mapping.
 */
export function collectSections(params: WriteBaseParams): Record<string, unknown> {
  const sections: Record<string, unknown> = {};

  const config = BaseFileOperations.parseConfigInput(params.config, 'config');
  if (config !== undefined) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      throw new Error('config must be a YAML/JSON mapping of top-level base sections (filters, formulas, properties, summaries, views)');
    }
    Object.assign(sections, config);
  }

  for (const key of SECTION_KEYS) {
    const value = BaseFileOperations.parseConfigInput(params[key], key);
    if (value !== undefined) {
      sections[key] = value;
    }
  }

  return sections;
}

/** Render one issue as `path [code]: message`, with the root path elided. */
export function formatIssue(issue: BaseValidationIssue): string {
  return `${issue.path ? `${issue.path} ` : ''}[${issue.code}]: ${issue.message}`;
}

/**
 * Render a rejection as a single message.
 *
 * This exists because of a hard constraint in the execution path: on
 * `success: false`, `ToolBatchExecutionService.formatUseToolResult` keeps only
 * `agent`, `tool`, `success` and `error` — every other field, including the
 * structured `errors` array, is dropped before the caller sees it. The array is
 * still returned on the result object for in-process callers and tests, but the
 * message is what an MCP caller actually reads, so it has to carry the same
 * information.
 */
export function formatValidationFailure(result: BaseValidationResult): string {
  const lines = [
    `Base config is invalid (${result.errors.length} error${result.errors.length === 1 ? '' : 's'}) — nothing was written`,
    ...result.errors.map(issue => `  - ${formatIssue(issue)}`)
  ];

  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}, not blocking):`);
    lines.push(...result.warnings.map(issue => `  - ${formatIssue(issue)}`));
  }

  return lines.join('\n');
}
