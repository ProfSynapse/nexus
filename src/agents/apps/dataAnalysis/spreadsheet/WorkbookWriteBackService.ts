/**
 * WorkbookWriteBackService — the lossless write-back leg (Phase 2).
 *
 * Flow (see docs/plans/spreadsheet-mirror-versioning-plan.md §3.6):
 *   1. read the ORIGINAL workbook values from the source `.xlsx`
 *   2. divergence guard — refuse if the source changed since the mirror was made
 *   3. parse the EDITED CSV shards, diff vs original → changed data cells
 *   4. formula-cell guard — never clobber a live formula
 *   5. dryRun / no-op → return the summary without writing
 *   6. snapshot the prior CSV shards (value-level restore point)
 *   7. hucre-apply the changed cells → new `.xlsx` bytes (charts preserved)
 *   8. re-project the mirror from the updated workbook
 *
 * The actual binary write of the new `.xlsx` to the vault is the caller's job
 * (Electron `vault.adapter.writeBinary`); this service returns the new bytes.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { parseCsv } from './csv';
import { coerceToOriginalType, diffSheet, partitionByFormula, type CellEdit } from './diff';
import type { SnapshotArchiveService } from '../../../../services/storage/SnapshotArchiveService';
import type { MirrorTarget, WorkbookMirrorService } from './WorkbookMirrorService';
import type { CellValue, CellWrite, MirrorManifest, SheetManifest, XlsxSource, XlsxWriter } from './types';

export interface WriteBackOptions {
  /** Compute + return the summary without writing anything. */
  dryRun?: boolean;
  /** Proceed even if the source `.xlsx` diverged from the mirror. */
  force?: boolean;
}

export interface SheetChangeSummary {
  sheet: string;
  applied: number;
  /** A1 refs of edits skipped because they targeted a formula cell. */
  blockedFormulaCells: string[];
  samples: Array<{ a1: string; before: string; after: string }>;
}

export interface WriteBackSummary {
  sheetsChanged: number;
  cellsApplied: number;
  cellsBlocked: number;
  sheets: SheetChangeSummary[];
}

export type WriteBackReason = 'no-mirror' | 'divergence' | 'dry-run' | 'no-changes' | 'applied';

export interface WriteBackResult {
  summary: WriteBackSummary;
  applied: boolean;
  reason: WriteBackReason;
  archivePath?: string | null;
  newBytes?: Uint8Array;
  newSourceHash?: string;
}

const EMPTY_SUMMARY: WriteBackSummary = { sheetsChanged: 0, cellsApplied: 0, cellsBlocked: 0, sheets: [] };

export class WorkbookWriteBackService {
  constructor(
    private adapter: DataAdapter,
    private xlsxSource: XlsxSource,
    private xlsxWriter: XlsxWriter,
    private mirror: WorkbookMirrorService,
    private snapshot: SnapshotArchiveService
  ) {}

  async apply(
    target: MirrorTarget,
    sourceBytes: Uint8Array,
    options: WriteBackOptions = {}
  ): Promise<WriteBackResult> {
    const manifest = await this.mirror.readManifest(target);
    if (!manifest) {
      return { summary: EMPTY_SUMMARY, applied: false, reason: 'no-mirror' };
    }

    const original = await this.xlsxSource.readWorkbook(sourceBytes);
    if (!options.force && original.sourceHash !== manifest.sourceHash) {
      return { summary: EMPTY_SUMMARY, applied: false, reason: 'divergence' };
    }

    const { summary, writes } = await this.plan(target, manifest, original);

    if (options.dryRun) {
      return { summary, applied: false, reason: 'dry-run' };
    }
    if (writes.length === 0) {
      return { summary, applied: false, reason: 'no-changes' };
    }

    const archivePath = await this.snapshot.archiveCopy(this.mirror.mirrorDir(target));
    const newBytes = await this.xlsxWriter.applyCellWrites(sourceBytes, writes);

    // Re-project the mirror from the updated workbook (new sourceHash → rewrite).
    const updated = await this.xlsxSource.readWorkbook(newBytes);
    await this.mirror.generate(updated, target);

    return {
      summary,
      applied: true,
      reason: 'applied',
      archivePath,
      newBytes,
      newSourceHash: updated.sourceHash,
    };
  }

  /** Diff every sheet's edited shards vs the original; apply the formula guard. */
  private async plan(
    target: MirrorTarget,
    manifest: MirrorManifest,
    original: { sheets: Array<{ name: string; rows: CellValue[][] }> }
  ): Promise<{ summary: WriteBackSummary; writes: CellWrite[] }> {
    const dir = this.mirror.mirrorDir(target);
    const sheets: SheetChangeSummary[] = [];
    const writes: CellWrite[] = [];
    let cellsBlocked = 0;

    for (const sheetManifest of manifest.sheets) {
      const editedRows = await this.readEditedSheet(dir, sheetManifest);
      const originalRows = original.sheets.find((s) => s.name === sheetManifest.name)?.rows ?? [];

      const edits = diffSheet(sheetManifest.name, originalRows, editedRows);
      const { applied, blocked } = partitionByFormula(edits, new Set(sheetManifest.formulaCells));

      for (const edit of applied) {
        const originalCell = originalRows[edit.row]?.[edit.col] ?? null;
        writes.push({
          sheet: sheetManifest.name,
          row: edit.row,
          col: edit.col,
          value: coerceToOriginalType(originalCell, edit.after),
        });
      }

      cellsBlocked += blocked.length;
      sheets.push({
        sheet: sheetManifest.name,
        applied: applied.length,
        blockedFormulaCells: blocked.map((b) => b.a1),
        samples: applied.slice(0, 5).map((e: CellEdit) => ({ a1: e.a1, before: e.before, after: e.after })),
      });
    }

    return {
      summary: {
        sheetsChanged: sheets.filter((s) => s.applied > 0).length,
        cellsApplied: writes.length,
        cellsBlocked,
        sheets,
      },
      writes,
    };
  }

  /** Reassemble a sheet's edited rows by parsing its shards in manifest order. */
  private async readEditedSheet(dir: string, sheet: SheetManifest): Promise<string[][]> {
    const rows: string[][] = [];
    for (const shard of sheet.shards) {
      const path = normalizePath(`${dir}/${shard.file}`);
      let text: string;
      try {
        text = await this.adapter.read(path);
      } catch {
        continue;
      }
      for (const row of parseCsv(text)) {
        rows.push(row);
      }
    }
    return rows;
  }
}
