import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { SetPropertyParams, SetPropertyResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

// Typed predicate so `Array.isArray` narrowing yields `unknown[]` instead of
// `any[]`. Lets us spread `existing` at the scalar-into-array branch without
// tripping @typescript-eslint/no-unsafe-assignment.
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Outcome of a merge-mode decision for `setProperty`. Extracted as a pure
 * function so every branch (including the scalar-into-array promotion added
 * for #172) is covered by unit tests without needing an Obsidian App mock.
 */
export type MergeResult =
  | { kind: 'replace'; value: unknown }
  | { kind: 'error'; message: string };

/**
 * Decide what a merge-mode `setProperty` call should write, given the current
 * frontmatter value and the new input. Pure: no side effects, no IO.
 *
 * Branches:
 *   - `existing` absent → replace with incoming value.
 *   - both `string[]` → union with dedup (order preserved).
 *   - array existing + scalar incoming → promote scalar to `[value]` and
 *     union-dedup. Fix for #172: previously errored with a type-mismatch and
 *     made single-item append via CLI impossible.
 *   - scalar existing + array incoming → error. Semantically ambiguous (is
 *     the existing scalar one of the new items, or should it be discarded?).
 *   - both scalars, or both arrays of a non-string shape → replace. The
 *     latter is a pre-#172 characterization: non-string-array merge is a
 *     silent replace rather than an error or union. Preserving existing
 *     behavior to keep the fix narrowly scoped.
 */
export function computeMergeResult(existing: unknown, value: unknown): MergeResult {
  if (existing === undefined || existing === null) {
    return { kind: 'replace', value };
  }

  if (isStringArray(existing) && isStringArray(value)) {
    const merged = [...existing];
    for (const item of value) {
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }
    return { kind: 'replace', value: merged };
  }

  if (isUnknownArray(existing) && !Array.isArray(value)) {
    const merged: unknown[] = [...existing];
    if (!merged.includes(value)) {
      merged.push(value);
    }
    return { kind: 'replace', value: merged };
  }

  if (Array.isArray(existing) !== Array.isArray(value)) {
    return {
      kind: 'error',
      message:
        `Cannot merge: existing value is ${Array.isArray(existing) ? 'array' : 'scalar'} ` +
        `but new value is ${Array.isArray(value) ? 'array' : 'scalar'}. ` +
        `Use mode "replace" to overwrite, or ensure both values are the same type.`,
    };
  }

  // Scalar + Scalar (or array + non-string-array): replace.
  return { kind: 'replace', value };
}

/**
 * Location: src/agents/contentManager/tools/setProperty.ts
 *
 * Tool for setting frontmatter properties on notes.
 * Supports two modes:
 * - "replace" (default): overwrites the property value
 * - "merge": performs array union with dedup for list fields;
 *   equivalent to replace for scalars
 *
 * Uses Obsidian's fileManager.processFrontMatter() for atomic
 * frontmatter manipulation.
 *
 * Relationships:
 * - Part of ContentManager agent (CRUA + property operations)
 * - Follows write tool response stripping principle (returns { success: true } only)
 *
 * Ref: #33
 */
export class SetPropertyTool extends BaseTool<SetPropertyParams, SetPropertyResult> {
  private app: App;

  constructor(app: App) {
    super(
      'setProperty',
      'Set property',
      'Set a frontmatter property on a note. Supports "replace" (default) and "merge" (array union with dedup) modes.',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Setting property on', 'Set property on', 'Failed to set property on'), params, tense);
  }

  async execute(params: SetPropertyParams): Promise<SetPropertyResult> {
    try {
      const { path, property, value, mode = 'replace' } = params;

      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (!file) {
        return this.prepareResult(false, undefined,
          `File not found: "${path}". Use search content to find files by name, or storageManager.list to explore folders.`
        );
      }

      if (!(file instanceof TFile)) {
        return this.prepareResult(false, undefined,
          `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`
        );
      }

      let mergeError: string | null = null;

      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        if (mode === 'merge') {
          const outcome = computeMergeResult(frontmatter[property], value);
          if (outcome.kind === 'error') {
            mergeError = outcome.message;
            return;
          }
          frontmatter[property] = outcome.value;
        } else {
          frontmatter[property] = value;
        }
      });

      if (mergeError) {
        return this.prepareResult(false, undefined, mergeError);
      }

      return { success: true };
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error setting property: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note file'
        },
        property: {
          type: 'string',
          description: 'Frontmatter property name (e.g. "tags", "aliases", "status")'
        },
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Value to set. Can be a string, number, boolean, or array of strings.'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'merge'],
          default: 'replace',
          description: "How to apply the value. 'replace' overwrites (default). 'merge' performs array union with dedup for list fields; equivalent to replace for scalars."
        }
      },
      required: ['path', 'property', 'value']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the operation succeeded'
        },
        error: {
          type: 'string',
          description: 'Error message if failed (includes recovery guidance)'
        }
      },
      required: ['success']
    };
  }
}
