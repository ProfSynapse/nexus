/** Exercises core loading against file contents and durable metadata; the index fake only caches rows. */
import type { Vault, DataAdapter } from 'obsidian';
import type { IStorageAdapter } from '../../src/database/interfaces/IStorageAdapter';
import { SkillsAgent } from '../../src/agents/skills/SkillsAgent';
import { UpdateSkillTool } from '../../src/agents/skills/tools/updateSkill';
import { SkillService, type SkillServiceDeps } from '../../src/services/skills/SkillService';
import { InstructionMetadataService } from '../../src/services/instructions/InstructionMetadataService';
import type { InstructionLibrarySettings, CoreSkillsSettings } from '../../src/services/instructions/types';
import type { ParsedSkillFolder, SkillRecord } from '../../src/services/skills/types';
import { parseSkillFrontmatter } from '../../src/services/skills/skillFrontmatter';

const mockRows = new Map<string, SkillRecord>();
const mockTouches: string[] = [];
jest.mock('../../src/services/skills/SkillIndexService', () => ({
  SkillIndexService: class {
    constructor(_sqlite: unknown, private readonly isCurrent = () => true) {}
    async list() { return [...mockRows.values()]; }
    async syncFromScan(rows: ParsedSkillFolder[]) { if (!this.isCurrent()) throw new Error('expired cache lease'); for (const row of rows) await this.upsertOne(row); }
    async upsertOne(row: ParsedSkillFolder) {
      const key = `${row.provider}/${row.name}`;
      mockRows.set(key, { id: key, isArchived: false, created: 1, updated: 1, ...mockRows.get(key), ...row });
    }
    async getOne(provider: string, name: string) { return mockRows.get(`${provider}/${name}`) ?? null; }
    async setArchived(provider: string, name: string, isArchived: boolean) {
      const row = mockRows.get(`${provider}/${name}`); if (row) row.isArchived = isArchived;
      return row ?? null;
    }
    async findByName(name: string, source?: string) { return [...mockRows.values()].filter(r => r.name === name && (!source || r.provider === source)); }
    async renameRow(provider: string, name: string, next: string, vaultPath: string) {
      const row = mockRows.get(`${provider}/${name}`); mockRows.delete(`${provider}/${name}`);
      if (row) mockRows.set(`${provider}/${next}`, { ...row, name: next, vaultPath });
    }
    async touchLoaded(id: string) { mockTouches.push(id); }
  },
}));

function setup(callbacks: Pick<SkillServiceDeps, 'onChanged' | 'onRenamed'> = {}) {
  const files = new Map<string, string>();
  const folders = new Set<string>(['Custom', 'Custom/skills']);
  const parent = (path: string) => path.slice(0, path.lastIndexOf('/'));
  const adapter = {
    exists: jest.fn(async (p: string) => files.has(p) || folders.has(p)),
    read: jest.fn(async (p: string) => { if (!files.has(p)) throw new Error('missing'); return files.get(p)!; }),
    write: jest.fn(async (p: string, text: string) => { files.set(p, text); }),
    mkdir: jest.fn(async (p: string) => { folders.add(p); }),
    list: jest.fn(async (p: string) => ({ files: [...files.keys()].filter(f => parent(f) === p), folders: [...folders].filter(f => parent(f) === p) })),
    remove: jest.fn(async (p: string) => { files.delete(p); }),
    rmdir: jest.fn(async (p: string) => { folders.delete(p); }),
    rename: jest.fn(async (from: string, to: string) => {
      for (const [p, text] of [...files]) if (p.startsWith(`${from}/`)) { files.delete(p); files.set(to + p.slice(from.length), text); }
      for (const p of [...folders]) if (p === from || p.startsWith(`${from}/`)) { folders.delete(p); folders.add(to + p.slice(from.length)); }
    }),
  };
  let library: InstructionLibrarySettings = { version: 1, items: {} };
  const save = jest.fn(async () => undefined);
  const metadata = new InstructionMetadataService({ getSettings: () => library, setSettings: next => { library = next; }, saveSettings: save });
  const sqlite = {};
  const storage = { isReady: () => true, isQueryReady: () => true, waitForQueryReady: async () => true, getSqliteCache: () => sqlite };
  const prefs: CoreSkillsSettings = { version: 1, automaticImport: false, syncBackOnEdit: false };
  const getStorage = jest.fn(async () => storage as unknown as IStorageAdapter);
  const service = new SkillService({ vault: { adapter: adapter as unknown as DataAdapter } as Vault,
    getSettings: () => ({ storage: { rootPath: 'Custom' } as never, skills: prefs }), getStorageAdapter: getStorage, availability: metadata, ...callbacks });
  const add = (provider: string, name: string, raw = `---\nname: ${name}\ndescription: Draft chapters.\n---\n\nWrite a scene.`) => {
    folders.add(`Custom/skills/${provider}`); folders.add(`Custom/skills/${provider}/${name}`);
    files.set(`Custom/skills/${provider}/${name}/SKILL.md`, raw);
  };
  return { service, metadata, save, files, folders, adapter, add, getStorage, prefs };
}

describe('Core SkillService', () => {
  beforeEach(() => { mockRows.clear(); mockTouches.length = 0; });
  it('prepares qualified bodies and tool declarations without usage stamps or resource reads', async () => {
    const { service, add, files, folders, adapter } = setup();
    add('nexus', 'write', '---\nname: write\ndescription: Draft.\nmetadata:\n  nexus:\n    tools: [content read]\n    categories: [Fiction]\n---\n\nDraft this scene.');
    folders.add('Custom/skills/nexus/write/examples'); files.set('Custom/skills/nexus/write/examples/one.md', 'Do not eagerly read.');
    const result = await service.prepareMany([{ provider: 'nexus', name: 'write' }, { provider: 'nexus', name: 'write' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value).toHaveLength(1); expect(result.value[0].instructions).toBe('Draft this scene.');
    expect(result.value[0].toolSelectors).toEqual(['content read']);
    expect(result.value[0].resources).toContain('examples/');
    expect(adapter.read).not.toHaveBeenCalledWith('Custom/skills/nexus/write/examples/one.md');
    expect(mockTouches).toHaveLength(0);
    const listed = await service.list();
    expect(listed.ok && listed.value[0].declaredCategories).toEqual(['Fiction']);
  });
  it('imports legacy archives before scan and remains archived after cache rows disappear', async () => {
    const { service, add } = setup(); add('nexus', 'write');
    mockRows.set('nexus/write', { id: 'old', provider: 'nexus', name: 'write', description: 'Draft.', vaultPath: 'Custom/skills/nexus/write', contentHash: '', isArchived: true, created: 1, updated: 1 });
    expect((await service.prepareForRebuild()).ok).toBe(true); mockRows.clear();
    const result = await service.prepareMany([{ provider: 'nexus', name: 'write' }]);
    expect(result.ok).toBe(false); if (!result.ok) expect(result.error.code).toBe('archived');
  });
  it('does not change effective availability when archive persistence fails', async () => {
    const { service, add, save } = setup(); add('nexus', 'write'); await service.list();
    save.mockRejectedValueOnce(new Error('disk full'));
    expect((await service.archive({ provider: 'nexus', name: 'write' }, true)).ok).toBe(false);
    expect((await service.prepareMany([{ provider: 'nexus', name: 'write' }])).ok).toBe(true);
  });
  it('preserves unknown frontmatter through body/description edits', async () => {
    const { service, add, files } = setup();
    add('nexus', 'write', '---\nname: write\ndescription: Draft.\nlicense: MIT\nmetadata:\n  vendor: keep\n  nexus:\n    categories: [Fiction]\n    tools: [content read]\n---\n\nOld body.');
    const result = await service.update({ provider: 'nexus', name: 'write' }, { body: 'New body.', description: 'New description.' });
    expect(result.ok).toBe(true);
    const parsed = parseSkillFrontmatter(files.get('Custom/skills/nexus/write/SKILL.md')!);
    expect(parsed.frontmatter).toMatchObject({ license: 'MIT', metadata: { vendor: 'keep', nexus: { tools: ['content read'], categories: ['Fiction'] } } });
    expect(parsed.body).toBe('New body.');
  });
  it('lists malformed metadata as unavailable and refuses preparation', async () => {
    const { service, add } = setup(); add('nexus', 'write', '---\nname: write\ndescription: Draft.\nmetadata:\n  nexus:\n    tools: nope\n---\n\nBody.');
    const listed = await service.list(); expect(listed.ok && listed.value[0].availability).toBe('unavailable');
    const prepared = await service.prepareMany([{ provider: 'nexus', name: 'write' }]);
    expect(prepared.ok).toBe(false); if (!prepared.ok) expect(prepared.error.code).toBe('invalid');
  });
  it('exact references reject traversal without file reads/writes', async () => {
    const { service, add, adapter } = setup(); add('nexus', 'write');
    const result = await service.create({ name: '../escape', source: 'nexus', description: 'Bad', body: 'Bad' });
    expect(result.ok).toBe(false); expect(adapter.write).not.toHaveBeenCalled();
  });
  it('renames resource history and leaves old identity archived against provider reimport', async () => {
    const { service, add, files, folders, metadata } = setup(); add('nexus', 'write');
    folders.add('Custom/skills/nexus/write/_archive'); folders.add('Custom/skills/nexus/write/_archive/old');
    files.set('Custom/skills/nexus/write/_archive/old/SKILL.md', 'Historical');
    const result = await service.update({ provider: 'nexus', name: 'write' }, { rename: 'draft' });
    expect(result.ok).toBe(true); expect(files.get('Custom/skills/nexus/draft/_archive/old/SKILL.md')).toBe('Historical');
    expect(metadata.isArchived({ provider: 'nexus', name: 'write' })).toBe(true);
    expect(files.has('Custom/skills/nexus/write/SKILL.md')).toBe(false);
  });
  it('rolls back package identity if metadata transfer fails', async () => {
    const { service, add, files, metadata } = setup(); add('nexus', 'write');
    await metadata.setArchived({ provider: 'nexus', name: 'draft' }, true);
    const result = await service.update({ provider: 'nexus', name: 'write' }, { rename: 'draft' });
    expect(result.ok).toBe(false); expect(files.has('Custom/skills/nexus/draft/SKILL.md')).toBe(false);
    expect(parseSkillFrontmatter(files.get('Custom/skills/nexus/write/SKILL.md')!).name).toBe('write');
  });
  it('invalidates discovery after mutations while passive reads emit no invalidation', async () => {
    const onChanged = jest.fn(); const { service, add } = setup({ onChanged }); add('nexus', 'write');
    await service.list(); await service.getDetail({ provider: 'nexus', name: 'write' }); expect(onChanged).not.toHaveBeenCalled();
    await service.update({ provider: 'nexus', name: 'write' }, { body: 'Changed body' }); expect(onChanged).toHaveBeenCalledTimes(1);
    await service.refreshIndex(); expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('reports the actual renamed identity when attachment persistence fails', async () => {
    const { service, add, files } = setup({ onRenamed: async () => ({ ok: false, error: { code: 'persistence', message: 'Could not save attachments' } }) }); add('nexus', 'write');
    const result = await service.update({ provider: 'nexus', name: 'write' }, { rename: 'draft' });
    expect(result).toMatchObject({ ok: false, error: { reference: { type: 'skill', provider: 'nexus', name: 'draft' } } });
    expect(files.has('Custom/skills/nexus/draft/SKILL.md')).toBe(true); expect(files.has('Custom/skills/nexus/write/SKILL.md')).toBe(false);
  });
  it('retries a partial rename attachment repair against the current qualified identity', async () => {
    const onRenamed = jest.fn(async () => ({ ok: true as const, value: undefined }));
    onRenamed.mockResolvedValueOnce({ ok: false, error: { code: 'persistence', message: 'Attachment write failed' } } as never);
    const { service, add } = setup({ onRenamed }); add('nexus', 'write');
    const first = await service.update({ provider: 'nexus', name: 'write' }, { rename: 'draft' });
    expect(first).toMatchObject({ ok: false, error: { reference: { type: 'skill', provider: 'nexus', name: 'draft' }, repairReferencesFrom: { provider: 'nexus', name: 'write' } } });
    if (first.ok || first.error.reference?.type !== 'skill') throw new Error('Expected partial rename failure');
    const retried = await service.update(first.error.reference, { repairReferencesFrom: first.error.repairReferencesFrom });
    expect(retried).toMatchObject({ ok: true, value: { reference: { provider: 'nexus', name: 'draft' }, previousReference: { provider: 'nexus', name: 'write' } } });
    expect(onRenamed).toHaveBeenCalledTimes(2); expect(onRenamed).toHaveBeenLastCalledWith({ provider: 'nexus', name: 'write' }, { provider: 'nexus', name: 'draft' });
  });
  it('standalone rename errors keep explicit retry guidance when a formatter drops data', async () => {
    const { service, add } = setup({ onRenamed: async () => ({ ok: false, error: { code: 'persistence', message: 'Attachment write failed' } }) }); add('nexus', 'write');
    const tool = new UpdateSkillTool(new SkillsAgent(service));
    const result = await tool.execute({ name: 'write', source: 'nexus', rename: 'draft', context: { workspaceId: 'ws-fiction', sessionId: 's-chat', memory: 'Editing skill', goal: 'Rename drafting skill' } });
    expect(result.success).toBe(false); expect(result.error).toContain('nexus/draft'); expect(result.error).toContain('nexus/write'); expect(result.error).toContain('--repair-references-from');
    expect(tool.getParameterSchema().properties?.repairReferencesFrom).toMatchObject({ type: 'object', required: ['provider', 'name'] });
  });
  it('drains delayed scans before cache close and cancels their old cache writes', async () => {
    const { service, add, adapter } = setup(); add('nexus', 'write');
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const originalRead = adapter.read.getMockImplementation()!;
    adapter.read.mockImplementationOnce(async path => { entered(); await blocked; return originalRead(path); });
    const pending = service.list(); await started;
    let paused = false; const pause = service.pauseForRebuild().then(result => { paused = true; return result; });
    expect((await service.list()).ok).toBe(false); expect(paused).toBe(false);
    release(); expect((await pending).ok).toBe(false); expect((await pause).ok).toBe(true);
    expect(mockRows.size).toBe(0);
    expect((await service.resumeAfterRebuild()).ok).toBe(true); expect(mockRows.has('nexus/write')).toBe(true);
  });
  it('uses the current adapter on each operation and refuses a closed service', async () => {
    const { service, add, getStorage } = setup(); add('nexus', 'write');
    await service.list(); await service.list(); expect(getStorage).toHaveBeenCalledTimes(2);
    service.cleanup(); expect((await service.list()).ok).toBe(false); expect(getStorage).toHaveBeenCalledTimes(2);
  });
  it('waits for a delayed scan to observe unload before cleanup resolves', async () => {
    const { service, add, adapter } = setup(); add('nexus', 'write');
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const originalRead = adapter.read.getMockImplementation()!;
    adapter.read.mockImplementationOnce(async path => { entered(); await blocked; return originalRead(path); });
    const pending = service.list(); await started;
    let finished = false;
    const cleanup = service.cleanup().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    expect((await service.list()).ok).toBe(false);
    release(); expect((await pending).ok).toBe(false); await cleanup;
    expect(finished).toBe(true); expect(mockRows.size).toBe(0);
  });
});
