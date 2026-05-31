/**
 * SnapshotArchiveService — tests for the shared version-in-place snapshot
 * primitive extracted from SkillWriteService (spike S1). The Skills behavior
 * itself is locked by SkillWriteService.test.ts (no-behavior-change proof); these
 * exercise the generic service directly, including the bits Skills doesn't reach
 * (configurable archive dir, injected clock, same-instant disambiguation).
 *
 * Reuses the same in-memory DataAdapter fake shape as SkillWriteService.test.ts.
 */

import { SnapshotArchiveService } from '../../src/services/storage/SnapshotArchiveService';
import type { DataAdapter } from 'obsidian';

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

describe('SnapshotArchiveService', () => {
  const FIXED = Date.parse('2026-05-31T12:34:56.789Z');

  it('snapshots the current tree into _archive/<ts>/ and returns that path', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new SnapshotArchiveService(adapter, { now: () => FIXED });
    const folder = 'Nexus/spreadsheets/budget';

    await adapter.write(`${folder}/Sheet1.part0.csv`, 'region,amount\nEMEA,100\n');
    await adapter.write(`${folder}/manifest.json`, '{"v":1}');

    const archived = await svc.archiveCopy(folder);

    expect(archived).toBe(`${folder}/_archive/2026-05-31T12-34-56-789Z`);
    expect(files.get(`${archived}/Sheet1.part0.csv`)).toBe('region,amount\nEMEA,100\n');
    expect(files.get(`${archived}/manifest.json`)).toBe('{"v":1}');
  });

  it('skips _-prefixed and .-prefixed children (never archives the archive)', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new SnapshotArchiveService(adapter, { now: () => FIXED });
    const folder = 'Nexus/spreadsheets/budget';

    await adapter.write(`${folder}/Sheet1.part0.csv`, 'data');
    await adapter.write(`${folder}/_archive/older/Sheet1.part0.csv`, 'PRIOR');
    await adapter.write(`${folder}/.hidden`, 'secret');

    const archived = await svc.archiveCopy(folder);

    expect(files.get(`${archived}/Sheet1.part0.csv`)).toBe('data');
    expect(files.has(`${archived}/_archive/older/Sheet1.part0.csv`)).toBe(false);
    expect(files.has(`${archived}/.hidden`)).toBe(false);
  });

  it('disambiguates same-instant snapshots with -1, -2, … suffixes', async () => {
    const { adapter } = makeAdapter();
    const svc = new SnapshotArchiveService(adapter, { now: () => FIXED });
    const folder = 'Nexus/spreadsheets/budget';
    await adapter.write(`${folder}/Sheet1.part0.csv`, 'v1');

    const first = await svc.archiveCopy(folder);
    const second = await svc.archiveCopy(folder);
    const third = await svc.archiveCopy(folder);

    expect(first).toBe(`${folder}/_archive/2026-05-31T12-34-56-789Z`);
    expect(second).toBe(`${folder}/_archive/2026-05-31T12-34-56-789Z-1`);
    expect(third).toBe(`${folder}/_archive/2026-05-31T12-34-56-789Z-2`);
  });

  it('honors a custom archiveDirName', async () => {
    const { adapter, files } = makeAdapter();
    const svc = new SnapshotArchiveService(adapter, { now: () => FIXED, archiveDirName: '_versions' });
    const folder = 'Nexus/spreadsheets/budget';
    await adapter.write(`${folder}/Sheet1.part0.csv`, 'data');

    const archived = await svc.archiveCopy(folder);

    expect(archived).toContain(`${folder}/_versions/`);
    expect(files.get(`${archived}/Sheet1.part0.csv`)).toBe('data');
  });
});
