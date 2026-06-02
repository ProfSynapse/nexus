/**
 * SkillWriteService — vault-native disk I/O for the Skills app's CRUA writes.
 *
 * Located at: src/agents/apps/skills/services/SkillWriteService.ts
 * All I/O goes through Obsidian's {@link DataAdapter} (`vault.adapter`) so it
 * works on desktop AND mobile and can see dot/hidden paths (the sanctioned
 * `.nexus/` exception). Every path is run through {@link normalizePath}.
 *
 * The two reversibility nets (see docs/plans/skills-protocol-integration-plan.md §3/§7):
 *   - {@link archiveThenReplace} snapshots the PRIOR version of a skill's files
 *     into a co-located `_archive/<ts>/` before any overwrite (last-writer-wins).
 *   - The CRUA `is_archived` soft-delete lives in the SQLite index, NOT here.
 *
 * `yaml` is dynamically imported inside {@link composeSkillMd} so module init
 * stays mobile-safe (no Node API at import time).
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { SnapshotArchiveService } from '../../../../services/storage/SnapshotArchiveService';

export class SkillWriteService {
  /** Shared version-in-place snapshot primitive (co-located `_archive/<ts>/`). */
  private readonly snapshot: SnapshotArchiveService;

  constructor(private adapter: DataAdapter) {
    this.snapshot = new SnapshotArchiveService(adapter);
  }

  /** True only when the folder exists AND contains a SKILL.md. */
  async exists(folderPath: string): Promise<boolean> {
    const folder = normalizePath(folderPath);
    if (!(await this.adapter.exists(folder))) {
      return false;
    }
    return this.adapter.exists(normalizePath(`${folder}/SKILL.md`));
  }

  /** Read a folder's SKILL.md, or null when it is missing/unreadable. */
  async readSkillMd(folderPath: string): Promise<string | null> {
    const skillMdPath = normalizePath(`${folderPath}/SKILL.md`);
    try {
      if (!(await this.adapter.exists(skillMdPath))) {
        return null;
      }
      return await this.adapter.read(skillMdPath);
    } catch {
      return null;
    }
  }

  /**
   * Recursive mkdir. `adapter.mkdir` throws if the segment already exists, so we
   * create each missing segment in turn (the `.nexus/` write pattern).
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
   * Build a well-formed SKILL.md string: `name`/`description` frontmatter (YAML)
   * followed by the trimmed body. `yaml` is dynamically imported (mobile-safe).
   */
  async composeSkillMd(name: string, description: string, body: string): Promise<string> {
    const { stringify } = await import('yaml');
    const frontmatter = stringify({ name, description });
    return `---\n${frontmatter}---\n\n${body.trim()}\n`;
  }

  /** Write SKILL.md into a skill folder (ensures the folder exists first). */
  async writeSkill(folderPath: string, skillMdContent: string): Promise<void> {
    const folder = normalizePath(folderPath);
    await this.ensureFolder(folder);
    await this.adapter.write(normalizePath(`${folder}/SKILL.md`), skillMdContent);
  }

  /**
   * Recursively copy a skill folder's tree, SKIPPING any child whose basename
   * starts with `_` or `.` — so `_archive/` (and dotfiles) are never copied into
   * an archive snapshot or a renamed destination.
   *
   * With `opts.mirror`, the destination is made to MATCH the source: any
   * non-ignored dest child NOT present in the source is removed first, so a
   * full-folder replace (import / sync-back) doesn't leave stale resource files
   * behind. Ignored children (`_archive/`, dotfiles) at the destination are
   * always preserved. A plain (non-mirror) copy is purely additive.
   */
  async copyTree(srcFolder: string, destFolder: string, opts?: { mirror?: boolean }): Promise<void> {
    const src = normalizePath(srcFolder);
    const dest = normalizePath(destFolder);

    await this.ensureFolder(dest);

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(src);
    } catch {
      return;
    }

    if (opts?.mirror) {
      const srcFiles = new Set(
        listing.files.map((p) => SkillWriteService.basename(p)).filter((b) => !SkillWriteService.isSkipped(b))
      );
      const srcFolders = new Set(
        listing.folders.map((p) => SkillWriteService.basename(p)).filter((b) => !SkillWriteService.isSkipped(b))
      );
      await this.clearStaleChildren(dest, srcFiles, srcFolders);
    }

    for (const filePath of listing.files) {
      const base = SkillWriteService.basename(filePath);
      if (SkillWriteService.isSkipped(base)) {
        continue;
      }
      const content = await this.adapter.read(filePath);
      await this.adapter.write(normalizePath(`${dest}/${base}`), content);
    }

    for (const subFolder of listing.folders) {
      const base = SkillWriteService.basename(subFolder);
      if (SkillWriteService.isSkipped(base)) {
        continue;
      }
      await this.copyTree(subFolder, normalizePath(`${dest}/${base}`), opts);
    }
  }

  /**
   * Remove non-ignored children of `dest` that are NOT present in the given
   * source name sets — used by the `mirror` copy mode to drop stale resources.
   * Ignored children (`_`/`.`-prefixed, e.g. `_archive/`) are always preserved.
   */
  private async clearStaleChildren(
    dest: string,
    srcFiles: Set<string>,
    srcFolders: Set<string>
  ): Promise<void> {
    let destListing: { files: string[]; folders: string[] };
    try {
      destListing = await this.adapter.list(dest);
    } catch {
      return;
    }
    for (const filePath of destListing.files) {
      const base = SkillWriteService.basename(filePath);
      if (!SkillWriteService.isSkipped(base) && !srcFiles.has(base)) {
        await this.adapter.remove(filePath);
      }
    }
    for (const subFolder of destListing.folders) {
      const base = SkillWriteService.basename(subFolder);
      if (!SkillWriteService.isSkipped(base) && !srcFolders.has(base)) {
        await this.removeTree(subFolder);
      }
    }
  }

  /**
   * Snapshot the CURRENT folder into `<folderPath>/_archive/<ts>/` (only if a
   * prior SKILL.md exists), then run `write()`. Returns the archive path, or
   * null when there was no prior version to snapshot.
   *
   * The snapshot mechanics (timestamp, same-instant disambiguation, skip
   * `_`/`.`-prefixed children) live in the shared {@link SnapshotArchiveService};
   * this method only owns the skill-specific gate (a prior SKILL.md must exist).
   */
  async archiveThenReplace(folderPath: string, write: () => Promise<void>): Promise<string | null> {
    const folder = normalizePath(folderPath);

    if (!(await this.exists(folder))) {
      // No prior SKILL.md → nothing to archive, just write.
      await write();
      return null;
    }

    const archivePath = await this.snapshot.archiveCopy(folder);

    await write();
    return archivePath;
  }

  /**
   * Recursively remove a folder and all of its contents (used by rename to drop
   * the old folder after copying its resources to the new one).
   */
  async removeTree(folderPath: string): Promise<void> {
    const folder = normalizePath(folderPath);
    if (!(await this.adapter.exists(folder))) {
      return;
    }

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(folder);
    } catch {
      return;
    }

    for (const filePath of listing.files) {
      await this.adapter.remove(filePath);
    }
    for (const subFolder of listing.folders) {
      await this.removeTree(subFolder);
    }

    await this.adapter.rmdir(folder, true);
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
