/** Real SQLite and filesystem lane; Obsidian lifecycle remains a separate live-app gate. */
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DataAdapter, Vault } from 'obsidian';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import type { SQLiteCacheManager } from '../../src/database/storage/SQLiteCacheManager';
import { SCHEMA_SQL } from '../../src/database/schema/schema';
import { SkillService } from '../../src/services/skills/SkillService';
import { SkillIndexService } from '../../src/services/skills/SkillIndexService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import type { InstructionLibrarySettings } from '../../src/services/instructions/types';
import { StorageMaintenanceService, type StorageMaintenanceDeps } from '../../src/database/adapters/lifecycle/StorageMaintenanceService';

interface SqliteStatement {
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): unknown;
}
interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
let Database: (new (path: string) => SqliteDatabase) | undefined;
try { Database = (require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase }).DatabaseSync; }
catch { /* Node >=22 lane; the plugin itself supports Node >=18 and mobile. */ }

(Database ? describe : describe.skip)('skill archive survives a real SQLite cache rebuild', () => {
  it('seeds archive authority before close and reprojects it into the fresh database without reading resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-skill-rebuild-'));
    let database: SqliteDatabase | undefined;
    try {
      const skillsTable = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS skills \([\s\S]*?\);/)?.[0];
      if (!skillsTable || !Database) throw new Error('Skills schema/SQLite runtime unavailable');
      const open = () => { database = new Database!(':memory:'); database.exec(skillsTable); };
      open();
      const sqlite = {
        run: (sql: string, parameters: unknown[] = []) => Promise.resolve(database!.prepare(sql).run(...parameters)),
        query: (sql: string, parameters: unknown[] = []) => Promise.resolve(database!.prepare(sql).all(...parameters)),
        queryOne: (sql: string, parameters: unknown[] = []) => Promise.resolve(database!.prepare(sql).all(...parameters)[0] ?? null),
        stopAutoSave: () => undefined,
        close: () => { database!.close(); return Promise.resolve(); },
        initialize: () => { open(); return Promise.resolve(); }
      };
      const filesRead: string[] = [];
      const adapter = {
        exists: async (path: string) => { try { await access(join(root, path)); return true; } catch { return false; } },
        read: async (path: string) => { filesRead.push(path); return readFile(join(root, path), 'utf8'); },
        list: async (path: string) => {
          const entries = await readdir(join(root, path), { withFileTypes: true });
          return { files: entries.filter(entry => entry.isFile()).map(entry => `${path}/${entry.name}`), folders: entries.filter(entry => entry.isDirectory()).map(entry => `${path}/${entry.name}`) };
        }
      };
      await mkdir(join(root, 'Custom/skills/nexus/review/references'), { recursive: true });
      await writeFile(join(root, 'Custom/skills/nexus/review/SKILL.md'), '---\nname: review\ndescription: Review claims.\n---\n\nCheck sources.');
      await writeFile(join(root, 'Custom/skills/nexus/review/references/checks.md'), 'Resource must remain lazy.');
      const index = new SkillIndexService(sqlite as unknown as SQLiteCacheManager);
      await index.upsertOne({ provider: 'nexus', name: 'review', description: 'Review claims.', vaultPath: 'Custom/skills/nexus/review', contentHash: 'legacy' });
      await index.setArchived('nexus', 'review', true);
      const oldId = (await index.getOne('nexus', 'review'))!.id;
      let settings: InstructionLibrarySettings = { version: 1, items: {} };
      let persisted = '';
      const metadata = new InstructionMetadataService({ getSettings: () => settings, setSettings: value => { settings = value; }, saveSettings: () => { persisted = JSON.stringify(settings); return Promise.resolve(); } });
      const storage = { isReady: () => true, isQueryReady: () => true, getSqliteCache: () => sqlite };
      const skills = new SkillService({ vault: { adapter: adapter as unknown as DataAdapter } as Vault, getSettings: () => ({ storage: { rootPath: 'Custom', maxShardBytes: 1000 } }), getStorageAdapter: () => Promise.resolve(storage as unknown as IStorageAdapter), availability: metadata });
      const maintenance = new StorageMaintenanceService({
        getSqliteCache: () => sqlite, getCacheBlobStore: () => ({ remove: () => Promise.resolve() }),
        getInitLifecycle: () => ({ isInitialized: () => true }),
        getSyncCoordinator: () => ({ fullRebuild: () => Promise.resolve({ success: true, errors: [] }) })
      } as unknown as StorageMaintenanceDeps);
      maintenance.setBeforeCacheRebuild(async () => { const result = await skills.pauseForRebuild(); if (!result.ok) throw new Error(result.error.message); });
      maintenance.setAfterCacheRebuild(async () => { const result = await skills.resumeAfterRebuild(); if (!result.ok) throw new Error(result.error.message); });
      await maintenance.rebuildCache();
      expect(persisted).toContain('skillArchiveImportComplete');
      expect((await index.getOne('nexus', 'review'))!.id).not.toBe(oldId);
      expect((await index.getOne('nexus', 'review'))!.isArchived).toBe(true);
      expect(await skills.prepareMany([{ provider: 'nexus', name: 'review' }])).toMatchObject({ ok: false, error: { code: 'archived' } });
      expect(filesRead.some(path => path.endsWith('checks.md'))).toBe(false);
      skills.cleanup();
      const restored = new InstructionMetadataService({ getSettings: () => JSON.parse(persisted) as unknown, setSettings: () => undefined, saveSettings: () => Promise.resolve() });
      expect(restored.isArchived({ provider: 'nexus', name: 'review' })).toBe(true);
    } finally { database?.close(); await rm(root, { recursive: true, force: true }); }
  });
});
