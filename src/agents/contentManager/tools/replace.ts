/**
 * Location: src/agents/contentManager/tools/replace.ts
 *
 * Replace tool for ContentManager.
 * Validates that the content at the specified lines matches oldContent before making changes.
 * If the content has moved (e.g., due to other edits), returns the new line numbers where it
 * can be found via sliding-window search.
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
 * NFC tolerance: an LLM-authored `oldContent` may arrive in a different
 * Unicode normalization form than what `vault.read()` returns — same code
 * points, different bytes — typically when accented PT-BR text round-trips
 * through a pipeline that NFD-decomposes (legacy Cocoa APIs, some JSON
 * encoders, copy-paste through certain editors). Pre-NFC, the comparator
 * was strict byte-equality and silently failed with "Content not found"
 * even though the visible content was identical, forcing the operator to
 * escalate to overwrite (which violates the minimum-edit rule).
 *
 * We normalize ONLY for the comparison, not for the rebuild — the file's
 * original normalization form is preserved in the parts the operator did
 * not touch, and the `newContent` payload is written verbatim. This keeps
 * the side-effect of the fix bounded to "the comparator stops being byte-
 * strict" without converting the whole file behind the operator's back.
 */
function normalizeForCompare(text: string): string {
  return normalizeCRLF(text).normalize('NFC');
}

/**
 * Search for a multi-line content block in a file's lines array.
 * Returns all 1-based line ranges where the block appears as a contiguous match.
 */
function findContentInLines(
  fileLines: string[],
  searchLines: string[]
): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = [];
  const searchLen = searchLines.length;

  if (searchLen === 0 || searchLen > fileLines.length) return matches;

  // Pre-normalize both sides once so the inner loop stays cheap. The fileLines
  // pre-normalization buys us O(N) instead of O(N*M) calls into String.prototype
  // .normalize, which is non-trivial for files with many accented chars.
  const normalizedSearch = searchLines.map(normalizeForCompare);
  const normalizedFile = fileLines.map(normalizeForCompare);

  for (let i = 0; i <= normalizedFile.length - searchLen; i++) {
    let found = true;
    for (let j = 0; j < searchLen; j++) {
      if (normalizedFile[i + j] !== normalizedSearch[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      matches.push({ start: i + 1, end: i + searchLen }); // 1-based
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
      'Replace or delete existing content in a note. Validates that the content at the specified lines matches oldContent before making changes. If the content has moved (e.g., due to other edits), returns the new line numbers where it can be found.',
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
      const { path, oldContent, newContent, startLine, endLine } = params;

      // Normalize path (remove leading slash)
      const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
      const file = this.app.vault.getAbstractFileByPath(normalizedPath);

      if (!file) {
        return this.prepareResult(false, undefined,
          `File not found: "${path}". Use searchContent to find files by name, or storageManager.list to explore folders.`
        );
      }

      if (!(file instanceof TFile)) {
        return this.prepareResult(false, undefined,
          `Path is a folder, not a file: "${path}". Use storageManager.list to see its contents.`
        );
      }

      // Validate line numbers
      if (startLine < 1) {
        return this.prepareResult(false, undefined,
          `Invalid startLine: ${startLine}. Line numbers are 1-based (minimum 1).`
        );
      }

      if (endLine < startLine) {
        return this.prepareResult(false, undefined,
          `endLine (${endLine}) cannot be less than startLine (${startLine}).`
        );
      }

      const existingContent = normalizeCRLF(await this.app.vault.read(file));
      const fileLines = existingContent.split('\n');
      const totalLines = fileLines.length;

      if (startLine > totalLines) {
        return this.prepareResult(false, undefined,
          `startLine ${startLine} is beyond file length (${totalLines} lines). Use read to view the file first.`
        );
      }

      if (endLine > totalLines) {
        return this.prepareResult(false, undefined,
          `endLine ${endLine} is beyond file length (${totalLines} lines). Use read to view the file first.`
        );
      }

      // Extract content at the specified line range and compare with oldContent.
      // Compare in NFC form so an oldContent that decomposed somewhere in the
      // pipeline (LLM tokenizer, JSON layer, copy-paste) still matches the file.
      const targetContent = fileLines.slice(startLine - 1, endLine).join('\n');
      const normalizedTarget = normalizeForCompare(targetContent);
      const normalizedOld = normalizeForCompare(oldContent);

      if (normalizedTarget !== normalizedOld) {
        // Content mismatch — search the entire file for where it actually is.
        // Use normalized search lines (CRLF + NFC) so the fallback survives the
        // same drift the line-range check tolerates.
        const searchLines = normalizedOld.split('\n');
        const matches = findContentInLines(fileLines, searchLines);

        if (matches.length === 1) {
          const m = matches[0];
          return this.prepareResult(false, undefined,
            `Content not found at lines ${startLine}-${endLine}. Found at lines ${m.start}-${m.end}. Retry with the correct line numbers.`
          );
        } else if (matches.length > 1) {
          const locations = matches.map(m => `lines ${m.start}-${m.end}`).join(', ');
          return this.prepareResult(false, undefined,
            `Content not found at lines ${startLine}-${endLine}. Found at multiple locations: ${locations}. Specify which occurrence to replace using the correct startLine and endLine.`
          );
        } else {
          return this.prepareResult(false, undefined,
            `Content not found at lines ${startLine}-${endLine} or anywhere else in the note. The content may have been modified or removed.`
          );
        }
      }

      // Content matches — perform the replacement
      const beforeLines = fileLines.slice(0, startLine - 1);
      const afterLines = fileLines.slice(endLine);
      const linesRemoved = endLine - startLine + 1;

      let resultContent: string;
      let delta: number;

      if (newContent === '') {
        // DELETE: Remove lines, don't insert anything
        resultContent = [...beforeLines, ...afterLines].join('\n');
        delta = -linesRemoved;
      } else {
        // REPLACE: Remove lines and insert new content
        const replacementLines = normalizeCRLF(newContent).split('\n');
        resultContent = [...beforeLines, ...replacementLines, ...afterLines].join('\n');
        delta = replacementLines.length - linesRemoved;
      }

      await this.app.vault.modify(file, resultContent);

      const newLines = resultContent.split('\n');
      return this.buildResult(fileLines, newLines, delta);

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
        oldContent: {
          type: 'string',
          description: 'The exact text currently at lines startLine through endLine that you want to replace. This is validated before any changes are made — if the content at those lines doesn\'t match, the tool will search the entire note to find where your content actually is and tell you the correct line numbers. To delete content, set newContent to an empty string.'
        },
        newContent: {
          type: 'string',
          description: 'The text to replace oldContent with. Set to an empty string to delete the content at the specified lines.'
        },
        startLine: {
          type: 'number',
          description: 'The line number (1-indexed) where oldContent begins. Required — ensures the correct occurrence is targeted when identical content appears multiple times in a note.'
        },
        endLine: {
          type: 'number',
          description: 'The line number (1-indexed) where oldContent ends (inclusive). Required — defines the exact range to validate and replace.'
        }
      },
      required: ['path', 'oldContent', 'newContent', 'startLine', 'endLine']
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
          description: 'Error message if failed. If content was found at different lines, the message includes the correct line numbers to retry with.'
        }
      },
      required: ['success']
    };
  }
}
