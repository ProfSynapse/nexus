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
 * The UNQUOTED string form of a cell — booleans as `TRUE`/`FALSE`, null/undefined
 * as empty. This is the canonical form used to COMPARE an original cell against
 * an edited CSV field (the CSV parser yields already-unquoted strings).
 */
export function cellToRaw(value: CellValue): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
}

/**
 * Serialize one cell to its CSV field form. Values containing `"`, `,`, CR, or
 * LF are double-quoted with `"` doubled.
 */
export function serializeCell(value: CellValue): string {
  const raw = cellToRaw(value);
  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Parse a CSV block into a grid of (unquoted) string fields — RFC-4180:
 * `""` is an escaped quote inside a quoted field, and quoted fields may contain
 * commas and newlines. Tolerates CRLF. A trailing newline does not produce a
 * spurious empty row; a fully empty input yields no rows.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawField = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      sawField = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      sawField = true;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawField = false;
    } else if (c === '\r') {
      // tolerate CRLF — the \n handles the row break
    } else {
      field += c;
      sawField = true;
    }
  }

  if (sawField || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
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
