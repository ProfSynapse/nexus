/**
 * Shared shape of the `hucre/xlsx` round-trip module used by both the reader
 * (HucreXlsxSource) and the writer (HucreXlsxWriter). hucre is loaded as a
 * vendored runtime asset (see HucreEnsurer), so the module is injected.
 *
 * Matches the API verified in spike S2 (openXlsx → RoundtripWorkbook with
 * `_rawEntries`/`_modifiedParts`; saveXlsx preserves unmodified parts).
 */

import type { CellValue } from './types';

export interface HucreRoundtripWorkbook {
  sheets: Array<{ name: string; rows: CellValue[][] }>;
  /** Every original ZIP part, keyed by path (charts/images/pivots ride here). */
  _rawEntries: Map<string, Uint8Array>;
  /** Parts to regenerate on save; cell edits must add the sheet's part here. */
  _modifiedParts: Set<string>;
  /** True when the source carries VBA macros (xl/vbaProject.bin → `.xlsm`). */
  hasMacros?: boolean;
}

export interface HucreModule {
  openXlsx(bytes: Uint8Array): Promise<HucreRoundtripWorkbook>;
  saveXlsx(workbook: HucreRoundtripWorkbook): Promise<Uint8Array>;
}
