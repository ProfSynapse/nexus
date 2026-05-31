/**
 * SnapshotArchiveService — the generic "version-in-place" snapshot primitive.
 *
 * Location: src/services/storage/SnapshotArchiveService.ts
 *
 * Before overwriting a folder's contents, snapshot the CURRENT tree into a
 * co-located, timestamped `<folder>/<archiveDir>/<ts>/` so the prior version is
 * recoverable (last-writer-wins with an undo net). This is the reusable form of
 * the pattern first written inline for the Skills app
 * (`SkillWriteService.archiveThenReplace`) and now shared by the
 * spreadsheet-mirror versioning layer (its second consumer).
 *
 * NOT to be confused with the two OTHER "archive" flavors in the codebase:
 *   - the soft `is_archived` flag (states/tasks/skills) — a reversible *status*,
 *     not a file snapshot;
 *   - `StorageManager.archive` — *relocates* (moves) a file/folder to
 *     `.archive/<ts>/`, not version-in-place.
 *
 * All I/O goes through Obsidian's {@link DataAdapter} (`vault.adapter`) so it
 * works on desktop AND mobile and can see dot/hidden paths. Every path is run
 * through {@link normalizePath}.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';

export interface SnapshotArchiveOptions {
  /** Subfolder under the target that holds snapshots. Default `_archive`. */
  archiveDirName?: string;
  /** Clock injection point for deterministic tests. Default {@link Date.now}. */
  now?: () => number;
}

export class SnapshotArchiveService {
  private readonly archiveDirName: string;
  private readonly now: () => number;

  constructor(private adapter: DataAdapter, options: SnapshotArchiveOptions = {}) {
    this.archiveDirName = options.archiveDirName ?? '_archive';
    this.now = options.now ?? Date.now;
  }

  /**
   * Snapshot `folderPath`'s current tree into
   * `<folderPath>/<archiveDirName>/<ts>[-n]/` and return that archive path.
   *
   * `<ts>` is an ISO-8601 instant with `:`/`.` replaced by `-`; same-instant
   * collisions get a `-1`, `-2`, … suffix so a second snapshot in the same
   * millisecond never clobbers the first. Children whose basename starts with
   * `_` or `.` are skipped, so the archive folder never recursively archives
   * itself and dotfiles are left out.
   *
   * The caller decides WHETHER a prior version is worth snapshotting; this just
   * performs the copy.
   */
  async archiveCopy(folderPath: string): Promise<string> {
    const folder = normalizePath(folderPath);
    const ts = new Date(this.now()).toISOString().replace(/[:.]/g, '-');

    let archivePath = normalizePath(`${folder}/${this.archiveDirName}/${ts}`);
    let suffix = 1;
    while (await this.adapter.exists(archivePath)) {
      archivePath = normalizePath(`${folder}/${this.archiveDirName}/${ts}-${suffix}`);
      suffix += 1;
    }

    await this.copyTree(folder, archivePath);
    return archivePath;
  }

  /**
   * Recursive mkdir. `adapter.mkdir` throws if a segment already exists, so each
   * missing segment is created in turn (the `vault.adapter` write pattern).
   */
  async ensureFolder(path: string): Promise<void> {
    const normalized = normalizePath(path);
    const segments = normalized.split('/').filter((s) => s.length > 0);
    let current = '';
    for (const segment of segments) {
      current = current.length > 0 ? `${current}/${segment}` : segment;
      if (!(await this.adapter.exists(current))) {
        await this.adapter.mkdir(current);
      }
    }
  }

  /**
   * Recursively copy a folder's tree (purely additive), SKIPPING any child whose
   * basename starts with `_` or `.` — so `_archive/` (and dotfiles) are never
   * pulled into a snapshot.
   */
  async copyTree(srcFolder: string, destFolder: string): Promise<void> {
    const src = normalizePath(srcFolder);
    const dest = normalizePath(destFolder);

    await this.ensureFolder(dest);

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(src);
    } catch {
      return;
    }

    for (const filePath of listing.files) {
      const base = SnapshotArchiveService.basename(filePath);
      if (SnapshotArchiveService.isSkipped(base)) {
        continue;
      }
      const content = await this.adapter.read(filePath);
      await this.adapter.write(normalizePath(`${dest}/${base}`), content);
    }

    for (const subFolder of listing.folders) {
      const base = SnapshotArchiveService.basename(subFolder);
      if (SnapshotArchiveService.isSkipped(base)) {
        continue;
      }
      await this.copyTree(subFolder, normalizePath(`${dest}/${base}`));
    }
  }

  /** Basename of a vault-relative path (handles trailing slash). */
  private static basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  }

  /** Skip `_`-prefixed (e.g. `_archive`) and `.`-prefixed children. */
  private static isSkipped(basename: string): boolean {
    return basename.startsWith('_') || basename.startsWith('.');
  }
}
