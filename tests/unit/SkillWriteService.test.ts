/**
 * SkillWriteService Unit Tests
 *
 * Verifies the vault-native disk I/O for the Skills app's CRUA writes against an
 * in-memory DataAdapter fake (Map-backed files + Set-backed folders implementing
 * exists/list/read/write/mkdir/remove/rmdir). Covers compose round-trip, write
 * round-trip, archive-then-replace snapshot + null-on-fresh, and the `_`/`.`
 * copyTree skip.
 */

import type { DataAdapter } from 'obsidian';
import { SkillWriteService } from '@/agents/apps/skills/services/SkillWriteService';

/**
 * Minimal in-memory DataAdapter. Tracks files (path → content) and folders.
 * `list(dir)` returns the immediate children of `dir` in Obsidian's
 * `{ files, folders }` shape with full vault-relative child paths.
 */
function makeAdapter() {
  const files = new Map<string, string>();
  const folders = new Set<string>();

  const norm = (p: string) => p.replace(/\/+$/, '');

  const immediateChildren = (dir: string) => {
    const prefix = norm(dir) + '/';
    const childFiles: string[] = [];
    const childFolders: string[] = [];
    for (const f of files.keys()) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        childFiles.push(f);
      }
    }
    for (const f of folders) {
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) {
        childFolders.push(f);
      }
    }
    return { files: childFiles, folders: childFolders };
  };

  const adapter = {
    async exists(path: string): Promise<boolean> {
      const p = norm(path);
      return files.has(p) || folders.has(p);
    },
    async list(path: string) {
      return immediateChildren(path);
    },
    async read(path: string): Promise<string> {
      const p = norm(path);
      if (!files.has(p)) {
        throw new Error(`no such file: ${p}`);
      }
      return files.get(p) as string;
    },
    async write(path: string, data: string): Promise<void> {
      const p = norm(path);
      // Ensure parent folders exist (Obsidian requires the parent dir).
      const segs = p.split('/');
      let cur = '';
      for (let i = 0; i < segs.length - 1; i++) {
        cur = cur.length > 0 ? `${cur}/${segs[i]}` : segs[i];
        folders.add(cur);
      }
      files.set(p, data);
    },
    async mkdir(path: string): Promise<void> {
      const p = norm(path);
      if (folders.has(p)) {
        throw new Error(`folder exists: ${p}`);
      }
      folders.add(p);
    },
    async remove(path: string): Promise<void> {
      files.delete(norm(path));
    },
    async rmdir(path: string, _recursive: boolean): Promise<void> {
      folders.delete(norm(path));
    },
  };

  return { adapter: adapter as unknown as DataAdapter, files, folders };
}

describe('SkillWriteService', () => {
  describe('composeSkillMd', () => {
    it('produces a valid --- delimited block parseable back to name/description', async () => {
      const { adapter } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const content = await svc.composeSkillMd('essay-editor', 'Edit essays for clarity.', '# Body\nText.');

      expect(content.startsWith('---\n')).toBe(true);
      const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(content);
      expect(match).not.toBeNull();

      const { parseYaml } = await import('obsidian');
      const fm = parseYaml(match![1]) as Record<string, unknown>;
      expect(fm.name).toBe('essay-editor');
      expect(fm.description).toBe('Edit essays for clarity.');
      expect(match![2].trim()).toBe('# Body\nText.');
    });
  });

  describe('writeSkill', () => {
    it('round-trips: write then readSkillMd / exists', async () => {
      const { adapter } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const folder = 'Nexus/skills/nexus/my-skill';
      const content = await svc.composeSkillMd('my-skill', 'desc', 'body');

      expect(await svc.exists(folder)).toBe(false);
      await svc.writeSkill(folder, content);

      expect(await svc.exists(folder)).toBe(true);
      expect(await svc.readSkillMd(folder)).toBe(content);
    });

    it('readSkillMd returns null when no SKILL.md is present', async () => {
      const { adapter } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      expect(await svc.readSkillMd('Nexus/skills/nexus/missing')).toBeNull();
    });
  });

  describe('archiveThenReplace', () => {
    it('returns null when there is no prior SKILL.md and just writes', async () => {
      const { adapter } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const folder = 'Nexus/skills/nexus/fresh';

      let wrote = false;
      const archived = await svc.archiveThenReplace(folder, async () => {
        await svc.writeSkill(folder, await svc.composeSkillMd('fresh', 'd', 'b'));
        wrote = true;
      });

      expect(archived).toBeNull();
      expect(wrote).toBe(true);
      expect(await svc.exists(folder)).toBe(true);
    });

    it('snapshots the prior version into _archive/<ts>/ then overwrites', async () => {
      const { adapter, files } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const folder = 'Nexus/skills/nexus/iter';

      const v1 = await svc.composeSkillMd('iter', 'desc v1', 'body v1');
      await svc.writeSkill(folder, v1);

      const v2 = await svc.composeSkillMd('iter', 'desc v2', 'body v2');
      const archived = await svc.archiveThenReplace(folder, async () => {
        await svc.writeSkill(folder, v2);
      });

      expect(archived).not.toBeNull();
      expect(archived).toContain(`${folder}/_archive/`);

      // Live SKILL.md is now v2.
      expect(await svc.readSkillMd(folder)).toBe(v2);

      // The archived snapshot preserved v1.
      const archivedSkillMd = files.get(`${archived}/SKILL.md`);
      expect(archivedSkillMd).toBe(v1);
    });
  });

  describe('copyTree', () => {
    it('skips _-prefixed and .-prefixed children', async () => {
      const { adapter, files } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const src = 'Nexus/skills/nexus/src';

      await adapter.write(`${src}/SKILL.md`, 'skillmd');
      await adapter.write(`${src}/notes.md`, 'notes');
      await adapter.write(`${src}/_archive/old/SKILL.md`, 'archived');
      await adapter.write(`${src}/.hidden`, 'secret');

      const dest = 'Nexus/skills/nexus/dest';
      await svc.copyTree(src, dest);

      expect(files.get(`${dest}/SKILL.md`)).toBe('skillmd');
      expect(files.get(`${dest}/notes.md`)).toBe('notes');
      expect(files.has(`${dest}/_archive/old/SKILL.md`)).toBe(false);
      expect(files.has(`${dest}/.hidden`)).toBe(false);
    });
  });

  describe('removeTree', () => {
    it('recursively removes all files and folders', async () => {
      const { adapter, files } = makeAdapter();
      const svc = new SkillWriteService(adapter);
      const folder = 'Nexus/skills/nexus/doomed';

      await adapter.write(`${folder}/SKILL.md`, 'a');
      await adapter.write(`${folder}/sub/file.md`, 'b');

      await svc.removeTree(folder);

      expect(files.has(`${folder}/SKILL.md`)).toBe(false);
      expect(files.has(`${folder}/sub/file.md`)).toBe(false);
      expect(await adapter.exists(folder)).toBe(false);
    });
  });
});
