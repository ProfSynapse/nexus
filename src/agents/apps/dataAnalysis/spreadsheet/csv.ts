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

/**
 * Serialize an arbitrary JSON-ish analysis result to CSV. Accepts an array of
 * rows (`unknown[][]`), an array of records (`Record[]` — columns are the union
 * of keys, first-seen order), or an array of scalars (single column). Throws on
 * a non-array result (a scalar/object can't be a table).
 */
export function dataToCsv(data: unknown): string {
  if (!Array.isArray(data)) {
    throw new Error('CSV output requires a list of rows (arrays) or records (objects).');
  }
  if (data.length === 0) {
    return '';
  }
  if (Array.isArray(data[0])) {
    return serializeRows((data as unknown[][]).map((row) => row.map(toCsvCell)));
  }
  if (isRecord(data[0])) {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const rec of data as Record<string, unknown>[]) {
      for (const key of Object.keys(rec)) {
        if (!seen.has(key)) {
          seen.add(key);
          cols.push(key);
        }
      }
    }
    const rows: CellValue[][] = [cols];
    for (const rec of data as Record<string, unknown>[]) {
      rows.push(cols.map((col) => toCsvCell(rec[col])));
    }
    return serializeRows(rows);
  }
  return serializeRows((data as unknown[]).map((value) => [toCsvCell(value)]));
}

function toCsvCell(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
