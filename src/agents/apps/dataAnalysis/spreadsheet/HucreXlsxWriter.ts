/**
 * HucreXlsxWriter — the {@link XlsxWriter} backed by `hucre`'s round-trip API.
 *
 * Per spike S2 (docs/plans/spike-findings-hucre-2026-05-31.md): `openXlsx`
 * preserves every original ZIP part in `_rawEntries`; editing `sheet.rows[r][c]`
 * does NOT auto-mark the part dirty, so we must explicitly add the changed
 * sheet's worksheet part to `_modifiedParts`; `saveXlsx` then regenerates only
 * those parts and writes the rest (charts/images/pivots) back byte-for-byte.
 *
 * The hucre module is INJECTED (it's a vendored runtime asset, not bundled — see
 * HucreAssets), which also makes the apply orchestration unit-testable with a fake.
 *
 * ⚠️ PENDING Electron validation: the precise sheet→worksheet-part mapping
 * (`xl/worksheets/sheetN.xml` via workbook rels) is approximated here as the
 * sorted Nth worksheet part. Verify against multi-sheet real workbooks; until
 * then over-marking is safe for cross-part fidelity (charts live in separate
 * parts) but may regenerate a sibling worksheet.
 */

import type { CellValue, CellWrite, XlsxWriter } from './types';

export interface HucreRoundtripWorkbook {
  sheets: Array<{ name: string; rows: CellValue[][] }>;
  _rawEntries: Map<string, Uint8Array>;
  _modifiedParts: Set<string>;
}

export interface HucreApplyModule {
  openXlsx(bytes: Uint8Array): Promise<HucreRoundtripWorkbook>;
  saveXlsx(workbook: HucreRoundtripWorkbook): Promise<Uint8Array>;
}

export class HucreXlsxWriter implements XlsxWriter {
  constructor(private loadModule: () => Promise<HucreApplyModule>) {}

  async applyCellWrites(sourceBytes: Uint8Array, writes: CellWrite[]): Promise<Uint8Array> {
    const mod = await this.loadModule();
    const wb = await mod.openXlsx(sourceBytes);

    const indexByName = new Map(wb.sheets.map((s, i) => [s.name, i]));
    const touched = new Set<number>();

    for (const write of writes) {
      const idx = indexByName.get(write.sheet);
      if (idx === undefined) {
        continue;
      }
      const rows = wb.sheets[idx].rows;
      while (rows.length <= write.row) {
        rows.push([]);
      }
      const row = rows[write.row];
      while (row.length <= write.col) {
        row.push(null);
      }
      row[write.col] = write.value;
      touched.add(idx);
    }

    for (const idx of touched) {
      const part = HucreXlsxWriter.worksheetPart(wb, idx);
      if (part) {
        wb._modifiedParts.add(part);
      }
    }

    return mod.saveXlsx(wb);
  }

  /** Best-effort sheet-index → worksheet part path (see ⚠️ note above). */
  private static worksheetPart(wb: HucreRoundtripWorkbook, sheetIndex: number): string | null {
    const parts = [...wb._rawEntries.keys()]
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();
    return parts[sheetIndex] ?? null;
  }
}
