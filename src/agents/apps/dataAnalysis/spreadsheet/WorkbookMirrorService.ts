/**
 * WorkbookMirrorService — generates/refreshes the folder-per-workbook CSV mirror
 * (the AI's value surface) from a {@link ParsedWorkbook}.
 *
 * Layout (under the resolved Nexus root, synced + renameable):
 *   <root>/spreadsheets/<workbookId>/
 *     manifest.json          — sheet order, shard index (row ranges), source hash
 *     <Sheet>.part<n>.csv     — values, sharded to maxShardBytes
 *     _archive/…              — snapshots (SnapshotArchiveService, the write-back leg)
 *
 * This service is pure projection: it (re)writes the values-CSV view. It does NOT
 * touch the source `.xlsx` (that's the write-back leg) and does NOT snapshot
 * (that's `SnapshotArchiveService`). Generation is idempotent — if an existing
 * manifest's `sourceHash` matches, it's a no-op.
 *
 * All I/O goes through Obsidian's {@link DataAdapter}; every path is normalized.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { shardSheet } from './shard';
import {
  MIRROR_SCHEMA_VERSION,
  type MirrorManifest,
  type ParsedWorkbook,
  type SheetManifest,
  type ShardEntry,
} from './types';

export interface MirrorTarget {
  /** Resolved vault root, e.g. `Nexus` (from `resolveVaultRoot`). */
  root: string;
  /** Workbook id (source basename without extension), e.g. `budget`. */
  workbookId: string;
  /** Per-file byte cap (e.g. `maxShardBytes`). */
  maxShardBytes: number;
  /** Clock injection for deterministic tests. Default {@link Date.now}. */
  now?: () => number;
}

export interface MirrorResult {
  manifest: MirrorManifest;
  /** False when an existing same-hash mirror let us skip the rewrite. */
  regenerated: boolean;
}

export class WorkbookMirrorService {
  constructor(private adapter: DataAdapter) {}

  /** `<root>/spreadsheets/<workbookId>`. */
  mirrorDir(target: MirrorTarget): string {
    return normalizePath(`${target.root}/spreadsheets/${target.workbookId}`);
  }

  /** Read the existing manifest, or null when absent/unparseable. */
  async readManifest(target: MirrorTarget): Promise<MirrorManifest | null> {
    const path = normalizePath(`${this.mirrorDir(target)}/manifest.json`);
    try {
      if (!(await this.adapter.exists(path))) {
        return null;
      }
      return JSON.parse(await this.adapter.read(path)) as MirrorManifest;
    } catch {
      return null;
    }
  }

  /**
   * Generate (or refresh) the mirror. Idempotent: an existing manifest with the
   * same `sourceHash` short-circuits to `regenerated: false`.
   */
  async generate(workbook: ParsedWorkbook, target: MirrorTarget): Promise<MirrorResult> {
    const existing = await this.readManifest(target);
    if (existing && existing.sourceHash === workbook.sourceHash) {
      return { manifest: existing, regenerated: false };
    }

    const dir = this.mirrorDir(target);
    await this.ensureFolder(dir);
    await this.clearShardCsvs(dir);

    const usedNames = new Set<string>();
    const sheets: SheetManifest[] = [];

    for (let order = 0; order < workbook.sheets.length; order++) {
      const sheet = workbook.sheets[order];
      const base = this.uniqueBase(sheet.name, order, usedNames);
      const colCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);

      const shards = shardSheet(sheet.rows, target.maxShardBytes);
      const shardEntries: ShardEntry[] = [];
      for (let part = 0; part < shards.length; part++) {
        const file = `${base}.part${part}.csv`;
        await this.adapter.write(normalizePath(`${dir}/${file}`), shards[part].csv);
        shardEntries.push({
          file,
          startRow: shards[part].startRow,
          endRow: shards[part].endRow,
          bytes: shards[part].bytes,
        });
      }

      sheets.push({
        name: sheet.name,
        order,
        rowCount: sheet.rows.length,
        colCount,
        shards: shardEntries,
        formulaCells: sheet.formulaCells ?? [],
      });
    }

    const manifest: MirrorManifest = {
      schemaVersion: MIRROR_SCHEMA_VERSION,
      workbook: target.workbookId,
      sourceHash: workbook.sourceHash,
      hasMacros: workbook.hasMacros ?? false,
      generatedAt: new Date((target.now ?? Date.now)()).toISOString(),
      maxShardBytes: target.maxShardBytes,
      sheets,
    };
    await this.adapter.write(
      normalizePath(`${dir}/manifest.json`),
      JSON.stringify(manifest, null, 2)
    );

    return { manifest, regenerated: true };
  }

  /** Recursive mkdir (each missing segment in turn — the `vault.adapter` pattern). */
  private async ensureFolder(path: string): Promise<void> {
    const segments = normalizePath(path).split('/').filter((s) => s.length > 0);
    let current = '';
    for (const segment of segments) {
      current = current.length > 0 ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) {
        await this.adapter.mkdir(current);
      }
    }
  }

  /**
   * Remove the immediate `.csv` + `manifest.json` files of a prior generation so
   * a refresh leaves no stale shards. Subfolders (notably `_archive/`) are left
   * untouched.
   */
  private async clearShardCsvs(dir: string): Promise<void> {
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(dir);
    } catch {
      return;
    }
    for (const filePath of listing.files) {
      if (/\.csv$/.test(filePath) || /\/manifest\.json$/.test(filePath)) {
        await this.adapter.remove(filePath);
      }
    }
  }

  /**
   * Filesystem-safe, collision-free basename for a sheet. Sheet names can hold
   * characters illegal in filenames or collapse to the same slug, so we sanitize
   * and disambiguate with the sheet's order.
   */
  private uniqueBase(sheetName: string, order: number, used: Set<string>): string {
    const sanitized = sheetName.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    let base = sanitized.length > 0 ? sanitized : `sheet${order}`;
    if (used.has(base.toLowerCase())) {
      base = `${base}-${order}`;
    }
    used.add(base.toLowerCase());
    return base;
  }
}
