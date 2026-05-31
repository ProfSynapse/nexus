import type { DataAdapter } from 'obsidian';
import { SkillScanner } from '@/agents/apps/skills/services/SkillScanner';

/**
 * Minimal in-memory DataAdapter fake. Backed by:
 *  - a set of folder paths and file paths (for `list` / `exists`)
 *  - a map of file path → content (for `read`)
 * `list(dir)` returns the immediate children of `dir`, mirroring Obsidian's
 * `{ files, folders }` shape with full vault-relative child paths.
 */
function makeAdapter(opts: {
  folders: string[];
  files: Record<string, string>;
  /** file paths whose `read` should throw */
  readThrows?: string[];
}): DataAdapter {
  const folderSet = new Set(opts.folders.map((f) => f.replace(/\/+$/, '')));
  const fileSet = new Set(Object.keys(opts.files));
  const readThrows = new Set(opts.readThrows ?? []);

  const immediateChildren = (dir: string) => {
    const prefix = dir.replace(/\/+$/, '') + '/';
    const folders: string[] = [];
    const files: string[] = [];
    for (const f of folderSet) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        folders.push(f);
      }
    }
    for (const f of fileSet) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        files.push(f);
      }
    }
    return { files, folders };
  };

  const fake = {
    async exists(path: string): Promise<boolean> {
      const p = path.replace(/\/+$/, '');
      return folderSet.has(p) || fileSet.has(p);
    },
    async list(path: string) {
      return immediateChildren(path);
    },
    async read(path: string): Promise<string> {
      if (readThrows.has(path)) {
        throw new Error(`read failed: ${path}`);
      }
      if (!fileSet.has(path)) {
        throw new Error(`no such file: ${path}`);
      }
      return opts.files[path];
    },
  };

  return fake as unknown as DataAdapter;
}

const ROOT = 'Nexus/skills';

describe('SkillScanner', () => {
  it('scans a two-provider tree with one skill each', async () => {
    const adapter = makeAdapter({
      folders: [
        ROOT,
        `${ROOT}/claude`,
        `${ROOT}/claude/essay-editor`,
        `${ROOT}/codex`,
        `${ROOT}/codex/pr-reviewer`,
      ],
      files: {
        [`${ROOT}/claude/essay-editor/SKILL.md`]:
          '---\nname: essay-editor\ndescription: Edit essays for clarity.\n---\n# Essay Editor\nBody.',
        [`${ROOT}/codex/pr-reviewer/SKILL.md`]:
          '---\nname: pr-reviewer\ndescription: Review pull requests.\n---\n# PR Reviewer\nBody.',
      },
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(2);

    const claude = result.find((r) => r.provider === 'claude');
    const codex = result.find((r) => r.provider === 'codex');

    expect(claude).toMatchObject({
      provider: 'claude',
      name: 'essay-editor',
      description: 'Edit essays for clarity.',
      vaultPath: `${ROOT}/claude/essay-editor`,
    });
    expect(typeof claude!.contentHash).toBe('string');
    expect(claude!.contentHash.length).toBeGreaterThan(0);

    expect(codex).toMatchObject({
      provider: 'codex',
      name: 'pr-reviewer',
      description: 'Review pull requests.',
      vaultPath: `${ROOT}/codex/pr-reviewer`,
    });
  });

  it('ignores _archive provider and _-prefixed skill folders', async () => {
    const adapter = makeAdapter({
      folders: [
        ROOT,
        `${ROOT}/_archive`,
        `${ROOT}/_archive/old-skill`,
        `${ROOT}/.hidden`,
        `${ROOT}/.hidden/secret`,
        `${ROOT}/claude`,
        `${ROOT}/claude/essay-editor`,
        `${ROOT}/claude/_archive`,
      ],
      files: {
        [`${ROOT}/_archive/old-skill/SKILL.md`]:
          '---\nname: old-skill\ndescription: archived.\n---\nbody',
        [`${ROOT}/.hidden/secret/SKILL.md`]:
          '---\nname: secret\ndescription: hidden.\n---\nbody',
        [`${ROOT}/claude/essay-editor/SKILL.md`]:
          '---\nname: essay-editor\ndescription: Edit essays.\n---\nbody',
        [`${ROOT}/claude/_archive/SKILL.md`]:
          '---\nname: should-not-appear\ndescription: archived skill version.\n---\nbody',
      },
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ provider: 'claude', name: 'essay-editor' });
  });

  it('skips a skill folder without a SKILL.md', async () => {
    const adapter = makeAdapter({
      folders: [
        ROOT,
        `${ROOT}/claude`,
        `${ROOT}/claude/essay-editor`,
        `${ROOT}/claude/empty-skill`,
      ],
      files: {
        [`${ROOT}/claude/essay-editor/SKILL.md`]:
          '---\nname: essay-editor\ndescription: Edit essays.\n---\nbody',
        // empty-skill has only a stray file, no SKILL.md
        [`${ROOT}/claude/empty-skill/notes.md`]: 'just notes',
      },
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('essay-editor');
  });

  it('parses the description from frontmatter', async () => {
    const adapter = makeAdapter({
      folders: [ROOT, `${ROOT}/claude`, `${ROOT}/claude/data-analyst`],
      files: {
        [`${ROOT}/claude/data-analyst/SKILL.md`]:
          '---\nname: data-analyst\ndescription: Analyze datasets and summarize findings.\n---\n# Data Analyst',
      },
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Analyze datasets and summarize findings.');
  });

  it('falls back to the folder name when frontmatter lacks name', async () => {
    const adapter = makeAdapter({
      folders: [ROOT, `${ROOT}/claude`, `${ROOT}/claude/my-skill`],
      files: {
        [`${ROOT}/claude/my-skill/SKILL.md`]:
          '---\ndescription: Only a description here.\n---\nbody',
      },
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('my-skill');
    expect(result[0].description).toBe('Only a description here.');
  });

  it('continues the scan when one folder read throws', async () => {
    const adapter = makeAdapter({
      folders: [
        ROOT,
        `${ROOT}/claude`,
        `${ROOT}/claude/broken`,
        `${ROOT}/claude/good`,
      ],
      files: {
        [`${ROOT}/claude/broken/SKILL.md`]: 'broken content',
        [`${ROOT}/claude/good/SKILL.md`]:
          '---\nname: good\ndescription: Works fine.\n---\nbody',
      },
      readThrows: [`${ROOT}/claude/broken/SKILL.md`],
    });

    const result = await new SkillScanner(adapter, ROOT).scan();

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('good');
  });

  it('returns an empty array when the skills root does not exist', async () => {
    const adapter = makeAdapter({ folders: [], files: {} });
    const result = await new SkillScanner(adapter, ROOT).scan();
    expect(result).toEqual([]);
  });
});
