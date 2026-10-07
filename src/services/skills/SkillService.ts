import { normalizePath } from 'obsidian';
import type { App, Vault, DataAdapter } from 'obsidian';
import type { IStorageAdapter } from '../../database/interfaces/IStorageAdapter';
import type { SQLiteCacheManager } from '../../database/storage/SQLiteCacheManager';
import { resolveVaultRoot } from '../../database/storage/VaultRootResolver';
import { resolveVaultPath } from '../../core/vaultPath';
import { withTimeout } from '../../utils/withTimeout';
import type { MCPSettings } from '../../types/plugin/PluginTypes';
import type { CoreSkillsSettings, ServiceResult, SkillAvailabilityPort, SkillReference, SkillDetail, SkillCreateInput, SkillUpdateInput, SkillSyncResult, PreparedInstruction } from '../instructions/types';
import { SkillIndexService } from './SkillIndexService';
import { SkillScanner } from './SkillScanner';
import { SkillWriteService } from './SkillWriteService';
import { SkillValidator } from './SkillValidator';
import { SkillSyncWatcher } from './SkillSyncWatcher';
import { SkillUsageService } from './SkillUsageService';
import type { SkillUsageHistory } from './SkillUsageService';
import { SkillSyncService } from './SkillSyncService';
import { parseSkillFrontmatter, readNexusMetadata, mergeSkillFrontmatter } from './skillFrontmatter';
import { hashSkillContent } from './skillHash';
import { assertInside, isSafePathSegment } from './skillPaths';
import type { SkillRecord, ParsedSkillFolder } from './types';

export interface SkillServiceDeps {
  vault: Vault;
  getSettings(): Pick<MCPSettings, 'storage' | 'skills'>;
  getStorageAdapter(): Promise<IStorageAdapter | null>;
  availability: SkillAvailabilityPort;
  onChanged?(): void;
  onRenamed?(from: SkillReference, to: SkillReference): Promise<ServiceResult<void>>;
}
interface Runtime { sqlite: SQLiteCacheManager; adapter: DataAdapter; root: string; index: SkillIndexService; scanner: SkillScanner; write: SkillWriteService }
class SkillOperationError extends Error {
  constructor(readonly code: 'initializing' | 'unavailable' | 'not-found' | 'archived' | 'invalid' | 'ambiguous' | 'persistence', message: string) { super(message); }
}

/** Core file/index operations. Explicit loading side effects belong to callers. */
export class SkillService {
  private watcher?: SkillSyncWatcher;
  private disposed = false;
  private lifecycleScheduled = false;
  private paused = false;
  private generation = 0;
  private readonly operations = new Set<Promise<unknown>>();
  constructor(private readonly deps: SkillServiceDeps) {}

  startAfterLayoutReady(app: App): void {
    if (this.lifecycleScheduled || this.disposed) return;
    this.lifecycleScheduled = true;
    app.workspace.onLayoutReady(() => {
      if (this.disposed || this.watcher) return;
      this.watcher = new SkillSyncWatcher(app, this);
      this.watcher.start();
    });
  }
  async cleanup(): Promise<void> {
    this.disposed = true;
    this.generation++;
    this.watcher?.stop();
    this.watcher = undefined;
    // A canceled scan may still be awaiting a vault read. Keep its cache alive
    // until it observes the invalidated lease and settles.
    await Promise.allSettled([...this.operations]);
  }
  /** Maintenance MUST await this before destroying the legacy cache. */
  prepareForRebuild(): Promise<ServiceResult<void>> { return this.perform(() => Promise.resolve(undefined)); }
  /** Cancel pending cache leases, drain operations, then preserve legacy flags. */
  async pauseForRebuild(): Promise<ServiceResult<void>> {
    this.paused = true;
    this.generation++;
    await Promise.allSettled([...this.operations]);
    try { await this.runtime(true); return { ok: true, value: undefined }; }
    catch (error) {
      this.paused = false;
      return { ok: false, error: { code: 'persistence', message: error instanceof Error ? error.message : String(error) } };
    }
  }
  async resumeAfterRebuild(): Promise<ServiceResult<void>> {
    this.paused = false;
    this.generation++;
    return this.refreshIndex({ importProviders: false });
  }

  getRoot(): string {
    return resolveVaultPath(`${resolveVaultRoot({ storage: this.deps.getSettings().storage }).resolvedPath}/skills`);
  }
  getPreferences(): CoreSkillsSettings {
    return this.deps.getSettings().skills ?? { version: 1, automaticImport: false, syncBackOnEdit: false };
  }

  private async runtime(allowPaused = false): Promise<Runtime> {
    const generation = this.generation;
    if (this.paused && !allowPaused) throw new SkillOperationError('initializing', 'Skills are paused for cache maintenance');
    if (this.disposed) throw new SkillOperationError('unavailable', 'Skill service is closed');
    const storage = await withTimeout(this.deps.getStorageAdapter(), 4000, null);
    if (!storage) throw new SkillOperationError('initializing', 'Skill storage is initializing');
    if (storage.waitForQueryReady) await withTimeout(storage.waitForQueryReady(), 4000, false);
    if (this.disposed) throw new SkillOperationError('unavailable', 'Skill service is closed');
    const ready = storage.isQueryReady ? storage.isQueryReady() : storage.isReady();
    if (!ready) throw new SkillOperationError('initializing', 'Skill storage is not query ready');
    const provider = storage as IStorageAdapter & { getSqliteCache?(): SQLiteCacheManager };
    if (!provider.getSqliteCache) throw new SkillOperationError('unavailable', 'Skill index is unavailable');
    const sqlite = provider.getSqliteCache();
    const isCurrent = () => !this.disposed && generation === this.generation && (storage.isQueryReady ? storage.isQueryReady() : storage.isReady()) && provider.getSqliteCache?.() === sqlite;
    const index = new SkillIndexService(sqlite, isCurrent);
    // Capture legacy owned flags BEFORE any scan creates/prunes cache rows.
    const imported = await this.deps.availability.ensureLegacyArchiveImported(await index.list({ includeArchived: true }), true);
    if (!imported.ok) throw new SkillOperationError(imported.error.code === 'initializing' ? 'initializing' : 'persistence', imported.error.message);
    if (!isCurrent()) throw new SkillOperationError('initializing', 'Skill storage changed during preparation');
    const root = this.getRoot();
    return { sqlite, adapter: this.deps.vault.adapter, root, index, scanner: new SkillScanner(this.deps.vault.adapter, root), write: new SkillWriteService(this.deps.vault.adapter) };
  }
  private async refresh(rt: Runtime): Promise<ParsedSkillFolder[]> {
    if (this.disposed) throw new SkillOperationError('unavailable', 'Skill service is closed');
    const parsed = await rt.scanner.scan();
    if (this.disposed) throw new SkillOperationError('unavailable', 'Skill service is closed');
    await rt.index.syncFromScan(parsed);
    for (const record of await rt.index.list({ includeArchived: true })) {
      const archived = this.deps.availability.isArchived(record);
      if (record.isArchived !== archived) await rt.index.setArchived(record.provider, record.name, archived);
    }
    return parsed;
  }
  private perform<T>(fn: (rt: Runtime) => Promise<T>): Promise<ServiceResult<T>> {
    const operation = (async (): Promise<ServiceResult<T>> => {
      try { return { ok: true, value: await fn(await this.runtime()) }; }
      catch (error) {
        return { ok: false, error: { code: error instanceof SkillOperationError ? error.code : 'unavailable', message: error instanceof Error ? error.message : String(error) } };
      }
    })();
    this.operations.add(operation);
    void operation.finally(() => this.operations.delete(operation));
    return operation;
  }
  private afterMutation<T>(operation: Promise<ServiceResult<T>>): Promise<ServiceResult<T>> {
    return operation.then(result => {
      if (result.ok) { try { this.deps.onChanged?.(); } catch { /* Invalidation cannot undo committed content. */ } }
      return result;
    });
  }
  private path(rt: Runtime, ref: SkillReference): string {
    if (!isSafePathSegment(ref.provider) || !isSafePathSegment(ref.name)) throw new SkillOperationError('invalid', 'Invalid skill identity');
    const path = resolveVaultPath(`${rt.root}/${ref.provider}/${ref.name}`);
    assertInside(rt.root, path);
    return path;
  }
  private async detail(rt: Runtime, ref: SkillReference, recursive = true): Promise<SkillDetail> {
    const root = this.path(rt, ref);
    const record = await rt.index.getOne(ref.provider, ref.name);
    if (!record) throw new SkillOperationError('not-found', `No skill named ${ref.provider}/${ref.name}`);
    const raw = await rt.write.readSkillMd(root);
    if (raw === null) throw new SkillOperationError('unavailable', `Cannot read ${root}/SKILL.md`);
    const parsed = parseSkillFrontmatter(raw);
    const metadata = readNexusMetadata(parsed.frontmatter);
    if (parsed.error || metadata.error) throw new SkillOperationError('invalid', parsed.error ?? metadata.error ?? 'Invalid skill metadata');
    const archived = this.deps.availability.isArchived(ref);
    return {
      reference: ref, record: { ...record, isArchived: archived }, name: record.name,
      description: parsed.description ?? record.description, body: parsed.body, frontmatter: parsed.frontmatter,
      entrypointPath: normalizePath(`${root}/SKILL.md`), resourceRoot: root,
      resources: await this.structure(rt.adapter, root, recursive),
      toolSelectors: metadata.tools, declaredCategories: metadata.categories,
      contentHash: hashSkillContent(raw), archived,
    };
  }
  private async structure(adapter: DataAdapter, root: string, recursive: boolean): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      const listing = await adapter.list(dir);
      for (const file of listing.files) {
        const relative = file.slice(root.length + 1);
        if (relative.split('/').some(part => part.startsWith('.') || part.startsWith('_'))) continue;
        assertInside(root, resolveVaultPath(file));
        out.push(relative);
      }
      for (const folder of listing.folders) {
        const relative = folder.slice(root.length + 1);
        if (relative.split('/').some(part => part.startsWith('.') || part.startsWith('_'))) continue;
        assertInside(root, resolveVaultPath(folder));
        if (recursive) await visit(folder); else out.push(`${relative}/`);
      }
    };
    try { await visit(root); } catch { /* Resource navigation is best-effort. */ }
    return out.sort();
  }

  list(options?: { search?: string; source?: string; includeArchived?: boolean }): Promise<ServiceResult<SkillRecord[]>> {
    return this.perform(async rt => {
      const parsed = await this.refresh(rt);
      const details = new Map(parsed.map(item => [JSON.stringify([item.provider, item.name]), item]));
      return (await rt.index.list({ search: options?.search, includeArchived: true }))
        .map(record => {
          const item = details.get(JSON.stringify([record.provider, record.name]));
          return { ...record, isArchived: this.deps.availability.isArchived(record),
            declaredCategories: item?.declaredCategories ?? [],
            availability: item && !item.metadataError ? 'available' as const : 'unavailable' as const,
            metadataError: item?.metadataError };
        })
        .filter(record => (options?.includeArchived || !record.isArchived) && (!options?.source || record.provider === options.source));
    });
  }
  getDetail(ref: SkillReference): Promise<ServiceResult<SkillDetail>> {
    return this.perform(async rt => { await this.refresh(rt); return this.detail(rt, ref); });
  }
  prepareMany(refs: readonly SkillReference[], options?: { recursive?: boolean }): Promise<ServiceResult<PreparedInstruction[]>> {
    return this.perform(async rt => {
      await this.refresh(rt);
      const prepared: PreparedInstruction[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        const key = JSON.stringify([ref.provider, ref.name]);
        if (seen.has(key)) continue;
        seen.add(key);
        const detail = await this.detail(rt, ref, options?.recursive === true);
        if (detail.archived) throw new SkillOperationError('archived', `Skill ${ref.provider}/${ref.name} is archived`);
        prepared.push({ reference: { type: 'skill', ...ref }, name: detail.name, instructions: detail.body,
          entrypointPath: detail.entrypointPath, resourceRoot: detail.resourceRoot, resources: detail.resources,
          toolSelectors: detail.toolSelectors, contentHash: detail.contentHash });
      }
      return prepared;
    });
  }

  resolveForLegacyLoad(name: string, source?: string): Promise<ServiceResult<SkillReference>> {
    return this.resolve(name, source, false, true);
  }
  resolveForMutation(name: string, source?: string): Promise<ServiceResult<SkillReference>> {
    return this.resolve(name, source, true, false);
  }
  private resolve(name: string, source: string | undefined, includeArchived: boolean, recency: boolean): Promise<ServiceResult<SkillReference>> {
    return this.perform(async rt => {
      await this.refresh(rt);
      const matches = (await rt.index.findByName(name, source, { includeArchived: true }))
        .filter(record => includeArchived || !this.deps.availability.isArchived(record));
      if (!matches.length) throw new SkillOperationError('not-found', `No skill named ${name}${source ? ` for provider ${source}` : ''}`);
      if (matches.length > 1 && !recency) throw new SkillOperationError('ambiguous', `Skill ${name} exists for ${matches.map(r => r.provider).join(', ')}; pass --source`);
      return { provider: matches[0].provider, name: matches[0].name };
    });
  }

  create(input: SkillCreateInput): Promise<ServiceResult<SkillDetail>> {
    return this.afterMutation(this.perform(async rt => {
      const ref = { provider: input.source ?? 'nexus', name: input.name };
      const folder = this.path(rt, ref);
      const validator = new SkillValidator();
      const validation = validator.validate({ name: input.name, description: input.description });
      const providerValidation = validator.validateProvider(ref.provider);
      if (!validation.valid || !providerValidation.valid) throw new SkillOperationError('invalid', [...validation.errors, ...providerValidation.errors].join('; '));
      if (await rt.write.exists(folder)) throw new SkillOperationError('invalid', `Skill already exists: ${ref.provider}/${ref.name}`);
      const frontmatter = mergeSkillFrontmatter({}, input.frontmatter, input.toolSelectors);
      const metadata = readNexusMetadata(frontmatter);
      if (metadata.error) throw new SkillOperationError('invalid', metadata.error);
      const raw = rt.write.composeSkillMd(input.name, input.description, input.body ?? '', frontmatter);
      await rt.write.writeSkill(folder, raw);
      await rt.index.upsertOne({ provider: ref.provider, name: ref.name, description: input.description, vaultPath: folder, contentHash: hashSkillContent(raw) });
      return this.detail(rt, ref);
    }));
  }
  update(ref: SkillReference, input: SkillUpdateInput): Promise<ServiceResult<SkillDetail>> {
    let changedReference: SkillReference | undefined;
    let repairReferencesFrom: SkillReference | undefined;
    const operation = this.afterMutation(this.perform(async rt => {
      await this.refresh(rt);
      const current = await this.detail(rt, ref);
      const next = { provider: ref.provider, name: input.rename ?? ref.name };
      const target = this.path(rt, next);
      if (input.repairReferencesFrom) {
        this.path(rt, input.repairReferencesFrom);
        if (input.repairReferencesFrom.provider !== ref.provider || input.repairReferencesFrom.name === ref.name || next.name !== ref.name || !this.deps.availability.isArchived(input.repairReferencesFrom)) {
          throw new SkillOperationError('invalid', 'Attachment repair must reference the archived prior identity in the same provider; finish this repair before another rename');
        }
        if (!this.deps.onRenamed) throw new SkillOperationError('unavailable', 'Workflow attachment repair is unavailable');
        repairReferencesFrom = input.repairReferencesFrom;
        changedReference = ref;
      }
      const description = input.description ?? current.description;
      const validation = new SkillValidator().validate({ name: next.name, description });
      if (!validation.valid) throw new SkillOperationError('invalid', validation.errors.join('; '));
      const frontmatter = mergeSkillFrontmatter(current.frontmatter, input.frontmatter, input.toolSelectors);
      const metadata = readNexusMetadata(frontmatter);
      if (metadata.error) throw new SkillOperationError('invalid', metadata.error);
      const raw = rt.write.composeSkillMd(next.name, description, input.body ?? current.body, frontmatter);
      const renamed = next.name !== ref.name;
      if (renamed && await rt.adapter.exists(target)) throw new SkillOperationError('invalid', `Skill already exists: ${next.provider}/${next.name}`);
      await rt.write.archiveThenReplace(current.resourceRoot, () => rt.write.writeSkill(current.resourceRoot, raw));
      if (renamed) {
        // Adapter rename carries resource files AND every existing _archive snapshot.
        await rt.write.renameFolder(current.resourceRoot, target);
        changedReference = next;
        repairReferencesFrom = ref;
        const transferred = await this.deps.availability.transferIdentity(ref, next);
        if (!transferred.ok) {
          await rt.write.renameFolder(target, current.resourceRoot);
          changedReference = undefined;
          repairReferencesFrom = undefined;
          await rt.write.writeSkill(current.resourceRoot, rt.write.composeSkillMd(current.name, current.description, current.body, current.frontmatter));
          throw new SkillOperationError('persistence', `Rename rolled back: ${transferred.error.message}`);
        }
        await rt.index.renameRow(ref.provider, ref.name, next.name, target);
      }
      await rt.index.upsertOne({ provider: next.provider, name: next.name, description, vaultPath: target,
        originPath: current.record.originPath, contentHash: hashSkillContent(raw) });
      if (repairReferencesFrom && this.deps.onRenamed) {
        const updated = await this.deps.onRenamed(repairReferencesFrom, next);
        if (!updated.ok) throw new SkillOperationError('persistence', `Skill renamed to ${next.provider}/${next.name}; attachment update from ${repairReferencesFrom.provider}/${repairReferencesFrom.name} failed: ${updated.error.message}`);
      }
      let syncBackError: string | undefined;
      let syncedBackTo: string | undefined;
      if (current.record.originPath && this.getPreferences().syncBackOnEdit) {
        try {
          const record = await rt.index.getOne(next.provider, next.name);
          if (record) syncedBackTo = await new SkillSyncService(rt.adapter, rt.root, rt.index).syncBackOne(record) ?? undefined;
        } catch (error) { syncBackError = error instanceof Error ? error.message : String(error); }
      }
      const detail = await this.detail(rt, next);
      return { ...detail, ...(repairReferencesFrom ? { previousReference: repairReferencesFrom } : {}),
        ...(syncBackError ? { syncBackError } : {}), ...(syncedBackTo ? { syncedBackTo } : {}) };
    }));
    return operation.then(result => !result.ok && changedReference ? { ok: false, error: { ...result.error, reference: { type: 'skill', ...changedReference }, ...(repairReferencesFrom ? { repairReferencesFrom } : {}) } } : result);
  }
  archive(ref: SkillReference, archived: boolean): Promise<ServiceResult<SkillRecord>> {
    return this.perform(async rt => {
      const folder = this.path(rt, ref);
      if (!(await rt.write.exists(folder))) throw new SkillOperationError('not-found', `No skill ${ref.provider}/${ref.name}`);
      await this.refresh(rt);
      const record = await rt.index.getOne(ref.provider, ref.name);
      if (!record) throw new SkillOperationError('not-found', `No skill ${ref.provider}/${ref.name}`);
      const saved = await this.deps.availability.setArchived(ref, archived);
      if (!saved.ok) throw new SkillOperationError('persistence', saved.error.message);
      try { await rt.index.setArchived(ref.provider, ref.name, archived); } catch { /* Durable authority already committed. */ }
      return { ...record, isArchived: archived };
    });
  }
  sync(options: { source?: string; direction?: 'import' | 'sync-back' | 'both' } = {}): Promise<ServiceResult<SkillSyncResult>> {
    return this.afterMutation(this.perform(async rt => {
      if (options.source !== undefined && !isSafePathSegment(options.source)) throw new SkillOperationError('invalid', 'Invalid provider id');
      const sync = new SkillSyncService(rt.adapter, rt.root, rt.index);
      const result: SkillSyncResult = { providers: await sync.discoverProviders(), imported: [], syncedBack: [], skipped: [], archived: [] };
      const direction = options.direction ?? 'both';
      if (!['import', 'sync-back', 'both'].includes(direction)) throw new SkillOperationError('invalid', 'Invalid sync direction');
      if (direction !== 'sync-back') { const imported = await sync.import(options.source); result.imported = imported.imported; result.skipped.push(...imported.skipped); result.archived.push(...imported.archived); }
      await this.refresh(rt);
      if (direction !== 'import') { const back = await sync.syncBack(options.source); result.syncedBack = back.syncedBack; result.skipped.push(...back.skipped); result.archived.push(...back.archived); }
      return result;
    }));
  }
  refreshIndex(options: { importProviders?: boolean } = {}): Promise<ServiceResult<void>> {
    return this.afterMutation(this.perform(async rt => {
      if (options.importProviders) await new SkillSyncService(rt.adapter, rt.root, rt.index).import();
      await this.refresh(rt);
    }));
  }
  async getUsageHistory(ref: SkillReference): Promise<SkillUsageHistory | undefined> {
    const result = await this.perform(rt => new SkillUsageService(rt.sqlite).getUsageHistory(`${ref.provider}/${ref.name}`));
    return result.ok ? result.value : undefined;
  }
  async recordLoaded(refs: readonly SkillReference[]): Promise<void> {
    await this.perform(async rt => {
      for (const ref of refs) {
        const record = await rt.index.getOne(ref.provider, ref.name);
        if (record && !this.deps.availability.isArchived(ref)) await rt.index.touchLoaded(record.id);
      }
    });
  }
}
