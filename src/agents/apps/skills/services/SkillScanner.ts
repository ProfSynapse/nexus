import type { DataAdapter } from 'obsidian';
import type { ParsedSkillFolder } from '../types';
import { hashSkillContent } from './skillHash';
import { parseSkillFrontmatter } from './skillFrontmatter';
import { isSafePathSegment } from './skillPaths';

// Re-exported so callers can import the parsed-folder shape alongside the scanner.
export type { ParsedSkillFolder };

/**
 * Walks the in-vault MIRROR tree `<skillsRoot>/<provider>/<name>/SKILL.md` and returns parsed
 * skill metadata. Reads exclusively through Obsidian's {@link DataAdapter} (`vault.adapter`) so it
 * works on desktop AND mobile and can see dot/hidden paths (the sanctioned `.nexus/` exception).
 *
 * Layout (see docs/plans/skills-protocol-integration-plan.md §3/§4):
 *   <skillsRoot>/<provider>/<name>/SKILL.md
 *
 * Entries whose basename starts with `_` (e.g. `_archive`) or `.` are ignored at every level so
 * the §3 archive snapshots are never mistaken for skills.
 */
export class SkillScanner {
  constructor(
    private adapter: DataAdapter,
    /** The resolved storage rootPath setting + "/skills" (settings-driven; never hardcoded). */
    private skillsRoot: string
  ) {}

  async scan(): Promise<ParsedSkillFolder[]> {
    const results: ParsedSkillFolder[] = [];

    let providerFolders: string[];
    try {
      if (!(await this.adapter.exists(this.skillsRoot))) {
        return results;
      }
      const rootListing = await this.adapter.list(this.skillsRoot);
      providerFolders = rootListing.folders;
    } catch {
      // Unreadable root → nothing to scan.
      return results;
    }

    for (const providerPath of providerFolders) {
      const provider = SkillScanner.basename(providerPath);
      // Skip ignored (`_`/`.`-prefixed) AND traversal-unsafe segments — a folder
      // named e.g. `..` must never become a provider key / path segment.
      if (SkillScanner.isIgnored(provider) || !isSafePathSegment(provider)) {
        continue;
      }

      let skillFolders: string[];
      try {
        const providerListing = await this.adapter.list(providerPath);
        skillFolders = providerListing.folders;
      } catch {
        // A single unreadable provider folder must not abort the whole scan.
        continue;
      }

      for (const skillPath of skillFolders) {
        const name = SkillScanner.basename(skillPath);
        if (SkillScanner.isIgnored(name) || !isSafePathSegment(name)) {
          continue;
        }

        try {
          const skillMdPath = `${this.skillsRoot}/${provider}/${name}/SKILL.md`;
          if (!(await this.adapter.exists(skillMdPath))) {
            // Folder without a SKILL.md is not a skill — skip.
            continue;
          }

          const content = await this.adapter.read(skillMdPath);
          const frontmatter = parseSkillFrontmatter(content);

          // The (provider, name) index key is the on-disk FOLDER identity —
          // the same identity vaultPath/originPath are built from. The
          // frontmatter `name` is display/validation metadata only; keying on it
          // would fork the UPSERT key (folder-name vaultPath vs frontmatter-name
          // key) and orphan the owned is_archived/last_loaded_at state.
          const description =
            typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

          results.push({
            provider,
            name,
            description,
            vaultPath: `${this.skillsRoot}/${provider}/${name}`,
            contentHash: hashSkillContent(content),
          });
        } catch {
          // A single unreadable / unparseable skill folder must not abort the whole scan.
          continue;
        }
      }
    }

    return results;
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
