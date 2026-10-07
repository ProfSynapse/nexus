import { decodeInstructionReference, encodeInstructionReference, normalizeInstructionCategories } from './InstructionReferenceCodec';
import type { InstructionLibrarySettings, InstructionLibraryItemSettings, InstructionReference, ServiceResult, SkillAvailabilityPort, SkillReference } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeInstructionLibrarySettings(value: unknown): InstructionLibrarySettings {
  const normalized: InstructionLibrarySettings = { version: 1, items: {} };
  if (!isObject(value) || (value.version !== undefined && value.version !== 1)) return normalized;
  if (isObject(value.items)) {
    for (const [key, item] of Object.entries(value.items)) {
      const reference = decodeInstructionReference(key);
      if (!reference || !isObject(item)) continue;
      const settings: InstructionLibraryItemSettings = {};
      if (Array.isArray(item.categories)) settings.categories = normalizeInstructionCategories(item.categories);
      if (reference.type === 'skill' && typeof item.archived === 'boolean') settings.archived = item.archived;
      normalized.items[encodeInstructionReference(reference)] = settings;
    }
  }
  if (value.skillArchiveImportComplete === true) normalized.skillArchiveImportComplete = true;
  return normalized;
}

export interface InstructionMetadataSettingsBridge {
  getSettings(): unknown;
  setSettings(settings: InstructionLibrarySettings): void;
  saveSettings(): Promise<void>;
}

/** A single live writer; effective reads only change once the normal settings save succeeds. */
export class InstructionMetadataService implements SkillAvailabilityPort {
  private queue: Promise<void> = Promise.resolve();
  private committed: InstructionLibrarySettings;
  private saving = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly settings: InstructionMetadataSettingsBridge) {
    this.committed = normalizeInstructionLibrarySettings(settings.getSettings());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Call after an external settings reload to refresh subscribers as well as read projections. */
  invalidate(): void {
    if (!this.saving) this.committed = normalizeInstructionLibrarySettings(this.settings.getSettings());
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('[InstructionMetadataService] Refresh listener failed:', error); }
    }
  }

  private current(): InstructionLibrarySettings {
    if (!this.saving) this.committed = normalizeInstructionLibrarySettings(this.settings.getSettings());
    return this.committed;
  }

  getItem(reference: InstructionReference): InstructionLibraryItemSettings | undefined {
    const item = this.current().items[encodeInstructionReference(reference)];
    return item ? { ...item, ...(item.categories ? { categories: [...item.categories] } : {}) } : undefined;
  }

  categories(reference: InstructionReference, declared?: unknown): string[] {
    return this.getItem(reference)?.categories ?? normalizeInstructionCategories(declared);
  }

  isArchived(reference: SkillReference): boolean {
    return this.getItem({ type: 'skill', ...reference })?.archived === true;
  }

  setCategories(reference: InstructionReference, categories: readonly string[]): Promise<ServiceResult<void>> {
    return this.mutate(next => {
      const key = encodeInstructionReference(reference);
      next.items[key] = { ...next.items[key], categories: normalizeInstructionCategories(categories) };
    });
  }

  clearCategoryOverride(reference: InstructionReference): Promise<ServiceResult<void>> {
    return this.mutate(next => {
      const item = next.items[encodeInstructionReference(reference)];
      if (item) delete item.categories;
    });
  }

  setArchived(reference: SkillReference, archived: boolean): Promise<ServiceResult<void>> {
    return this.mutate(next => {
      const key = encodeInstructionReference({ type: 'skill', ...reference });
      next.items[key] = { ...next.items[key], archived };
    });
  }

  ensureLegacyArchiveImported(rows: readonly (SkillReference & { isArchived: boolean })[], queryReady: boolean): Promise<ServiceResult<void>> {
    if (this.current().skillArchiveImportComplete) return Promise.resolve({ ok: true, value: undefined });
    if (!queryReady) return Promise.resolve({ ok: false, error: { code: 'initializing', message: 'Skills index is not query-ready; archive migration has not run.' } });
    return this.mutate(next => {
      if (next.skillArchiveImportComplete) return;
      for (const row of rows) {
        const key = encodeInstructionReference({ type: 'skill', provider: row.provider, name: row.name });
        if (row.isArchived && next.items[key]?.archived === undefined) next.items[key] = { ...next.items[key], archived: true };
      }
      next.skillArchiveImportComplete = true;
    });
  }

  transferIdentity(from: SkillReference, to: SkillReference): Promise<ServiceResult<void>> {
    const oldKey = encodeInstructionReference({ type: 'skill', ...from });
    const newKey = encodeInstructionReference({ type: 'skill', ...to });
    if (oldKey === newKey) return Promise.resolve({ ok: true, value: undefined });
    return this.mutate(next => {
      if (Object.prototype.hasOwnProperty.call(next.items, newKey)) throw new Error('The destination skill identity already has instruction preferences.');
      if (next.items[oldKey]) {
        next.items[newKey] = next.items[oldKey];
      }
      // Provider sync can reintroduce the old folder; retain an archive tombstone for it.
      next.items[oldKey] = { archived: true };
    }, 'invalid');
  }

  private mutate(update: (next: InstructionLibrarySettings) => void, updateError: 'invalid' | 'persistence' = 'persistence'): Promise<ServiceResult<void>> {
    const operation = this.queue.then(async (): Promise<ServiceResult<void>> => {
      const previous = this.current();
      const next = normalizeInstructionLibrarySettings(previous);
      try { update(next); }
      catch (error) { return { ok: false, error: { code: updateError, message: error instanceof Error ? error.message : String(error) } }; }
      this.saving = true;
      this.settings.setSettings(next);
      try {
        await this.settings.saveSettings();
        this.committed = next;
        this.notify();
        return { ok: true, value: undefined };
      } catch (error) {
        this.settings.setSettings(previous);
        return { ok: false, error: { code: 'persistence', message: `Instruction preferences were not saved: ${error instanceof Error ? error.message : String(error)}` } };
      } finally { this.saving = false; }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
