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
import { addRecommendations } from '../../../utils/recommendationUtils';
import { NudgeHelpers } from '../../../utils/nudgeHelpers';
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
 * Fold typographic ("smart") quote variants down to their ASCII equivalents.
 *
 * NFKC does NOT collapse curly quotes onto straight ones — `’` (U+2019) and
 * `'` (U+0027) remain distinct after `.normalize('NFKC')`, as do the curly
 * double quotes. This is a common drift in practice: an LLM routinely emits a
 * straight apostrophe while the vault stores a typographic one (or vice versa),
 * so an anchor copied "verbatim" from a read of a line like `Poirot’s clue`
 * never matches. We fold both families to ASCII for the comparison only.
 */
function foldSmartQuotes(text: string): string {
  return text
    // single-quote family: left/right/low/high-reversed, prime, modifier apostrophe
    .replace(/[‘’‚‛′ʼ]/g, "'")
    // double-quote family: left/right/low/high-reversed, double prime
    .replace(/[“”„‟″]/g, '"');
}

/**
 * Fold the dash family down to an ASCII hyphen-minus (U+002D).
 *
 * NFKC folds NONE of these, yet LLMs freely swap em/en dashes for hyphens (and
 * vice versa) when echoing a line — `co—operate` vs `co-operate`. Covers HYPHEN
 * (U+2010), non-breaking hyphen (U+2011), figure dash (U+2012), en dash
 * (U+2013), em dash (U+2014), horizontal bar (U+2015), and MINUS SIGN (U+2212).
 */
function foldDashes(text: string): string {
  return text.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
}

/**
 * Strip invisible format characters that survive NFKC and that an LLM will
 * never reproduce when copying a line by sight: soft hyphen (U+00AD),
 * zero-width space (U+200B), zero-width non-joiner/joiner (U+200C/U+200D),
 * word joiner (U+2060), and BOM / zero-width no-break space (U+FEFF). These
 * routinely ride along in web-pasted content and silently break exact matches.
 */
function stripInvisibles(text: string): string {
  // eslint-disable-next-line no-misleading-character-class -- U+200C/U+200D (ZWNJ/ZWJ) are stripped here as independent format chars, not as a grapheme cluster, so the joined-sequence heuristic is a false positive.
  return text.replace(/[\u00ad\u200b\u200c\u200d\u2060\ufeff]/gu, '');
}

/**
 * Normalize a single line for the equality check only — NEVER for the rebuild.
 *
 * Pipeline (each step targets a drift NFKC alone does not fix):
 *  1. CRLF stripped so line endings never matter.
 *  2. Invisible format characters removed (`stripInvisibles`).
 *  3. Smart quotes folded to ASCII (`foldSmartQuotes`).
 *  4. Dash family folded to `-` (`foldDashes`).
 *  5. NFKC — canonical/compat Unicode drift: NFC vs NFD accents, ordinals
 *     (`º`->`o`), ellipsis (`…`->`...`), and the whole Unicode space-separator
 *     family (NBSP, narrow NBSP, thin/figure/ideographic spaces -> a plain space).
 *  6. Trailing whitespace trimmed — markdown hard-break spaces and editor cruft
 *     that an LLM drops when it copies the visible text of a line.
 *
 * Leading whitespace is deliberately preserved: indentation is significant in
 * code blocks and nested lists, and trimming it could match the wrong line.
 *
 * The file's original bytes are preserved in untouched regions and the
 * replacement `content` is written verbatim — this folding affects matching only.
 */
function normalizeForCompare(text: string): string {
  return foldDashes(foldSmartQuotes(stripInvisibles(normalizeCRLF(text))))
    .normalize('NFKC')
    .replace(/\s+$/, '');
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

/**
 * Find the single file line that most closely resembles the (first line of an)
 * unmatched anchor, so the not-found error can show WHY it failed — typically a
 * lone quote or whitespace character that survived normalization. Compares on
 * the normalized form (matching the anchor matcher) and ranks by a cheap
 * character-overlap score; returns null when nothing meaningfully overlaps.
 */
function findNearestLine(
  fileLines: string[],
  anchor: string
): { lineNumber: number; text: string } | null {
  const needle = normalizeForCompare(anchor.split('\n')[0]);
  if (!needle.trim()) return null;

  const needleSet = new Set(needle);
  let best: { lineNumber: number; text: string; score: number } | null = null;

  for (let i = 0; i < fileLines.length; i++) {
    const candidate = normalizeForCompare(fileLines[i]);
    if (!candidate.trim()) continue;

    // Jaccard-ish overlap on the character sets — cheap and good enough to
    // surface the "looks identical but one byte differs" near-miss.
    const candSet = new Set(candidate);
    let shared = 0;
    for (const ch of needleSet) if (candSet.has(ch)) shared += 1;
    const union = new Set([...needleSet, ...candSet]).size;
    const score = union === 0 ? 0 : shared / union;

    if (!best || score > best.score) {
      best = { lineNumber: i + 1, text: fileLines[i], score };
    }
  }

  if (!best || best.score < 0.6) return null;
  return { lineNumber: best.lineNumber, text: best.text };
}

export class ReplaceTool extends BaseTool<ReplaceParams, ReplaceResult> {
  private app: App;

  constructor(app: App) {
    super(
      'replace',
      'Replace',
      'Replace or delete a range of content in a note, identified by start and end text anchors. Anchors are matched as whole lines (compared after Unicode normalization, so straight vs curly quotes/apostrophes, NBSP, ellipsis, and accent forms are treated as equal — paste the line as it reads, don\'t hand-normalize punctuation). Pass multi-line text via \\n if a single line is not unique. Line numbers are never required; if an anchor misses, re-read just the target line range (contentManager.read with a narrow startLine/endLine), not the whole file.',
      '1.0.0'
    );

    this.app = app;
  }

  getStatusLabel(params: Record<string, unknown> | undefined, tense: ToolStatusTense): string | undefined {
    return labelFileOp(verbs('Replacing in', 'Replaced in', 'Failed to replace in'), params, tense);
  }

  /**
   * Build an anchor-not-found failure, attaching a near-miss recommendation
   * through the shared nudge/recommender channel when a close line exists.
   */
  private anchorNotFound(
    message: string,
    fileLines: string[],
    anchor: string
  ): ReplaceResult {
    const result = this.prepareResult(false, undefined, message);
    const nudge = NudgeHelpers.checkAnchorNearMiss(findNearestLine(fileLines, anchor));
    return nudge ? addRecommendations(result, [nudge]) : result;
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
        return this.anchorNotFound(
          'start anchor not found in file. The content may have shifted since your last read — re-read just the expected line range (contentManager.read with a narrow startLine/endLine), not the whole file, then retry.',
          fileLines, start
        );
      }

      if (startMatches.length > 1) {
        const lineList = startMatches.map(m => m.start + 1).join(', ');
        return this.prepareResult(false, undefined,
          `start anchor matches ${startMatches.length} locations: lines [${lineList}]. Make it unique by extending it — include the next line (or several) using \\n so it identifies one location only.`
        );
      }

      if (endMatches.length === 0) {
        return this.anchorNotFound(
          'end anchor not found in file. The content may have shifted since your last read — re-read just the expected line range (contentManager.read with a narrow startLine/endLine), not the whole file, then retry.',
          fileLines, end
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
          description: 'The opening line(s) of the range you want to replace, copied as-is from your read — keep the exact words but don\'t worry about quote/apostrophe style or invisible spacing; matching is normalization-tolerant. Must match exactly one location in the file. If a single line is not unique, extend `start` to multiple lines using \\n until it identifies one location only.'
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
