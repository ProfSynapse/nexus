import { App, ButtonComponent, Component, Notice, Setting } from 'obsidian';
import { Settings } from '../../settings';
import { SettingsRouter } from '../SettingsRouter';
import { ConfirmModal } from '../components/ConfirmModal';
import { BackButton } from '../components/BackButton';
import { SearchableCardManager } from '../../components/SearchableCardManager';
import type { CardItem } from '../../components/CardManager';
import { InstructionLibraryService } from '../../services/instructions/InstructionLibraryService';
import { decodeInstructionReference, encodeInstructionReference } from '../../services/instructions/InstructionReferenceCodec';
import type { InstructionReference, InstructionSummary } from '../../services/instructions/types';
import { InstructionEditor } from '../../components/instructions/InstructionEditor';
import { InstructionTypeModal } from '../../components/instructions/InstructionTypeModal';
import { renderSkillSources } from '../../components/instructions/SkillSourcesRenderer';

interface InstructionCard extends CardItem { instruction: InstructionSummary }
export interface InstructionsTabServices {
  app: App;
  settings: Settings;
  getLibrary(): Promise<InstructionLibraryService>;
}

/** Reuses the existing prompt card list and detail navigation for both content types. */
export class InstructionsTab {
  private library?: InstructionLibraryService;
  private items: InstructionSummary[] = [];
  private editor?: InstructionEditor;
  private sources = false;
  private query = '';
  private type = '';
  private category = '';
  private source = '';
  private showArchived = false;
  private component = new Component();
  private generation = 0;
  private destroyed = false;
  private active = true;
  private unsubscribe?: () => void;
  private readonly clearGuard: () => void;
  private detailKey?: string;

  constructor(private container: HTMLElement, private readonly router: SettingsRouter, private readonly services: InstructionsTabServices) {
    this.clearGuard = router.setNavigationGuard(next => {
      if (!this.editor?.dirty) {
        if (next.tab !== 'instructions') { this.active = false; this.editor = undefined; this.detailKey = undefined; this.sources = false; this.generation++; }
        return true;
      }
      new Notice('Save or cancel edits before leaving this instruction.');
      return false;
    });
    this.component.load();
    void this.load();
  }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.container.empty();
    this.container.createEl('p', { text: 'Loading instructions…', cls: 'nexus-loading-message' });
    try {
      const library = await this.services.getLibrary();
      const result = await library.list({ includeArchived: true });
      if (this.destroyed || generation !== this.generation) return;
      this.library = library;
      if (!this.unsubscribe) this.unsubscribe = library.metadata.subscribe(() => { if (this.active && !this.editor && !this.sources) void this.load(); });
      if (!result.ok) { this.renderError(result.error.message); return; }
      this.items = result.value;
      this.render();
    } catch (error) {
      if (!this.destroyed && generation === this.generation) this.renderError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Refresh on returning to a clean list; ordinary filter renders retain their loaded snapshot. */
  show(container: HTMLElement): void {
    const returning = !this.active;
    this.active = true;
    this.container = container;
    if (returning && !this.editor && !this.sources && this.router.getState().view === 'list') {
      void this.load();
      return;
    }
    this.render(container);
  }

  render(container = this.container): void {
    this.container = container;
    if (this.destroyed) return;
    this.component.unload();
    this.component = new Component();
    this.component.load();
    this.container.empty();
    if (!this.library) { void this.load(); return; }
    const state = this.router.getState();
    if (state.view === 'detail' && state.detailId && this.detailKey !== state.detailId) {
      this.detailKey = state.detailId;
      const ref = decodeInstructionReference(state.detailId) ?? { type: 'prompt' as const, id: state.detailId };
      void this.openDetail(ref);
      return;
    }
    if (this.editor) { this.editor.render(this.container, this.component); return; }
    if (this.sources) {
      new BackButton(this.container, 'Back to instructions', () => { this.sources = false; void this.load(); }, this.component);
      this.container.createEl('h3', { text: 'Skill sources' });
      renderSkillSources(this.container, this.library, this.services.settings, this.component);
      return;
    }
    this.renderList();
  }

  private renderList(): void {
    this.detailKey = undefined;
    this.container.createEl('h3', { text: 'Instruction library' });
    this.container.createEl('p', { text: 'Manage prompts and skill packages in one place.', cls: 'setting-item-description' });
    const filters = this.container.createDiv('nexus-instruction-filters');
    new Setting(filters).setName('Type').addDropdown(dropdown => dropdown.addOption('', 'All').addOption('prompt', 'Prompts').addOption('skill', 'Skills').setValue(this.type).onChange(value => { this.type = value; this.render(); }));
    new Setting(filters).setName('Category').addDropdown(dropdown => {
      dropdown.addOption('', 'All categories');
      [...new Set(this.items.flatMap(item => item.categories))].sort().forEach(category => { dropdown.addOption(category, category); });
      dropdown.setValue(this.category).onChange(value => { this.category = value; this.render(); });
    });
    new Setting(filters).setName('Source').addDropdown(dropdown => {
      dropdown.addOption('', 'All sources');
      [...new Set(this.items.map(item => item.source))].sort().forEach(source => { dropdown.addOption(source, this.sourceLabel(source)); });
      dropdown.setValue(this.source).onChange(value => { this.source = value; this.render(); });
    });
    new Setting(filters).setName('Show archived').addToggle(toggle => toggle.setValue(this.showArchived).onChange(value => { this.showArchived = value; this.render(); }));
    const cards: InstructionCard[] = this.items.filter(item => (!this.type || item.type === this.type) && (!this.category || item.categories.includes(this.category)) && (!this.source || item.source === this.source) && (this.showArchived || item.availability !== 'archived')).map(item => ({
      id: encodeInstructionReference(item.reference), name: item.name, description: item.description,
      isEnabled: item.availability === 'available', showToggle: false, instruction: item,
      additionalActions: [{ icon: item.availability === 'archived' ? 'archive-restore' : 'archive', label: item.availability === 'archived' ? 'Restore' : 'Archive', onClick: () => { void this.archive(item); } }]
    }));
    new SearchableCardManager<InstructionCard>({ containerEl: this.container, items: cards,
      cardManagerConfig: { title: 'Instructions', addButtonText: '+ New instruction', emptyStateText: this.items.length ? 'No instructions match these filters.' : 'No instructions yet. Create a prompt or a skill to get started.', showToggle: false, component: this.component,
        onAdd: () => new InstructionTypeModal(this.services.app, type => {
          if (!this.library) return;
          this.editor = new InstructionEditor(this.library, this.services.app, this.component, type, () => { void this.leaveEditor(); }, () => { void this.leaveEditor(true); });
          this.render();
        }).open(),
        onToggle: () => undefined,
        onEdit: item => this.router.showDetail(item.id),
        renderMetadata: (host, card) => {
          const item = card.instruction;
          const meta = host.createDiv('nexus-instruction-meta');
          meta.createSpan({ text: item.type === 'prompt' ? 'Prompt' : 'Skill', cls: 'nexus-instruction-badge' });
          meta.createSpan({ text: this.sourceLabel(item.source) });
          item.categories.forEach(category => meta.createSpan({ text: category, cls: 'nexus-instruction-badge' }));
          if (item.availability === 'archived') meta.createSpan({ text: 'Archived', cls: 'nexus-instruction-badge' });
          if (item.availability === 'unavailable') host.createEl('p', { text: 'Unavailable: this instruction could not be read. Open it for details.', cls: 'nexus-instruction-error' });
        }
      }, search: { placeholder: 'Search instructions…', minItemsForSearch: 0, initialQuery: this.query, onQueryChange: value => { this.query = value; }, filterFn: (item, query) => [item.name, item.description ?? '', ...item.instruction.categories].some(value => value.toLowerCase().includes(query)) }
    });
    const sources = this.container.createDiv('nexus-instruction-source-summary');
    new Setting(sources).setName('Skill sources').setDesc('Manage provider import and edit sync preferences.').addButton(button => button.setButtonText('Manage sources').onClick(() => { this.sources = true; this.render(); }));
  }

  private async openDetail(reference: InstructionReference): Promise<void> {
    if (!this.library) return;
    const generation = ++this.generation;
    this.container.createEl('p', { text: 'Loading instruction…', cls: 'nexus-loading-message' });
    try {
      const result = await this.library.getDetail(reference);
      if (this.destroyed || generation !== this.generation) return;
      if (!result.ok) { this.renderError(result.error.message, true); return; }
      this.editor = new InstructionEditor(this.library, this.services.app, this.component, result.value, () => { void this.leaveEditor(); }, () => { void this.leaveEditor(true); });
      this.render();
    } catch (error) { if (!this.destroyed && generation === this.generation) this.renderError(error instanceof Error ? error.message : String(error), true); }
  }

  private async leaveEditor(sources = false): Promise<void> {
    if (this.editor?.dirty && !await ConfirmModal.confirm(this.services.app, { variant: 'remove', title: 'Discard unsaved edits?', body: 'Your changes to this instruction have not been saved.', ctaLabel: 'Discard edits' })) return;
    this.editor = undefined;
    this.detailKey = undefined;
    this.sources = sources;
    this.router.back();
    if (!sources) await this.load();
  }

  private async archive(item: InstructionSummary): Promise<void> {
    if (!this.library) return;
    const result = await this.library.archive(item.reference, item.availability !== 'archived');
    if (!result.ok) { new Notice(result.error.message); return; }
    await this.load();
  }

  private renderError(message: string, detail = false): void {
    this.container.empty();
    if (detail) new BackButton(this.container, 'Back to instructions', () => { this.detailKey = undefined; this.router.back(); }, this.component);
    this.container.createEl('p', { text: message, cls: 'nexus-instruction-error' });
    new ButtonComponent(this.container).setButtonText('Retry').onClick(() => { if (detail) this.detailKey = undefined; void this.load(); });
  }

  private sourceLabel(source: string): string { return source === 'native' ? 'Nexus prompts' : source === 'nexus' ? 'Nexus skills' : source.charAt(0).toUpperCase() + source.slice(1); }
  destroy(): void { this.destroyed = true; this.generation++; this.unsubscribe?.(); this.clearGuard(); this.component.unload(); }
}
