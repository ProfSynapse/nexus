/**
 * Location: src/agents/contentManager/utils/unifiedDiff.ts
 *
 * Pure utility for generating unified diffs between two line arrays.
 * No external dependencies — uses LCS-based diff.
 *
 * Output matches standard unified diff format:
 *   @@ -oldStart,oldCount +newStart,newCount @@
 *   (context/add/remove lines with ' '/'+'/'-' prefixes)
 */

/**
 * Compute the Longest Common Subsequence table between two line arrays.
 * Returns a 2D table where lcs[i][j] = length of LCS of oldLines[0..i-1] and newLines[0..j-1].
 */
function computeLCSTable(oldLines: string[], newLines: string[]): number[][] {
  const n = oldLines.length;
  const m = newLines.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        table[i][j] = table[i - 1][j - 1] + 1;
      } else {
        table[i][j] = Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
  }

  return table;
}

const enum DiffType {
  Equal = 0,
  Insert = 1,
  Delete = 2,
}

interface DiffEntry {
  type: DiffType;
  oldLineNum: number; // 1-based, 0 if insert
  newLineNum: number; // 1-based, 0 if delete
  text: string;
}

/**
 * Backtrack through the LCS table to produce a sequence of diff entries.
 */
function backtrack(
  lcsTable: number[][],
  oldLines: string[],
  newLines: string[]
): DiffEntry[] {
  const result: DiffEntry[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.push({
        type: DiffType.Equal,
        oldLineNum: i,
        newLineNum: j,
        text: oldLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcsTable[i][j - 1] >= lcsTable[i - 1][j])) {
      result.push({
        type: DiffType.Insert,
        oldLineNum: 0,
        newLineNum: j,
        text: newLines[j - 1],
      });
      j--;
    } else {
      result.push({
        type: DiffType.Delete,
        oldLineNum: i,
        newLineNum: 0,
        text: oldLines[i - 1],
      });
      i--;
    }
  }

  result.reverse();
  return result;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Build unified diff hunks from diff entries with context lines.
 */
function buildHunks(entries: DiffEntry[], contextLines: number): Hunk[] {
  // Find indices of changed entries
  const changeIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type !== DiffType.Equal) {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes that are close enough to merge into one hunk
  const groups: { start: number; end: number }[] = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let ci = 1; ci < changeIndices.length; ci++) {
    // Count equal entries between groupEnd and changeIndices[ci]
    let equalsBetween = 0;
    for (let k = groupEnd + 1; k < changeIndices[ci]; k++) {
      if (entries[k].type === DiffType.Equal) equalsBetween++;
    }

    if (equalsBetween <= contextLines * 2) {
      groupEnd = changeIndices[ci];
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = changeIndices[ci];
      groupEnd = changeIndices[ci];
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Build hunks from groups
  const hunks: Hunk[] = [];

  for (const group of groups) {
    // Expand to include context
    let hunkStart = group.start;
    let contextBefore = 0;
    for (let k = group.start - 1; k >= 0 && contextBefore < contextLines; k--) {
      if (entries[k].type === DiffType.Equal) {
        hunkStart = k;
        contextBefore++;
      }
    }

    let hunkEnd = group.end;
    let contextAfter = 0;
    for (let k = group.end + 1; k < entries.length && contextAfter < contextLines; k++) {
      if (entries[k].type === DiffType.Equal) {
        hunkEnd = k;
        contextAfter++;
      }
    }

    const hunkLines: string[] = [];
    let oldStart = 0;
    let oldCount = 0;
    let newStart = 0;
    let newCount = 0;
    let oldStartSet = false;
    let newStartSet = false;

    for (let k = hunkStart; k <= hunkEnd; k++) {
      const entry = entries[k];

      switch (entry.type) {
        case DiffType.Equal:
          if (!oldStartSet) { oldStart = entry.oldLineNum; oldStartSet = true; }
          if (!newStartSet) { newStart = entry.newLineNum; newStartSet = true; }
          hunkLines.push(' ' + entry.text);
          oldCount++;
          newCount++;
          break;
        case DiffType.Delete:
          if (!oldStartSet) { oldStart = entry.oldLineNum; oldStartSet = true; }
          if (!newStartSet) {
            // Find the next new line number
            for (let m = k + 1; m < entries.length; m++) {
              if (entries[m].newLineNum > 0) { newStart = entries[m].newLineNum; newStartSet = true; break; }
            }
            if (!newStartSet) { newStart = 1; newStartSet = true; }
          }
          hunkLines.push('-' + entry.text);
          oldCount++;
          break;
        case DiffType.Insert:
          if (!newStartSet) { newStart = entry.newLineNum; newStartSet = true; }
          if (!oldStartSet) {
            // Find the next old line number
            for (let m = k + 1; m < entries.length; m++) {
              if (entries[m].oldLineNum > 0) { oldStart = entries[m].oldLineNum; oldStartSet = true; break; }
            }
            if (!oldStartSet) { oldStart = 1; oldStartSet = true; }
          }
          hunkLines.push('+' + entry.text);
          newCount++;
          break;
      }
    }

    hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
  }

  return hunks;
}

/**
 * Generate a unified diff string between two line arrays.
 *
 * @param oldLines - Original file content split by newline
 * @param newLines - Modified file content split by newline
 * @param contextLines - Number of context lines around each change (default: 3)
 * @returns Unified diff string, or empty string if no changes
 */
export function generateUnifiedDiff(
  oldLines: string[],
  newLines: string[],
  contextLines: number = 3
): string {
  // Fast path: identical content
  if (oldLines.length === newLines.length && oldLines.every((line, i) => line === newLines[i])) {
    return '';
  }

  const lcsTable = computeLCSTable(oldLines, newLines);
  const entries = backtrack(lcsTable, oldLines, newLines);
  const hunks = buildHunks(entries, contextLines);

  if (hunks.length === 0) return '';

  const parts: string[] = [];
  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    parts.push(...hunk.lines);
  }

  return parts.join('\n');
}
