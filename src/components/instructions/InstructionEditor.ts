import { App, ButtonComponent, Component, Notice, Setting } from 'obsidian';
import { BoxedSection } from '../../settings/components/BoxedSection';
import { BackButton } from '../../settings/components/BackButton';
import { InstructionLibraryService, type InstructionDetail } from '../../services/instructions/InstructionLibraryService';
import { draftInstruction, newInstructionDraft, type InstructionDraft } from './InstructionDraft';
import { renderPromptInstructions } from './PromptInstructionEditor';
import { renderSkillInstructions, renderSkillResources } from './SkillInstructionEditor';

/** Shared identity/category shell with type-specific content components. */
export class InstructionEditor {
  readonly draft: InstructionDraft;
  dirty = false;
  private saving = false;
  private errorEl?: HTMLElement;

  constructor(
    private readonly library: InstructionLibraryService,
    private readonly app: App,
    private component: Component,
    detail: InstructionDetail | 'prompt' | 'skill',
    private readonly onBack: () => void,
    private readonly manageSources: () => void
  ) { this.draft = typeof detail === 'string' ? newInstructionDraft(detail) : draftInstruction(detail); this.detail = typeof detail === 'string' ? undefined : detail; }
  private readonly detail?: InstructionDetail;

  render(container: HTMLElement, component = this.component): void {
    this.component = component;
    container.empty();
    new BackButton(container, 'Back to instructions', this.onBack, this.component);
    container.createEl('h3', { text: this.draft.name || `New ${this.draft.type}` });
    container.createSpan({ text: this.draft.type === 'prompt' ? 'Prompt' : 'Skill', cls: 'nexus-instruction-badge' });
    const form = container.createDiv('nexus-workflow-form');
    const changed = () => { this.dirty = true; };
    new BoxedSection(form, { title: 'Details', unbounded: true, body: body => {
      new Setting(body).setName('Name').addText(text => text.setValue(this.draft.name).onChange(value => { this.draft.name = value; changed(); }));
      new Setting(body).setName('Description').setDesc('When should this instruction be used?').addText(text => text.setValue(this.draft.description).onChange(value => { this.draft.description = value; changed(); }));
      new Setting(body).setName('Categories').setDesc('Comma-separated labels for organizing your library.').addText(text => text.setValue(this.draft.categories.join(', ')).onChange(value => { this.draft.categories = value.split(',').map(item => item.trim()).filter(Boolean); changed(); }));
    } }, this.component);
    if (this.draft.type === 'prompt') renderPromptInstructions(form, this.draft, this.component, changed);
    else {
      renderSkillInstructions(form, this.draft, this.component, changed);
      if (this.detail?.type === 'skill') renderSkillResources(form, this.detail.detail, this.app, this.component, this.manageSources);
    }
    this.errorEl = form.createDiv('nexus-instruction-error nexus-instruction-error-hidden');
    const actions = form.createDiv('nexus-form-actions');
    new ButtonComponent(actions).setButtonText('Cancel').onClick(this.onBack);
    const save = new ButtonComponent(actions).setButtonText('Save instruction').setCta();
    save.onClick(() => { void this.save(save); });
  }

  private async save(button: ButtonComponent): Promise<void> {
    if (this.saving) return;
    if (!this.draft.name.trim()) { new Notice('Instruction name is required'); return; }
    this.saving = true;
    button.setDisabled(true);
    try {
      const input = { name: this.draft.name.trim(), description: this.draft.description, body: this.draft.body, categories: this.draft.categories, ...(this.draft.type === 'skill' ? { repairReferencesFrom: this.draft.repairReferencesFrom, toolSelectors: this.draft.toolSelectors, frontmatter: this.draft.frontmatter } : {}) };
      const result = this.draft.reference
        ? await this.library.update(this.draft.reference, input)
        : await this.library.create(this.draft.type === 'skill' ? { ...input, type: 'skill', source: 'nexus' } : { ...input, type: 'prompt' });
      if (!result.ok) {
        if (result.error.reference) this.draft.reference = result.error.reference;
        if (result.error.repairReferencesFrom) this.draft.repairReferencesFrom = result.error.repairReferencesFrom;
        this.errorEl?.setText(result.error.message);
        this.errorEl?.removeClass('nexus-instruction-error-hidden');
        return;
      }
      this.draft.repairReferencesFrom = undefined;
      this.dirty = false;
      new Notice('Instruction saved');
      this.onBack();
    } catch (error) {
      this.errorEl?.setText(`Instruction was not saved: ${error instanceof Error ? error.message : String(error)}`);
      this.errorEl?.removeClass('nexus-instruction-error-hidden');
    } finally { this.saving = false; button.setDisabled(false); }
  }
}
