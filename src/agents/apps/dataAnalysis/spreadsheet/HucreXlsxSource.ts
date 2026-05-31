/**
 * HucreXlsxSource — the {@link XlsxSource} backed by the `hucre` engine
 * (lossless xlsx round-trip; see docs/plans/spike-findings-hucre-2026-05-31.md).
 *
 * hucre is VENDORED as a runtime asset (302 KB — too big for main.js's 5MB
 * ceiling, see {@link HucreAssets}), so the module is injected via a loader
 * rather than statically imported. This keeps the value-mapping logic here pure
 * and unit-testable with a fake module, while the actual asset load is the only
 * Electron-bound piece.
 *
 * ⚠️ formula-cell detection is best-effort here and refined in the Electron pass
 * (openXlsx exposes cell-level formulas; the headless `readXlsx` returns values).
 */

import type { CellValue, ParsedSheet, ParsedWorkbook, XlsxSource } from './types';

/** The shape of one sheet as hucre's reader yields it. */
export interface HucreSheet {
  name: string;
  rows: unknown[][];
}

export interface HucreReadResult {
  sheets: HucreSheet[];
  hasMacros?: boolean;
}

/** The slice of `hucre/xlsx` we depend on (so it can be stubbed in tests). */
export interface HucreXlsxModule {
  readXlsx(bytes: Uint8Array): Promise<HucreReadResult>;
}

export class HucreXlsxSource implements XlsxSource {
  constructor(private loadModule: () => Promise<HucreXlsxModule>) {}

  async readWorkbook(bytes: Uint8Array): Promise<ParsedWorkbook> {
    const mod = await this.loadModule();
    const result = await mod.readXlsx(bytes);

    const sheets: ParsedSheet[] = result.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => row.map(toCellValue)),
      formulaCells: [],
    }));

    return {
      sheets,
      sourceHash: fnv1aHex(bytes),
      hasMacros: result.hasMacros ?? false,
    };
  }
}

/** Coerce an arbitrary reader cell into a CSV-representable {@link CellValue}. */
function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  // Unexpected object-shaped cell: serialize rather than emit "[object Object]".
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/** FNV-1a (32-bit) hex over raw bytes — fast, dependency-free content key. */
export function fnv1aHex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
