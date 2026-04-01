import { ButtonComponent, DropdownComponent, Modal, Notice, TextAreaComponent, TextComponent } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type { NoteLink } from '../../database/repositories/interfaces/ITaskRepository';
import type { EmbeddingService } from '../../services/embeddings/EmbeddingService';
import { NoteInputSuggester } from './NoteInputSuggester';

export interface TaskBoardProjectOption {
  id: string;
  name: string;
}

export interface TaskBoardParentTaskOption {
  id: string;
  title: string;
  projectId: string;
}

export interface TaskBoardEditableTask {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  dueDate: string;
  assignee: string;
  tags: string;
  parentTaskId: string;
  noteLinks: NoteLink[];
}

interface TaskBoardEditModalOptions {
  task: TaskBoardEditableTask;
  projects: TaskBoardProjectOption[];
  parentTasks: TaskBoardParentTaskOption[];
  embeddingService?: EmbeddingService;
  onSave: (task: TaskBoardEditableTask) => Promise<void>;
  onClose?: () => void;
}

export class TaskBoardEditModal extends Modal {
  private draft: TaskBoardEditableTask;
  private parentTaskDropdown: DropdownComponent | null = null;
  private noteSuggesters: NoteInputSuggester[] = [];
  private isSaving = false;

  constructor(app: App, private options: TaskBoardEditModalOptions) {
    super(app);
    this.draft = { ...options.task };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nexus-task-edit-modal');

    contentEl.createEl('h3', {
      text: this.draft.id ? 'Edit task' : 'New task',
      cls: 'nexus-detail-title'
    });

    const form = contentEl.createDiv('nexus-workspace-form');
    const details = form.createDiv('nexus-form-section');
    details.createEl('h4', { text: 'Task details', cls: 'nexus-section-header' });

    // Title
    const titleField = details.createDiv('nexus-form-field');
    titleField.createEl('label', { text: 'Title', cls: 'nexus-form-label' });
    const titleInput = new TextComponent(titleField);
    titleInput.setPlaceholder('Task title');
    titleInput.setValue(this.draft.title);
    titleInput.onChange((value) => { this.draft.title = value; });

    // Description
    const descField = details.createDiv('nexus-form-field');
    descField.createEl('label', { text: 'Description', cls: 'nexus-form-label' });
    const descInput = new TextAreaComponent(descField);
    descInput.setPlaceholder('Optional task description');
    descInput.setValue(this.draft.description);
    descInput.onChange((value) => { this.draft.description = value; });
    descInput.inputEl.rows = 4;

    // Grid of metadata fields
    const metaGrid = details.createDiv('nexus-task-form-grid');

    // Status
    this.renderDropdown(metaGrid, 'Status', this.draft.status, [
      ['todo', 'Todo'], ['in_progress', 'In progress'],
      ['done', 'Done'], ['cancelled', 'Cancelled']
    ], (value) => { this.draft.status = value as TaskBoardEditableTask['status']; }, false);

    // Priority
    this.renderDropdown(metaGrid, 'Priority', this.draft.priority, [
      ['critical', 'Critical'], ['high', 'High'],
      ['medium', 'Medium'], ['low', 'Low']
    ], (value) => { this.draft.priority = value as TaskBoardEditableTask['priority']; }, false);

    // Project
    this.renderDropdown(
      metaGrid, 'Project', this.draft.projectId,
      this.options.projects.map(project => [project.id, project.name] as [string, string]),
      (value) => {
        this.draft.projectId = value;
        if (this.draft.parentTaskId && !this.getParentTaskOptionsForProject(value).some(task => task.id === this.draft.parentTaskId)) {
          this.draft.parentTaskId = '';
        }
        this.refreshParentTaskOptions();
      },
      false
    );

    // Parent task
    const parentField = metaGrid.createDiv('nexus-form-field');
    parentField.createEl('label', { text: 'Parent task', cls: 'nexus-form-label' });
    this.parentTaskDropdown = new DropdownComponent(parentField);
    this.refreshParentTaskOptions();
    this.parentTaskDropdown.onChange((value) => { this.draft.parentTaskId = value; });

    // Assignee
    this.renderTextField(metaGrid, 'Assignee', this.draft.assignee, (value) => {
      this.draft.assignee = value;
    }, 'Optional');

    // Due date
    this.renderDateField(metaGrid, 'Due date', this.draft.dueDate, (value) => {
      this.draft.dueDate = value;
    });

    // Tags (full width, outside grid)
    const tagsField = details.createDiv('nexus-form-field');
    tagsField.createEl('label', { text: 'Tags', cls: 'nexus-form-label' });
    const tagsInput = new TextComponent(tagsField);
    tagsInput.setPlaceholder('Comma-separated tags');
    tagsInput.setValue(this.draft.tags);
    tagsInput.onChange((value) => { this.draft.tags = value; });

    // Linked notes
    this.renderLinkedNotesSection(details);

    // Actions
    const actions = contentEl.createDiv('nexus-form-actions');

    new ButtonComponent(actions)
      .setButtonText('Cancel')
      .onClick(() => this.close());

    new ButtonComponent(actions)
      .setButtonText('Save task')
      .setCta()
      .onClick(() => { void this.handleSave(); });

    // Focus title on open
    titleInput.inputEl.focus();
    titleInput.inputEl.select();
  }

  onClose(): void {
    this.noteSuggesters.forEach(s => s.close());
    this.noteSuggesters = [];
    this.options.onClose?.();
  }

  private getParentTaskOptionsForProject(projectId: string): TaskBoardParentTaskOption[] {
    return this.options.parentTasks.filter(task => task.projectId === projectId && task.id !== this.draft.id);
  }

  private refreshParentTaskOptions(): void {
    if (!this.parentTaskDropdown) return;

    const selectEl = this.parentTaskDropdown.selectEl;
    selectEl.empty();

    this.parentTaskDropdown.addOption('', 'None');
    const options = this.getParentTaskOptionsForProject(this.draft.projectId);
    const parentTaskDropdown = this.parentTaskDropdown;
    options.forEach(task => {
      parentTaskDropdown.addOption(task.id, task.title);
    });
    this.parentTaskDropdown.setValue(this.draft.parentTaskId);
  }

  private renderDropdown(
    container: HTMLElement,
    label: string,
    value: string,
    options: Array<[string, string]>,
    onChange: (value: string) => void,
    includeEmpty = true
  ): void {
    const field = container.createDiv('nexus-form-field');
    field.createEl('label', { text: label, cls: 'nexus-form-label' });
    const dropdown = new DropdownComponent(field);
    if (includeEmpty && !options.some(([optionValue]) => optionValue === '')) {
      dropdown.addOption('', 'None');
    }
    for (const [optionValue, optionLabel] of options) {
      dropdown.addOption(optionValue, optionLabel);
    }
    dropdown.setValue(value || '');
    dropdown.onChange((nextValue) => {
      void onChange(nextValue);
    });
  }

  private renderTextField(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void,
    placeholder = ''
  ): void {
    const field = container.createDiv('nexus-form-field');
    field.createEl('label', { text: label, cls: 'nexus-form-label' });
    const input = new TextComponent(field);
    if (placeholder) input.setPlaceholder(placeholder);
    input.setValue(value);
    input.onChange((nextValue) => {
      void onChange(nextValue);
    });
  }

  private renderDateField(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void
  ): void {
    const field = container.createDiv('nexus-form-field');
    field.createEl('label', { text: label, cls: 'nexus-form-label' });
    const input = field.createEl('input', {
      cls: 'nexus-form-input',
      attr: { type: 'date' }
    });
    input.value = value;
    input.addEventListener('input', () => {
      void onChange(input.value);
    });
  }

  private renderLinkedNotesSection(container: HTMLElement): void {
    const subsection = container.createDiv('nexus-form-field');
    subsection.createEl('label', { text: 'Linked notes', cls: 'nexus-form-label' });

    const listContainer = subsection.createDiv('nexus-item-list');

    const updateList = () => {
      this.noteSuggesters.forEach(s => s.close());
      this.noteSuggesters = [];
      listContainer.empty();

      if (this.draft.noteLinks.length === 0) {
        listContainer.createEl('span', { text: 'None', cls: 'nexus-form-hint' });
      } else {
        this.draft.noteLinks.forEach((link, index) => {
          const item = listContainer.createDiv('nexus-item-row');

          const input = new TextComponent(item);
          input.setPlaceholder('path/to/note.md');
          input.setValue(link.notePath);
          input.onChange((value) => {
            this.draft.noteLinks[index] = { ...this.draft.noteLinks[index], notePath: value };
          });

          const suggester = new NoteInputSuggester(
            this.app,
            input.inputEl,
            this.options.embeddingService ?? null,
            (file: TFile) => {
              this.draft.noteLinks[index] = { ...this.draft.noteLinks[index], notePath: file.path };
            }
          );
          this.noteSuggesters.push(suggester);

          const actions = item.createDiv('nexus-item-actions');

          const typeDropdown = new DropdownComponent(actions);
          typeDropdown.addOption('reference', 'Reference');
          typeDropdown.addOption('input', 'Input');
          typeDropdown.addOption('output', 'Output');
          typeDropdown.setValue(link.linkType || 'reference');
          typeDropdown.onChange((value) => {
            this.draft.noteLinks[index] = {
              ...this.draft.noteLinks[index],
              linkType: value as NoteLink['linkType']
            };
          });

          new ButtonComponent(actions)
            .setButtonText('×')
            .setWarning()
            .onClick(() => {
              this.draft.noteLinks.splice(index, 1);
              updateList();
            });
        });
      }
    };

    updateList();

    new ButtonComponent(subsection)
      .setButtonText('Add note link')
      .onClick(() => {
        this.draft.noteLinks.push({
          taskId: this.draft.id,
          notePath: '',
          linkType: 'reference',
          created: Date.now()
        });
        updateList();
      });
  }

  private async handleSave(): Promise<void> {
    if (!this.draft.title.trim()) {
      new Notice('Task title is required');
      return;
    }

    if (this.isSaving) return;
    this.isSaving = true;

    try {
      await this.options.onSave({
        ...this.draft,
        title: this.draft.title.trim(),
        description: this.draft.description.trim()
      });
      this.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save task';
      new Notice(message);
      this.isSaving = false;
    }
  }
}
