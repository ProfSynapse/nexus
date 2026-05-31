/**
 * Shared types for the spreadsheet mirror + versioning subsystem.
 * See docs/plans/spreadsheet-mirror-versioning-plan.md.
 *
 * The mirror is a PROJECTION of a workbook: values-only CSV shards the AI edits,
 * with the original `.xlsx` retained as the source of truth (formula/format/chart
 * store). These types describe the parsed workbook (engine-agnostic) and the
 * on-disk manifest that indexes the shards.
 */

/** A single CSV-representable cell value. Formulas are surfaced as their cached value. */
export type CellValue = string | number | boolean | null;

export interface ParsedSheet {
  name: string;
  /** Row-major grid of cached values. */
  rows: CellValue[][];
  /**
   * A1-style refs of cells that hold a formula in the source workbook. The CSV
   * shows the cached value; these are flagged so a consumer knows to recompute
   * from inputs rather than trust a possibly-stale cached number, and so the
   * write-back's formula-cell guard can avoid clobbering them.
   */
  formulaCells?: string[];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
  /** Content hash of the source `.xlsx` bytes — divergence + idempotency key. */
  sourceHash: string;
  /** True when the source carries VBA macros (write-back must keep `.xlsm`). */
  hasMacros?: boolean;
}

/** Engine seam: reads source `.xlsx` bytes into a {@link ParsedWorkbook}. */
export interface XlsxSource {
  readWorkbook(bytes: Uint8Array): Promise<ParsedWorkbook>;
}

/** A single cell to write back into the source workbook. */
export interface CellWrite {
  sheet: string;
  /** 0-based row. */
  row: number;
  /** 0-based column. */
  col: number;
  value: CellValue;
}

/**
 * Engine seam: applies cell writes into the source `.xlsx` bytes and returns the
 * new bytes, preserving every untouched part (charts/images/pivots) byte-for-byte.
 * Backed by `hucre` in production (see `HucreXlsxWriter`).
 */
export interface XlsxWriter {
  applyCellWrites(sourceBytes: Uint8Array, writes: CellWrite[]): Promise<Uint8Array>;
}

export const MIRROR_SCHEMA_VERSION = 1;

/** One CSV shard of a sheet, sized to stay under `maxShardBytes`. */
export interface ShardEntry {
  /** Basename within the mirror folder, e.g. `Sheet1.part0.csv`. */
  file: string;
  /** 0-based inclusive first source row in this shard. */
  startRow: number;
  /** 0-based exclusive last source row in this shard. */
  endRow: number;
  /** UTF-8 byte length of the shard's CSV. */
  bytes: number;
}

export interface SheetManifest {
  name: string;
  /** Position in the workbook (CSV files are an unordered set; this restores order). */
  order: number;
  rowCount: number;
  colCount: number;
  shards: ShardEntry[];
  /** A1 refs of formula cells (see {@link ParsedSheet.formulaCells}). */
  formulaCells: string[];
}

export interface MirrorManifest {
  schemaVersion: number;
  /** Workbook id (basename), e.g. `budget`. */
  workbook: string;
  sourceHash: string;
  hasMacros: boolean;
  generatedAt: string;
  maxShardBytes: number;
  sheets: SheetManifest[];
}
