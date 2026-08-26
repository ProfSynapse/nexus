import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { RemovePropertyParams, RemovePropertyResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { resolveVaultPath, tryResolveVaultPath } from '../../../core/vaultPath';
import type { ToolMutationIntent } from '../../policy/ToolExecutionPolicy';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

/**
 * Outcome of a `removeProperty` decision. Extracted as a pure function so every
 * branch is unit-testable without an Obsidian App mock — same shape as
 * `computeMergeResult` in `setProperty.ts`.
 */
export type RemoveResult =
  | { kind: 'delete' }
  | { kind: 'replace'; value: unknown }
  | { kind: 'error'; message: string };

/**
 * Loose scalar comparison. The CLI hands every argument over as a string, so a
 * frontmatter `year: 2024` (number) would never match `--value "2024"` under
 * strict equality. Compare strictly first, then fall back to string form for
 * primitives. Objects are never string-compared — `[object Object]` would make
 * unrelated maps look equal.
 */
function valuesMatch(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  const primitive = (v: unknown): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  return primitive(a) && primitive(b) && String(a) === String(b);
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => JSON.stringify(item)).join(', ')}]`;
  }
  return JSON.stringify(value) ?? String(value);
}

/**
 * Decide what a `removeProperty` call should do, given the note's frontmatter,
 * the property name and an optional value. Pure: no side effects, no IO.
 *
 * Branches:
 *   - property absent → error naming the keys that ARE present. A silent
 *     no-op here would let a typo ("tag" for "tags") report success.
 *   - no `value` → delete the whole key.
 *   - `value` + array existing → drop every matching item. When nothing is
 *     left the key goes too, so removing the last tag does not leave `tags: []`
 *     behind.
 *   - `value` + scalar existing → delete the key when it matches, error when
 *     it does not (nothing was removed, so success would be a lie).
 *   - a value that is not present → error naming what IS there.
 */
export function computeRemoveResult(
  frontmatter: Record<string, unknown>,
  property: string,
  value?: unknown
): RemoveResult {
  if (!(property in frontmatter) || frontmatter[property] === undefined) {
    const keys = Object.keys(frontmatter);
    return {
      kind: 'error',
      message:
        `Property "${property}" is not set on this note. ` +
        (keys.length > 0
          ? `Properties present: ${keys.join(', ')}.`
          : 'The note has no frontmatter properties.'),
    };
  }

  const existing = frontmatter[property];

  if (value === undefined) {
    return { kind: 'delete' };
  }

  const wanted: unknown[] = Array.isArray(value) ? value : [value];

  if (Array.isArray(existing)) {
    const missing = wanted.filter(item => !existing.some(current => valuesMatch(current, item)));
    if (missing.length > 0) {
      return {
        kind: 'error',
        message:
          `Cannot remove ${missing.map(item => JSON.stringify(item)).join(', ')} from "${property}": ` +
          `not present. Current value: ${describe(existing)}. ` +
          `Omit --value to remove the whole property.`,
      };
    }
    const remaining = existing.filter(current => !wanted.some(item => valuesMatch(current, item)));
    // Removing the last item removes the property rather than leaving an empty
    // list in the frontmatter.
    return remaining.length === 0 ? { kind: 'delete' } : { kind: 'replace', value: remaining };
  }

  if (wanted.length > 1) {
    return {
      kind: 'error',
      message:
        `Cannot remove multiple values from "${property}": it holds a single value ` +
        `(${describe(existing)}), not a list. Pass one matching value, or omit --value ` +
        `to remove the whole property.`,
    };
  }

  if (!valuesMatch(existing, wanted[0])) {
    return {
      kind: 'error',
      message:
        `Cannot remove ${JSON.stringify(wanted[0])} from "${property}": ` +
        `its value is ${describe(existing)}. ` +
        `Omit --value to remove the whole property.`,
    };
  }

  return { kind: 'delete' };
}

/**
 * Location: src/agents/contentManager/tools/removeProperty.ts
 *
 * Tool for removing frontmatter properties from notes — the counterpart to
 * `setProperty`, which can only ever write a key. Two shapes:
 * - no `value`: the whole property is removed
 * - `value`: only that item is removed from a list property (the inverse of
 *   `setProperty --mode merge`); the key itself goes when nothing is left
 *
 * Uses Obsidian's fileManager.processFrontMatter() for atomic frontmatter
 * manipulation, same as setProperty.
 *
 * This is an in-file edit, not a vault delete: it is covered by the same
 * vault-preimage undo as the other contentManager write tools, so it does not
 * hand the AI an irreversible destructive action.
 *
 * Relationships:
 * - Part of ContentManager agent (CRUA + property operations)
 * - Follows write tool response stripping principle (returns { success: true } only)
 */
export class RemovePropertyTool extends BaseTool<RemovePropertyParams, RemovePropertyResult> {
  private app: App;

  constructor(app: App) {
    super(
      'removeProperty',
      'Remove property',
      'Remove a frontmatter property from a note. Pass a value to drop just that item from a list property; omit it to remove the whole property.',
      '1.0.0'
    );
    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Removing property from', 'Removed property from', 'Failed to remove property from'), params, tense);
  }

  getMutationIntent(params: RemovePropertyParams): Promise<ToolMutationIntent> {
    return Promise.resolve({ kind: 'modify', path: resolveVaultPath(params.path) });
  }

  async execute(params: RemovePropertyParams): Promise<RemovePropertyResult> {
    try {
      const { path, property, value } = params;

      if (typeof property !== 'string' || property.trim().length === 0) {
        return this.prepareResult(false, undefined,
          'A non-empty "property" name is required. Pass the frontmatter key to remove, e.g. "tags".'
        );
      }

      // Confine to the vault: reject traversal/absolute/home-expansion paths.
      const resolved = tryResolveVaultPath(path);
      if (!resolved.ok) {
        return this.prepareResult(false, undefined, resolved.error);
      }
      const file = this.app.vault.getAbstractFileByPath(resolved.path);

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

      let removeError: string | null = null;

      await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        const outcome = computeRemoveResult(frontmatter, property, value);
        if (outcome.kind === 'error') {
          removeError = outcome.message;
          return;
        }
        if (outcome.kind === 'delete') {
          delete frontmatter[property];
          return;
        }
        frontmatter[property] = outcome.value;
      });

      if (removeError) {
        return this.prepareResult(false, undefined, removeError);
      }

      return { success: true };
    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error removing property: ', error));
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
          description: 'Frontmatter property name to remove (e.g. "tags", "aliases", "status")'
        },
        value: {
          oneOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'boolean' },
            { type: 'array', items: { type: 'string' } }
          ],
          description: 'Optional. Omit to remove the whole property. Pass a value to remove only that item from a list property — the inverse of set-property --mode merge — e.g. --value "[[Note]]" to drop one link, or --value "a,b" to drop several. Removing the last item removes the property too. It is an error if the value is not present.'
        }
      },
      required: ['path', 'property']
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
