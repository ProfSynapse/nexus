/**
 * Location: src/agents/contentManager/tools/replace.ts
 *
 * Replace tool for ContentManager.
 *
 * Replaces or deletes a range of content in a note, identified by `start` and
 * `end` text anchors. Anchors are matched as whole lines (multi-line anchors
 * join lines with `\n`); both anchors must be globally unique in the file.
 * Line numbers are never required — anchors are content-based and survive
 * prior edits that shift lines around.
 *
 * Relationships:
 * - Paired with insert.ts (insert handles adding new content; this handles modifying existing)
 * - Uses generateUnifiedDiff for diff output
 * - Part of ContentManager agent (registered in contentManager.ts)
 */
import { App, TFile } from 'obsidian';
import { BaseTool } from '../../baseTool';
import { ReplaceParams, ReplaceResult } from '../types';
import { createErrorMessage } from '../../../utils/errorUtils';
import { generateUnifiedDiff } from '../utils/unifiedDiff';
import type { ToolStatusTense } from '../../interfaces/ITool';
import { labelFileOp, verbs } from '../../utils/toolStatusLabels';

/**
 * Normalize line endings to LF for consistent comparison.
 */
function normalizeCRLF(text: string): string {
  return text.replace(/\r/g, '');
}

/**
 * Normalize line endings AND Unicode form for the equality check only.
 *
 * Compatibility (NFKC) tolerance: anchor text authored by an LLM may arrive
 * in a different Unicode normalization form than what `vault.read()` returns.
 * This covers both canonical drift (NFC vs NFD accents) and compatibility
 * drift such as ordinal indicators (`º` -> `o`, `ª` -> `a`), ellipsis
 * (`…` -> `...`), and NBSP (U+00A0 -> regular space).
 *
 * We normalize ONLY for the comparison, not for the rebuild — the file's
 * original normalization form is preserved in the parts the operator did
 * not touch, and the replacement `content` is written verbatim.
 */
function normalizeForCompare(text: string): string {
  return normalizeCRLF(text).normalize('NFKC');
}

/**
 * Find all line-block occurrences of `blockText` in `fileLines`.
 *
 * Returns 0-based [start, end] inclusive line offsets for each contiguous
 * match. Uses NFKC + CRLF normalization for comparison.
 */
function findLineBlock(
  fileLines: string[],
  blockText: string
): Array<{ start: number; end: number }> {
  const blockLines = blockText.split('\n');
  const matches: Array<{ start: number; end: number }> = [];
  if (blockLines.length === 0 || blockLines.length > fileLines.length) return matches;

  // Pre-normalize both sides once so the inner loop stays cheap. Pre-normalizing
  // fileLines buys O(N) instead of O(N*M) calls into String.prototype.normalize,
  // which is non-trivial for files with many accented characters.
  const normalizedBlock = blockLines.map(normalizeForCompare);
  const normalizedFile = fileLines.map(normalizeForCompare);

  for (let i = 0; i <= normalizedFile.length - normalizedBlock.length; i++) {
    let found = true;
    for (let j = 0; j < normalizedBlock.length; j++) {
      if (normalizedFile[i + j] !== normalizedBlock[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      matches.push({ start: i, end: i + normalizedBlock.length - 1 });
    }
  }

  return matches;
}

export class ReplaceTool extends BaseTool<ReplaceParams, ReplaceResult> {
  private app: App;

  constructor(app: App) {
    super(
      'replace',
      'Replace',
      'Replace or delete a range of content in a note, identified by start and end text anchors. Anchors are matched as whole lines; pass multi-line text via \\n if a single line is not unique. Line numbers are never required.',
      '1.0.0'
    );

    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Replacing in', 'Replaced in', 'Failed to replace in'), params, tense);
  }

  /**
   * Build the result with diff, totalLines, and linesDelta.
   */
  private buildResult(
    oldLines: string[],
    newLines: string[],
    delta: number
  ): ReplaceResult {
    const diff = generateUnifiedDiff(oldLines, newLines);
    return {
      success: true,
      linesDelta: delta,
      totalLines: newLines.length,
      diff
    };
  }

  async execute(params: ReplaceParams): Promise<ReplaceResult> {
    try {
      const { path, start, end, content } = params;

      if (typeof start !== 'string' || !start.trim() || typeof end !== 'string' || !end.trim()) {
        return this.prepareResult(false, undefined,
          'start and end must contain non-whitespace text. Pick distinctive lines from your read.'
        );
      }

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

      const fileText = normalizeCRLF(await this.app.vault.read(file));
      const fileLines = fileText.split('\n');

      const startMatches = findLineBlock(fileLines, start);
      const endMatches = findLineBlock(fileLines, end);

      if (startMatches.length === 0) {
        return this.prepareResult(false, undefined,
          'start anchor not found in file. The content may have been edited since your last read — re-read the file and try again.'
        );
      }

      if (startMatches.length > 1) {
        const lineList = startMatches.map(m => m.start + 1).join(', ');
        return this.prepareResult(false, undefined,
          `start anchor matches ${startMatches.length} locations: lines [${lineList}]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.`
        );
      }

      if (endMatches.length === 0) {
        return this.prepareResult(false, undefined,
          'end anchor not found in file. The content may have been edited since your last read — re-read the file and try again.'
        );
      }

      if (endMatches.length > 1) {
        const lineList = endMatches.map(m => m.start + 1).join(', ');
        return this.prepareResult(false, undefined,
          `end anchor matches ${endMatches.length} locations: lines [${lineList}]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.`
        );
      }

      const s = startMatches[0];
      const e = endMatches[0];

      if (e.end < s.start) {
        return this.prepareResult(false, undefined,
          `end anchor is at line ${e.start + 1} but start anchor is at line ${s.start + 1} (${s.start + 1} > ${e.start + 1}). Check that start and end are in the right order in the file.`
        );
      }

      const beforeLines = fileLines.slice(0, s.start);
      const afterLines = fileLines.slice(e.end + 1);
      const newLinesArr = content === '' ? [] : normalizeCRLF(content).split('\n');

      const resultContent = [...beforeLines, ...newLinesArr, ...afterLines].join('\n');
      await this.app.vault.modify(file, resultContent);

      const finalLines = resultContent.split('\n');
      const delta = finalLines.length - fileLines.length;
      return this.buildResult(fileLines, finalLines, delta);

    } catch (error) {
      return this.prepareResult(false, undefined, createErrorMessage('Error replacing content: ', error));
    }
  }

  getParameterSchema(): Record<string, unknown> {
    const toolSchema = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the note to modify (e.g. "folder/note.md"). Do not include a leading slash.'
        },
        start: {
          type: 'string',
          description: 'The opening line(s) of the range you want to replace, copied verbatim from your read. Must match exactly one location in the file. If a single line is not unique, extend `start` to multiple lines using \\n until it identifies one location only.'
        },
        end: {
          type: 'string',
          description: 'The closing line(s) of the range. Same rules as `start`. Must come after `start` in the file.'
        },
        content: {
          type: 'string',
          description: 'What to write in place of the range from `start` through `end` (inclusive of both anchor lines). Set to an empty string to delete the range entirely.'
        }
      },
      required: ['path', 'start', 'end', 'content']
    };

    return this.getMergedSchema(toolSchema);
  }

  getResultSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        success: {
          type: 'boolean',
          description: 'Whether the replacement succeeded'
        },
        linesDelta: {
          type: 'number',
          description: 'Net change in line count. Positive = lines added, negative = lines removed, zero = same number of lines.'
        },
        totalLines: {
          type: 'number',
          description: 'Total line count of the file after the operation.'
        },
        diff: {
          type: 'string',
          description: 'Unified diff showing what changed with context lines. The @@ headers contain new line numbers — use them to target subsequent edits without re-reading the file.'
        },
        error: {
          type: 'string',
          description: 'Error message if failed. For ambiguous anchors, the message lists the matching line numbers and asks you to extend the anchor to multiple lines.'
        }
      },
      required: ['success']
    };
  }
}
