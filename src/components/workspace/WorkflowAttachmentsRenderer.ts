import { ButtonComponent, Component, Setting } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import type { WorkspaceWorkflow } from '../../database/types/workspace/WorkspaceTypes';
import type { InstructionLibraryService } from '../../services/instructions/InstructionLibraryService';
import { decodeInstructionReference, encodeInstructionReference } from '../../services/instructions/InstructionReferenceCodec';
import type { InstructionSummary, ToolCatalogPort, ServiceResult } from '../../services/instructions/types';
import type { CliToolSchema } from '../../agents/toolManager/types';

export interface WorkflowAttachmentServices {
  getLibrary(): Promise<InstructionLibraryService>;
  getCatalog(): Promise<ToolCatalogPort & { resolveDiscovery(selector: string): ServiceResult<CliToolSchema[]> }>;
}

/** Optional prompt + multi-package/tool attachments built with existing Settings. */
export class WorkflowAttachmentsRenderer {
  private generation = 0;
  private disposed = false;
  private library?: InstructionLibraryService;
  private catalog?: ToolCatalogPort & { resolveDiscovery(selector: string): ServiceResult<CliToolSchema[]> };
  private items: InstructionSummary[] = [];
  private tools: CliToolSchema[] = [];
  private preview?: HTMLElement;

  constructor(private readonly workflow: WorkspaceWorkflow, private readonly services: WorkflowAttachmentServices, private readonly component: Component) {}
  render(container: HTMLElement): void {
    const loading = container.createEl('p', { text: 'Loading workflow attachments…', cls: 'nexus-loading-message' });
    void this.load(container, loading);
  }

  private async load(container: HTMLElement, loading: HTMLElement): Promise<void> {
    try {
      const [library, catalog] = await Promise.all([this.services.getLibrary(), this.services.getCatalog()]);
      const items = await library.list({ includeArchived: true });
      const tools = catalog.resolveDiscovery('--help');
      if (this.disposed) return;
      this.library = library;
      this.catalog = catalog;
      if (!items.ok) throw new Error(items.error.message);
      if (!tools.ok) throw new Error(tools.error.message);
      this.items = items.value;
      this.tools = tools.value;
      loading.remove();
      this.renderPrompt(container);
      this.renderSkills(container);
      this.renderTools(container);
      void this.refreshPreview();
    } catch (error) {
      if (this.disposed) return;
      loading.setText(`Attachments are unavailable: ${error instanceof Error ? error.message : String(error)}`);
      loading.addClass('nexus-instruction-error');
      new ButtonComponent(container).setButtonText('Retry').onClick(() => { container.empty(); this.render(container); });
    }
  }

  private renderPrompt(container: HTMLElement): void {
    new BoxedSection(container, { title: 'Prompt', unbounded: true, body: body => {
      const prompts = this.items.filter(item => item.reference.type === 'prompt');
      new Setting(body).setName('Prompt').setDesc('Optional saved prompt used with this workflow.').addDropdown(dropdown => {
        dropdown.addOption('', 'None');
        for (const prompt of prompts) if (prompt.reference.type === 'prompt' && (prompt.availability === 'available' || prompt.reference.id === this.workflow.promptId)) {
          dropdown.addOption(prompt.reference.id, `${prompt.name}${prompt.availability !== 'available' ? ` (${prompt.availability})` : ''}`);
        }
        if (this.workflow.promptId && !prompts.some(prompt => prompt.reference.type === 'prompt' && prompt.reference.id === this.workflow.promptId)) dropdown.addOption(this.workflow.promptId, `${this.workflow.promptName ?? this.workflow.promptId} (unavailable)`);
        const legacyName = !this.workflow.promptId && this.workflow.promptName;
        if (legacyName) dropdown.addOption('__legacy-name__', `${legacyName} (saved name)`);
        dropdown.setValue(this.workflow.promptId ?? (legacyName ? '__legacy-name__' : '')).onChange(value => {
          if (value === '__legacy-name__') return;
          const prompt = prompts.find(item => item.reference.type === 'prompt' && item.reference.id === value);
          this.workflow.promptId = prompt?.reference.type === 'prompt' ? prompt.reference.id : undefined;
          this.workflow.promptName = prompt?.name;
          void this.refreshPreview();
        });
      });
    } }, this.component);
  }

  private renderSkills(container: HTMLElement): void {
    let list!: HTMLElement;
    new BoxedSection(container, { title: 'Skills', unbounded: true, body: body => {
      new Setting(body).setName('Add skill').setDesc('Load these packages and their required tool schemas.').addDropdown(dropdown => {
        dropdown.addOption('', 'Choose a skill…');
        this.items.filter(item => item.reference.type === 'skill' && item.availability === 'available').forEach(item => { dropdown.addOption(encodeInstructionReference(item.reference), `${item.name} · ${item.source}`); });
        dropdown.onChange(value => {
          const reference = decodeInstructionReference(value);
          if (reference?.type !== 'skill') return;
          const skills = this.workflow.skills ?? [];
          if (!skills.some(item => item.provider === reference.provider && item.name === reference.name)) this.workflow.skills = [...skills, { provider: reference.provider, name: reference.name }];
          dropdown.setValue('');
          this.renderSkillList(list);
          void this.refreshPreview();
        });
      });
      list = body.createDiv();
      this.renderSkillList(list);
    } }, this.component);
  }

  private renderSkillList(list: HTMLElement): void {
    list.empty();
    for (const reference of this.workflow.skills ?? []) {
      const item = this.items.find(item => item.reference.type === 'skill' && item.reference.provider === reference.provider && item.reference.name === reference.name);
      const row = list.createDiv('nexus-workflow-attachment');
      const text = row.createDiv();
      text.createSpan({ text: `${reference.name} · ${reference.provider}` });
      if (!item || item.availability !== 'available') text.createEl('p', { text: `Unavailable attachment: ${item?.availability ?? 'missing'}. It is retained until replaced or removed.`, cls: 'nexus-instruction-error' });
      new ButtonComponent(row).setButtonText('Remove').onClick(() => {
        this.workflow.skills = this.workflow.skills?.filter(item => item.provider !== reference.provider || item.name !== reference.name);
        this.renderSkillList(list);
        void this.refreshPreview();
      });
    }
    if (!this.workflow.skills?.length) list.createEl('p', { text: 'No skills attached.', cls: 'nexus-form-hint' });
  }

  private renderTools(container: HTMLElement): void {
    let list!: HTMLElement;
    new BoxedSection(container, { title: 'Additional tools', unbounded: true, body: body => {
      new Setting(body).setName('Add tool').setDesc('Choose extra tools from the current catalog.').addDropdown(dropdown => {
        dropdown.addOption('', 'Choose a tool…');
        this.tools.forEach(tool => { dropdown.addOption(tool.command, tool.command); });
        dropdown.onChange(value => {
          if (!value) return;
          this.workflow.tools = [...new Set([...(this.workflow.tools ?? []), value])];
          dropdown.setValue('');
          this.renderToolList(list);
          void this.refreshPreview();
        });
      });
      list = body.createDiv();
      this.renderToolList(list);
      this.preview = body.createDiv('nexus-workflow-tool-preview');
    } }, this.component);
  }

  private renderToolList(list: HTMLElement): void {
    list.empty();
    for (const selector of this.workflow.tools ?? []) {
      const row = list.createDiv('nexus-workflow-attachment');
      row.createEl('code', { text: selector });
      if (this.catalog && !this.catalog.resolve([selector]).ok) row.createSpan({ text: 'Unavailable', cls: 'nexus-instruction-error' });
      new ButtonComponent(row).setButtonText('Remove').onClick(() => {
        this.workflow.tools = this.workflow.tools?.filter(item => item !== selector);
        this.renderToolList(list);
        void this.refreshPreview();
      });
    }
  }

  private async refreshPreview(): Promise<void> {
    if (!this.preview || !this.library || !this.catalog) return;
    const generation = ++this.generation;
    this.preview.setText('Checking required tools…');
    try {
      const skills = this.workflow.skills?.length ? await this.library.prepareSkills(this.workflow.skills) : { ok: true as const, value: [] };
      if (this.disposed || generation !== this.generation) return;
      this.preview.empty();
      if (!skills.ok) { this.preview.createEl('p', { text: skills.error.message, cls: 'nexus-instruction-error' }); return; }
      const selectors = [...(this.workflow.tools ?? []), ...skills.value.flatMap(skill => skill.toolSelectors)];
      const union = this.catalog.resolve(selectors);
      if (!union.ok) { this.preview.createEl('p', { text: union.error.message, cls: 'nexus-instruction-error' }); return; }
      this.preview.createEl('p', { text: `${union.value.length} tool schemas will preload.` });
      const requiredBy = new Map<string, string[]>();
      for (const skill of skills.value) {
        const requirements = this.catalog.resolve(skill.toolSelectors);
        if (!requirements.ok) continue;
        for (const schema of requirements.value) requiredBy.set(schema.command, [...(requiredBy.get(schema.command) ?? []), skill.name]);
      }
      const extras = this.catalog.resolve(this.workflow.tools ?? []);
      const extraCommands = new Set(extras.ok ? extras.value.map(schema => schema.command) : []);
      for (const schema of union.value) {
        const row = this.preview.createDiv();
        row.createEl('code', { text: schema.command });
        row.createSpan({ text: requiredBy.has(schema.command) ? ` · required by ${requiredBy.get(schema.command)?.join(', ')}${extraCommands.has(schema.command) ? ' · also selected as an extra' : ''}` : ' · additional tool', cls: 'nexus-form-hint' });
      }
    } catch (error) { if (!this.disposed && generation === this.generation) this.preview.setText(error instanceof Error ? error.message : String(error)); }
  }

  destroy(): void { this.disposed = true; this.generation++; }
}
