/**
 * SkillSyncService — provider-dotfolder import + sync-back for the Skills app.
 *
 * Located at: src/agents/apps/skills/services/SkillSyncService.ts
 * Discovers provider dotfolders at the VAULT ROOT (`<vault>/.<provider>/skills/<name>/`),
 * IMPORTS them into the in-vault mirror (`<skillsRoot>/<provider>/<name>/`), and
 * SYNCS-BACK edited mirror copies to their origin dotfolders. All I/O goes through
 * Obsidian's {@link DataAdapter} (`vault.adapter`) so it works on desktop AND mobile
 * and can see dot/hidden paths (the sanctioned `.nexus/` exception).
 *
 * Reversibility net (see docs/plans/skills-protocol-integration-plan.md §3):
 *   - Every overwrite goes through {@link SkillWriteService.archiveThenReplace},
 *     snapshotting the PRIOR version into a co-located `_archive/<ts>/`.
 *   - Last-writer-wins; a `content_hash` (FNV-1a of SKILL.md) only skips identical writes.
 *
 * Vault-native skills (provider `nexus`, no `originPath`) are NEVER synced back.
 */

import { normalizePath } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { SkillWriteService } from './SkillWriteService';
import type { SkillIndexService } from './SkillIndexService';
import { hashSkillContent } from './skillHash';
import { parseSkillFrontmatter } from './skillFrontmatter';
import { assertInside, isSafePathSegment } from './skillPaths';
import type { SkillRecord } from '../types';

export interface ImportResult {
  imported: string[];
  skipped: string[];
  archived: string[];
}

export interface SyncBackResult {
  syncedBack: string[];
  skipped: string[];
  archived: string[];
}

export class SkillSyncService {
  private readonly write: SkillWriteService;

  constructor(
    private adapter: DataAdapter,
    /** Resolved `<root>/skills` mirror root. */
    private skillsRoot: string,
    private index: SkillIndexService
  ) {
    this.write = new SkillWriteService(adapter);
  }

  /**
   * Discover provider ids from the vault root. A folder is a provider IFF its
   * basename starts with `.`, contains a `skills/` subfolder, and that subfolder
   * has at least one `<name>/SKILL.md` child. Returns provider ids (dot stripped),
   * sorted. Every adapter call is guarded so one unreadable dotfolder can't abort
   * the whole discovery.
   */
  async discoverProviders(): Promise<string[]> {
    const providers: string[] = [];

    const rootListing = await this.listVaultRoot();
    const rootFolders = rootListing.folders;

    for (const dotPath of rootFolders) {
      const base = SkillSyncService.basename(dotPath);
      if (!base.startsWith('.')) {
        continue;
      }
      const provider = base.slice(1);
      // Reject empty + traversal-unsafe provider ids: the provider becomes a
      // path segment in BOTH the mirror write path and the sync-back origin
      // path, so a `..`/separator-bearing id must never flow through.
      if (provider.length === 0 || !isSafePathSegment(provider)) {
        continue;
      }

      try {
        const skillsDir = normalizePath(`${base}/skills`);
        if (!(await this.adapter.exists(skillsDir))) {
          continue;
        }
        const skillsListing = await this.adapter.list(skillsDir);
        let hasSkill = false;
        for (const skillFolder of skillsListing.folders) {
          const skillMd = normalizePath(`${skillFolder}/SKILL.md`);
          try {
            if (await this.adapter.exists(skillMd)) {
              hasSkill = true;
              break;
            }
          } catch {
            // Skip an unreadable candidate skill folder.
          }
        }
        if (hasSkill) {
          providers.push(provider);
        }
      } catch {
        // A single unreadable dotfolder must not abort discovery.
      }
    }

    providers.sort();
    return providers;
  }

  /**
   * Import provider skills into the mirror. For each discovered provider (or just
   * `providerFilter`), copy every `.<provider>/skills/<name>/` folder that has a
   * SKILL.md into `<skillsRoot>/<provider>/<name>/`. Skips writes whose source
   * SKILL.md hash already matches the mirror. Archives the prior mirror version
   * on every real overwrite. Upserts the index row (with `originPath` set).
   */
  async import(providerFilter?: string): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], archived: [] };

    // A caller-supplied provider filter is model/UI-influenced — reject unsafe
    // ids rather than letting them build a `.${provider}/skills` path.
    if (providerFilter && !isSafePathSegment(providerFilter)) {
      result.skipped.push(`${providerFilter} (invalid provider id)`);
      return result;
    }
    const providers = providerFilter ? [providerFilter] : await this.discoverProviders();

    for (const provider of providers) {
      const providerSkillsDir = normalizePath(`.${provider}/skills`);

      let skillFolders: string[];
      try {
        if (!(await this.adapter.exists(providerSkillsDir))) {
          continue;
        }
        const listing = await this.adapter.list(providerSkillsDir);
        skillFolders = listing.folders;
      } catch {
        continue;
      }

      for (const skillFolderPath of skillFolders) {
        const name = SkillSyncService.basename(skillFolderPath);
        if (SkillSyncService.isIgnored(name) || !isSafePathSegment(name)) {
          continue;
        }

        const sourceFolder = normalizePath(`.${provider}/skills/${name}`);
        const mirrorFolder = normalizePath(`${this.skillsRoot}/${provider}/${name}`);

        try {
          // Containment guards (belt-and-braces over the segment checks above):
          // the source must stay inside the provider's skills dir and the mirror
          // inside the skills root. A throw here is caught below and skips the
          // skill rather than writing outside the intended trees.
          assertInside(`.${provider}/skills`, sourceFolder);
          assertInside(this.skillsRoot, mirrorFolder);

          const content = await this.write.readSkillMd(sourceFolder);
          if (content === null) {
            // Folder without a SKILL.md is not a skill — skip.
            continue;
          }
          const srcHash = hashSkillContent(content);

          // Skip identical writes (§3): mirror already has the same SKILL.md.
          const mirrorContent = await this.write.readSkillMd(mirrorFolder);
          if (mirrorContent !== null && hashSkillContent(mirrorContent) === srcHash) {
            result.skipped.push(`${provider}/${name} (unchanged)`);
            continue;
          }

          const archived = await this.write.archiveThenReplace(mirrorFolder, async () => {
            await this.write.copyTree(sourceFolder, mirrorFolder, { mirror: true });
          });
          if (archived !== null) {
            result.archived.push(archived);
          }

          const fm = await parseSkillFrontmatter(content);
          const description =
            typeof fm.description === 'string' && fm.description.trim().length > 0
              ? fm.description.trim()
              : name;

          await this.index.upsertOne({
            provider,
            name,
            description,
            vaultPath: mirrorFolder,
            originPath: sourceFolder,
            contentHash: srcHash,
          });

          result.imported.push(`${provider}/${name}`);
        } catch (error) {
          // A single unreadable / unwritable / out-of-bounds skill folder must
          // not abort import — but surface it (don't swallow silently).
          const message = error instanceof Error ? error.message : String(error);
          result.skipped.push(`${provider}/${name} (import failed: ${message})`);
          continue;
        }
      }
    }

    return result;
  }

  /**
   * Sync edited mirror skills back to their origin dotfolders. Iterates every
   * indexed skill (including archived) that has an `originPath`, optionally
   * scoped to `providerFilter`. Loops over {@link syncBackOne}.
   */
  async syncBack(providerFilter?: string): Promise<SyncBackResult> {
    const result: SyncBackResult = { syncedBack: [], skipped: [], archived: [] };

    const records = await this.index.list({ includeArchived: true });
    for (const record of records) {
      if (!record.originPath) {
        continue;
      }
      if (providerFilter && record.provider !== providerFilter) {
        continue;
      }

      const label = `${record.provider}/${record.name}`;
      try {
        const outcome = await this.syncBackOneDetailed(record);
        if (outcome.skipped) {
          result.skipped.push(`${label} (unchanged)`);
          continue;
        }
        if (outcome.archived !== null) {
          result.archived.push(outcome.archived);
        }
        if (outcome.synced) {
          result.syncedBack.push(label);
        }
      } catch (error) {
        // A single failing sync-back must not abort the rest — but surface it.
        const message = error instanceof Error ? error.message : String(error);
        result.skipped.push(`${label} (sync-back failed: ${message})`);
        continue;
      }
    }

    return result;
  }

  /**
   * Sync-back for ONE record (used by updateSkill). Returns the origin folder
   * path when written, or null when skipped / no-origin / mirror-missing.
   */
  async syncBackOne(record: SkillRecord): Promise<string | null> {
    const outcome = await this.syncBackOneDetailed(record);
    return outcome.synced ? record.originPath ?? null : null;
  }

  /** Shared per-record sync-back used by both syncBack() and syncBackOne(). */
  private async syncBackOneDetailed(
    record: SkillRecord
  ): Promise<{ synced: boolean; skipped: boolean; archived: string | null }> {
    if (!record.originPath) {
      return { synced: false, skipped: false, archived: null };
    }

    // Containment: the origin we write back to MUST stay inside this provider's
    // `.<provider>/skills` tree, and the mirror we read from inside the skills
    // root. A poisoned `originPath` (e.g. a `..`-bearing value persisted by an
    // older build) must never let sync-back overwrite arbitrary files. Throw on
    // violation — the per-record caller catches it and records the failure.
    if (!isSafePathSegment(record.provider)) {
      throw new Error(`Refusing to sync back: unsafe provider id "${record.provider}"`);
    }
    const mirrorFolder = assertInside(this.skillsRoot, record.vaultPath);
    const originFolder = assertInside(`.${record.provider}/skills`, record.originPath);

    const mirrorContent = await this.write.readSkillMd(mirrorFolder);
    if (mirrorContent === null) {
      // Nothing to push back.
      return { synced: false, skipped: false, archived: null };
    }
    const mirrorHash = hashSkillContent(mirrorContent);

    const originContent = await this.write.readSkillMd(originFolder);
    if (originContent !== null && hashSkillContent(originContent) === mirrorHash) {
      return { synced: false, skipped: true, archived: null };
    }

    const archived = await this.write.archiveThenReplace(originFolder, async () => {
      await this.write.copyTree(mirrorFolder, originFolder, { mirror: true });
    });

    return { synced: true, skipped: false, archived };
  }

  /**
   * List the vault root, robustly across adapters. Obsidian's desktop
   * FileSystemAdapter lists the root for `''`; mobile CapacitorAdapter behavior
   * for the empty string is less certain, so we fall back to `'/'`. Every call
   * is guarded — a failure yields an empty listing (discovery finds nothing)
   * rather than throwing. NOTE: mobile provider discovery is worth a manual
   * smoke check — see docs/plans/skills-protocol-integration-plan.md.
   */
  private async listVaultRoot(): Promise<{ files: string[]; folders: string[] }> {
    for (const root of ['', '/']) {
      try {
        const listing = await this.adapter.list(root);
        if (listing && (listing.folders.length > 0 || listing.files.length > 0)) {
          return listing;
        }
      } catch {
        // Try the next root form.
      }
    }
    return { files: [], folders: [] };
  }

  /** Basename of a vault-relative path (handles trailing slash). */
  private static basename(path: string): string {
    const trimmed = path.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
  }

  /** Ignore `_`-prefixed (e.g. `_archive`) and `.`-prefixed entries. */
  private static isIgnored(basename: string): boolean {
    return basename.startsWith('_') || basename.startsWith('.');
  }
}
