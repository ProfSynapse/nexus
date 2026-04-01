/**
 * Location: src/agents/ingestManager/tools/services/SpreadsheetExtractionService.ts
 * Purpose: Extract sheet data from XLSX workbooks into Markdown-friendly rows.
 *
 * Used by: IngestionPipelineService
 * Dependencies: xlsx
 */

import * as XLSX from 'xlsx';
import { SpreadsheetSheetContent } from '../../types';

export const MAX_SHEET_COLUMNS = 50;
export const MAX_SHEET_ROWS = 1500;

/**
 * Extract all sheets from an XLSX workbook into row arrays suitable for Markdown rendering.
 */
export function extractSpreadsheetSheets(workbookData: ArrayBuffer): SpreadsheetSheetContent[] {
  const workbook = XLSX.read(workbookData, {
    type: 'array',
    cellDates: true,
    raw: false
  });

  return workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false
    });

    const normalizedRows = normalizeRows(rows);
    const totalRows = normalizedRows.length;
    const totalColumns = normalizedRows.reduce(
      (maxColumns, row) => Math.max(maxColumns, row.length),
      0
    );

    return {
      sheetName,
      rows: normalizedRows,
      totalRows,
      totalColumns
    };
  });
}

function normalizeRows(rows: unknown[][]): string[][] {
  const normalized = rows.map((row) => {
    const normalizedRow = row.map(cell => normalizeCell(cell));

    let lastNonEmptyIndex = normalizedRow.length - 1;
    while (lastNonEmptyIndex >= 0 && normalizedRow[lastNonEmptyIndex] === '') {
      lastNonEmptyIndex -= 1;
    }

    return normalizedRow.slice(0, lastNonEmptyIndex + 1);
  });

  let lastContentRowIndex = normalized.length - 1;
  while (lastContentRowIndex >= 0 && normalized[lastContentRowIndex].length === 0) {
    lastContentRowIndex -= 1;
  }

  return normalized.slice(0, lastContentRowIndex + 1);
}

function normalizeCell(cell: unknown): string {
  if (cell === null || cell === undefined) {
    return '';
  }

  if (typeof cell === 'string') {
    return cell;
  }

  if (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'bigint') {
    return String(cell);
  }

  if (typeof cell === 'symbol') {
    return cell.description ?? 'Symbol';
  }

  if (cell instanceof Date) {
    return cell.toISOString();
  }

  if (typeof cell === 'object') {
    try {
      return JSON.stringify(cell);
    } catch {
      return '[Object]';
    }
  }

  return '[Unsupported value]';
}
