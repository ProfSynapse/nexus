import type { DataAdapter } from 'obsidian';
import type { ParsedSkillFolder } from '../types';

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
    /** e.g. "Nexus/skills" — the resolved plugin storage root + "/skills". */
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
      if (SkillScanner.isIgnored(provider)) {
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
        if (SkillScanner.isIgnored(name)) {
          continue;
        }

        try {
          const skillMdPath = `${this.skillsRoot}/${provider}/${name}/SKILL.md`;
          if (!(await this.adapter.exists(skillMdPath))) {
            // Folder without a SKILL.md is not a skill — skip.
            continue;
          }

          const content = await this.adapter.read(skillMdPath);
          const frontmatter = await SkillScanner.parseFrontmatter(content);

          const fmName =
            typeof frontmatter.name === 'string' && frontmatter.name.trim().length > 0
              ? frontmatter.name.trim()
              : name;
          const description =
            typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';

          results.push({
            provider,
            name: fmName,
            description,
            vaultPath: `${this.skillsRoot}/${provider}/${name}`,
            contentHash: SkillScanner.fnv1a(content),
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

  /**
   * Extracts and parses the leading YAML frontmatter block (delimited by `---`). Uses a dynamic
   * import of `yaml` (mobile-safe — no Node API at module init). Returns `{}` when there is no
   * frontmatter or parsing fails.
   */
  private static async parseFrontmatter(content: string): Promise<Record<string, unknown>> {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
    if (!match) {
      return {};
    }
    try {
      const { parse } = await import('yaml');
      const parsed: unknown = parse(match[1]);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * Tiny inline FNV-1a (32-bit) string hash → hex string. Deliberately avoids Node `crypto`
   * (mobile-unsafe) and adds no dependency.
   */
  private static fnv1a(input: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      // hash *= 16777619, kept in 32-bit unsigned via Math.imul + >>> 0
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}
