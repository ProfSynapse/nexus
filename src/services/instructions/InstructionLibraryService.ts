import type { CustomPrompt } from '../../types';
import { InstructionMetadataService } from './InstructionMetadataService';
import { PromptInstructionAdapter, type PromptInstructionStorage } from './PromptInstructionAdapter';
import { SkillInstructionAdapter } from './SkillInstructionAdapter';
import type { InstructionPreparationPort, InstructionReference, InstructionSkillMutationPort, InstructionSkillPort, InstructionSummary, PreparedInstruction, ServiceResult, SkillCreateInput, SkillDetail, SkillReference, SkillSyncResult, SkillUpdateInput } from './types';

export interface InstructionLibraryFilters {
  type?: 'prompt' | 'skill';
  category?: string;
  source?: string;
  search?: string;
  availability?: 'available' | 'archived' | 'unavailable';
  includeArchived?: boolean;
}
export type InstructionDetail =
  | { type: 'prompt'; reference: { type: 'prompt'; id: string }; name: string; description: string; body: string; categories: string[]; archived: boolean; prompt: CustomPrompt }
  | { type: 'skill'; categories: string[]; detail: SkillDetail };
export type InstructionCreateInput =
  | { type: 'prompt'; name: string; description: string; body: string; categories?: string[] }
  | ({ type: 'skill'; categories?: string[] } & SkillCreateInput);
export type InstructionUpdateInput = { repairReferencesFrom?: SkillReference; name?: string; description?: string; body?: string; categories?: string[]; frontmatter?: Record<string, unknown>; toolSelectors?: string[] };

/** A projection over existing content authorities, with one shared organization writer. */
export class InstructionLibraryService implements InstructionPreparationPort {
  readonly prompts: PromptInstructionAdapter;
  readonly skills: SkillInstructionAdapter;

  constructor(prompts: PromptInstructionStorage, skills: InstructionSkillPort, readonly metadata: InstructionMetadataService, mutations?: InstructionSkillMutationPort) {
    this.prompts = new PromptInstructionAdapter(prompts);
    this.skills = new SkillInstructionAdapter(skills, mutations);
  }

  async list(filters: InstructionLibraryFilters = {}): Promise<ServiceResult<InstructionSummary[]>> {
    const items: InstructionSummary[] = [];
    if (filters.type !== 'skill') {
      for (const prompt of this.prompts.storage.getAllPrompts()) {
        const reference = { type: 'prompt' as const, id: prompt.id };
        items.push({ reference, type: 'prompt', name: prompt.name, description: prompt.description, categories: this.metadata.categories(reference), source: 'native', availability: prompt.isEnabled ? 'available' : 'archived' });
      }
    }
    if (filters.type !== 'prompt') {
      const result = await this.skills.port.list({ includeArchived: true, source: filters.source === 'native' ? undefined : filters.source });
      if (!result.ok) return result;
      for (const record of result.value) {
        const reference = { type: 'skill' as const, provider: record.provider, name: record.name };
        items.push({ reference, type: 'skill', name: record.name, description: record.description,
          categories: this.metadata.categories(reference, record.declaredCategories),
          source: record.provider, availability: this.metadata.isArchived(reference) ? 'archived' : record.availability ?? 'available' });
      }
    }
    const search = filters.search?.trim().toLocaleLowerCase();
    return { ok: true, value: items.filter(item =>
      (!filters.source || item.source === filters.source)
      && (!filters.category || item.categories.includes(filters.category))
      && (filters.availability ? item.availability === filters.availability : filters.includeArchived || item.availability !== 'archived')
      && (!search || [item.name, item.description, ...item.categories].some(value => value.toLocaleLowerCase().includes(search))))
      .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source)) };
  }

  async getDetail(reference: InstructionReference): Promise<ServiceResult<InstructionDetail>> {
    if (reference.type === 'prompt') {
      const result = this.prompts.resolve(reference.id);
      if (!result.ok) return result;
      const prompt = result.value;
      return { ok: true, value: { type: 'prompt', reference, name: prompt.name, description: prompt.description, body: prompt.prompt, categories: this.metadata.categories(reference), archived: !prompt.isEnabled, prompt } };
    }
    const result = await this.skills.port.getDetail(reference);
    if (!result.ok) return result;
    return { ok: true, value: { type: 'skill', detail: result.value, categories: this.metadata.categories(reference, result.value.declaredCategories) } };
  }

  preparePrompt(id?: string, name?: string): Promise<ServiceResult<PreparedInstruction>> { return Promise.resolve(this.prompts.prepare(id, name)); }
  async prepareSkills(references: readonly SkillReference[]): Promise<ServiceResult<PreparedInstruction[]>> { return this.skills.prepare(references); }

  async create(input: InstructionCreateInput): Promise<ServiceResult<InstructionDetail>> {
    let persistedReference: InstructionReference | undefined;
    try {
      let reference: InstructionReference;
      if (input.type === 'prompt') {
        const prompt = await this.prompts.storage.createPrompt({ name: input.name, description: input.description, prompt: input.body, isEnabled: true });
        reference = { type: 'prompt', id: prompt.id };
      } else {
        if (!this.skills.mutations) return this.readOnly();
        const created = await this.skills.mutations.create(input);
        if (!created.ok) return created;
        reference = { type: 'skill', ...created.value.reference };
      }
      persistedReference = reference;
      if (input.categories !== undefined) {
        const saved = await this.metadata.setCategories(reference, input.categories);
        if (!saved.ok) return { ok: false, error: { ...saved.error, message: `Instruction was created, but its categories were not saved. ${saved.error.message}`, reference } };
      }
      return await this.reloadSavedInstruction(reference, 'created');
    } catch (error) { return this.mutationError(error, persistedReference, 'created'); }
  }

  async update(reference: InstructionReference, input: InstructionUpdateInput): Promise<ServiceResult<InstructionDetail>> {
    let persistedReference: InstructionReference | undefined;
    try {
      let nextReference = reference;
      if (reference.type === 'prompt') {
        const found = this.prompts.resolve(reference.id);
        if (!found.ok) return found;
        await this.prompts.storage.updatePrompt(reference.id, {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.body !== undefined ? { prompt: input.body } : {})
        });
      } else {
        if (!this.skills.mutations) return this.readOnly();
        const update: SkillUpdateInput = { description: input.description, body: input.body, rename: input.name, frontmatter: input.frontmatter, toolSelectors: input.toolSelectors, repairReferencesFrom: input.repairReferencesFrom };
        const result = await this.skills.mutations.update(reference, update);
        if (!result.ok) return result;
        nextReference = { type: 'skill', ...result.value.reference };
      }
      persistedReference = nextReference;
      if (input.categories !== undefined) {
        const saved = await this.metadata.setCategories(nextReference, input.categories);
        if (!saved.ok) return { ok: false, error: { ...saved.error, message: `Instruction content was updated, but its categories were not saved. ${saved.error.message}`, reference: nextReference } };
      }
      return await this.reloadSavedInstruction(nextReference, 'updated');
    } catch (error) { return this.mutationError(error, persistedReference, 'updated'); }
  }

  async archive(reference: InstructionReference, archived = true): Promise<ServiceResult<void>> {
    if (reference.type === 'skill') {
      if (!this.skills.mutations) return this.readOnly();
      const result = await this.skills.mutations.archive(reference, archived);
      return result.ok ? { ok: true, value: undefined } : result;
    }
    const found = this.prompts.resolve(reference.id);
    if (!found.ok) return found;
    try { await this.prompts.storage.updatePrompt(reference.id, { isEnabled: !archived }); return { ok: true, value: undefined }; }
    catch (error) { return this.persistenceError(error); }
  }

  syncSkills(options: { source?: string; direction: 'import' | 'sync-back' | 'both' }): Promise<ServiceResult<SkillSyncResult>> {
    return this.skills.mutations ? this.skills.mutations.sync(options) : Promise.resolve(this.readOnly());
  }

  private readOnly(): ServiceResult<never> { return { ok: false, error: { code: 'unavailable', message: 'Skill editing is unavailable while the core skill runtime initializes.' } }; }
  private async reloadSavedInstruction(reference: InstructionReference, action: 'created' | 'updated'): Promise<ServiceResult<InstructionDetail>> {
    const detail = await this.getDetail(reference);
    return detail.ok ? detail : { ok: false, error: { ...detail.error, reference, message: `Instruction was ${action}, but its saved details could not be reloaded. ${detail.error.message}` } };
  }
  private mutationError(error: unknown, reference: InstructionReference | undefined, action: 'created' | 'updated'): ServiceResult<never> {
    const message = error instanceof Error ? error.message : String(error);
    return reference ? { ok: false, error: { code: 'persistence', reference, message: `Instruction was ${action}, but completing its saved details failed. ${message}` } } : this.persistenceError(error);
  }
  private persistenceError(error: unknown): ServiceResult<never> { return { ok: false, error: { code: 'persistence', message: error instanceof Error ? error.message : String(error) } }; }
}
