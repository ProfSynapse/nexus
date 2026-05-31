/**
 * CSV (de)serialization for the spreadsheet mirror — RFC-4180 quoting, LF line
 * endings (the repo's canonical EOL; see CLAUDE.md). Pure + engine-agnostic.
 */

import type { CellValue } from './types';

/** UTF-8 byte length of a string (browser/Node-safe; no Buffer dependency). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Serialize one cell. Booleans render as `TRUE`/`FALSE` (Excel convention);
 * null/undefined render empty. Values containing `"`, `,`, CR, or LF are
 * double-quoted with `"` doubled.
 */
export function serializeCell(value: CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/** Serialize one row to a CSV line (no trailing newline). */
export function serializeRow(row: CellValue[]): string {
  return row.map(serializeCell).join(',');
}

/** Serialize rows to a CSV block, one LF-terminated line per row. */
export function serializeRows(rows: CellValue[][]): string {
  if (rows.length === 0) {
    return '';
  }
  return rows.map(serializeRow).join('\n') + '\n';
}
