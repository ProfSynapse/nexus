/**
 * HucreXlsxSource — the {@link XlsxSource} backed by the `hucre` engine
 * (lossless xlsx round-trip; see docs/plans/spike-findings-hucre-2026-05-31.md).
 *
 * Reads via `openXlsx` (the same RoundtripWorkbook the writer uses) so we get
 * both the cell VALUES (for the CSV projection) and the raw worksheet XML — the
 * latter lets us detect FORMULA cells (`<c r="B2"><f>…`) so the write-back's
 * formula-cell guard is active. hucre is injected (it's a vendored runtime asset,
 * not bundled — see HucreAssets), which also keeps this logic unit-testable.
 *
 * ⚠️ PENDING Electron validation: the sheet-index → worksheet-part mapping is the
 * sorted-Nth `xl/worksheets/sheetN.xml` approximation (precise mapping is via
 * workbook rels). Verify against multi-sheet real workbooks.
 */

import type { HucreModule } from './HucreModule';
import type { CellValue, ParsedSheet, ParsedWorkbook, XlsxSource } from './types';

export class HucreXlsxSource implements XlsxSource {
  constructor(private loadModule: () => Promise<HucreModule>) {}

  async readWorkbook(bytes: Uint8Array): Promise<ParsedWorkbook> {
    const mod = await this.loadModule();
    const wb = await mod.openXlsx(bytes);

    const worksheetParts = [...wb._rawEntries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();

    const sheets: ParsedSheet[] = wb.sheets.map((sheet, index) => {
      const part = worksheetParts[index];
      const xml = part ? wb._rawEntries.get(part) : undefined;
      return {
        name: sheet.name,
        rows: sheet.rows.map((row) => row.map(toCellValue)),
        formulaCells: xml ? formulaCellsFromXml(decodeUtf8(xml)) : [],
      };
    });

    return {
      sheets,
      sourceHash: fnv1aHex(bytes),
      hasMacros: wb.hasMacros ?? false,
    };
  }
}

/** A1 refs of cells holding a formula (`<c r="B2" …><f>…`). */
export function formulaCellsFromXml(xml: string): string[] {
  const refs: string[] = [];
  const re = /<c\b[^>]*\br="([A-Z]+\d+)"[^>]*>\s*<f[\s>/]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
