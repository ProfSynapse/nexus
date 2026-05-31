/**
 * Cell diffing + the formula-cell guard for the write-back leg. Pure.
 *
 * The mirror CSV (the AI's edited surface) is diffed against the ORIGINAL
 * workbook values to find changed data cells. Comparison is done on the unquoted
 * string form (the CSV parser yields unquoted strings; {@link cellToRaw} renders
 * the original the same way), so type ambiguity never produces a false diff.
 */

import { cellToRaw } from './csv';
import type { CellValue } from './types';

export interface CellEdit {
  sheet: string;
  /** 0-based row / column. */
  row: number;
  col: number;
  /** A1 reference, e.g. `B4`. */
  a1: string;
  before: string;
  after: string;
}

/** 0-based column index → spreadsheet letters (0→A, 25→Z, 26→AA). */
export function colLetter(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 0-based (row, col) → A1 reference. */
export function a1Ref(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`;
}

/**
 * Diff a sheet's ORIGINAL values against its EDITED (parsed-CSV) grid. Handles
 * ragged dimensions (added/removed rows or columns) by comparing over the union.
 */
export function diffSheet(
  sheet: string,
  original: CellValue[][],
  edited: string[][]
): CellEdit[] {
  const edits: CellEdit[] = [];
  const rowCount = Math.max(original.length, edited.length);

  for (let row = 0; row < rowCount; row++) {
    const o = original[row] ?? [];
    const e = edited[row] ?? [];
    const colCount = Math.max(o.length, e.length);
    for (let col = 0; col < colCount; col++) {
      const before = cellToRaw(o[col] ?? null);
      const after = e[col] ?? '';
      if (before !== after) {
        edits.push({ sheet, row, col, a1: a1Ref(row, col), before, after });
      }
    }
  }
  return edits;
}

/**
 * Split edits into those we will APPLY and those BLOCKED because they target a
 * formula cell (the write-back never clobbers a live formula by default).
 */
export function partitionByFormula(
  edits: CellEdit[],
  formulaCells: Set<string>
): { applied: CellEdit[]; blocked: CellEdit[] } {
  const applied: CellEdit[] = [];
  const blocked: CellEdit[] = [];
  for (const edit of edits) {
    (formulaCells.has(edit.a1) ? blocked : applied).push(edit);
  }
  return { applied, blocked };
}

/**
 * Coerce an edited string to the ORIGINAL cell's type where compatible, so a
 * numeric column stays numeric and a boolean stays boolean on write-back; text
 * (e.g. a leading-zero ZIP) is left as-is.
 */
export function coerceToOriginalType(original: CellValue, edited: string): CellValue {
  if (typeof original === 'number' && edited.trim() !== '' && !Number.isNaN(Number(edited))) {
    return Number(edited);
  }
  if (typeof original === 'boolean') {
    if (edited === 'TRUE') return true;
    if (edited === 'FALSE') return false;
  }
  return edited;
}
