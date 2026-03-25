import { Component, Modal, Notice, setIcon } from 'obsidian';
import type { App } from 'obsidian';

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
}

interface TaskBoardEditModalOptions {
  task: TaskBoardEditableTask;
  projects: TaskBoardProjectOption[];
  parentTasks: TaskBoardParentTaskOption[];
  onSave: (task: TaskBoardEditableTask) => Promise<void>;
  onClose?: () => void;
}

export class TaskBoardEditModal extends Modal {
  private draft: TaskBoardEditableTask;
  private projectSelect!: HTMLSelectElement;
  private parentTaskSelect!: HTMLSelectElement;
  private titleInput!: HTMLInputElement;
  private descriptionInput!: HTMLTextAreaElement;
  private statusSelect!: HTMLSelectElement;
  private prioritySelect!: HTMLSelectElement;
  private assigneeInput!: HTMLInputElement;
  private dueDateInput!: HTMLInputElement;
  private tagsInput!: HTMLInputElement;
  private saveButton!: HTMLButtonElement;

  constructor(app: App, private options: TaskBoardEditModalOptions) {
    super(app);
    this.draft = { ...options.task };
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('nexus-task-board-modal');

    const shell = contentEl.createDiv('nexus-task-board-modal-shell');
    const header = shell.createDiv('nexus-task-board-modal-header');
    const titleWrap = header.createDiv();
    titleWrap.createDiv({ cls: 'nexus-task-board-modal-kicker', text: 'Task details' });
    titleWrap.createEl('h2', { text: 'Edit task' });

    const closeButton = header.createEl('button', {
      cls: 'clickable-icon nexus-task-board-icon-button',
      attr: { 'aria-label': 'Close dialog', type: 'button' }
    });
    setIcon(closeButton, 'x');
    this.registerModalDomEvent(closeButton, 'click', () => this.close());

    const form = shell.createDiv('nexus-task-board-modal-form');

    this.titleInput = this.createTextField(form, 'Title', this.draft.title, (value) => {
      this.draft.title = value;
    });
    this.titleInput.placeholder = 'Task title';

    this.descriptionInput = this.createTextAreaField(form, 'Description', this.draft.description, (value) => {
      this.draft.description = value;
    });
    this.descriptionInput.placeholder = 'Task description';

    const grid = form.createDiv('nexus-task-board-modal-grid');
    this.statusSelect = this.createSelectField(grid, 'Status', [
      ['todo', 'Todo'],
      ['in_progress', 'In progress'],
      ['done', 'Done'],
      ['cancelled', 'Cancelled']
    ], this.draft.status, (value) => {
      this.draft.status = value as TaskBoardEditableTask['status'];
    });

    this.prioritySelect = this.createSelectField(grid, 'Priority', [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['medium', 'Medium'],
      ['low', 'Low']
    ], this.draft.priority, (value) => {
      this.draft.priority = value as TaskBoardEditableTask['priority'];
    });

    this.projectSelect = this.createSelectField(
      grid,
      'Project',
      this.options.projects.map(project => [project.id, project.name]),
      this.draft.projectId,
      (value) => {
        this.draft.projectId = value;
        if (this.draft.parentTaskId && !this.getParentTaskOptionsForProject(value).some(task => task.id === this.draft.parentTaskId)) {
          this.draft.parentTaskId = '';
        }
        this.renderParentTaskOptions();
      }
    );

    this.parentTaskSelect = this.createSelectField(grid, 'Parent task', [], '', (value) => {
      this.draft.parentTaskId = value;
    });
    this.renderParentTaskOptions();

    this.assigneeInput = this.createTextField(grid, 'Assignee', this.draft.assignee, (value) => {
      this.draft.assignee = value;
    });
    this.assigneeInput.placeholder = 'Optional';

    this.dueDateInput = this.createTextField(grid, 'Due date', this.draft.dueDate, (value) => {
      this.draft.dueDate = value;
    });
    this.dueDateInput.type = 'date';

    this.tagsInput = this.createTextField(form, 'Tags', this.draft.tags, (value) => {
      this.draft.tags = value;
    });
    this.tagsInput.placeholder = 'Comma-separated tags';

    const footer = shell.createDiv('nexus-task-board-modal-footer');
    footer.createDiv({
      cls: 'nexus-task-board-modal-note',
      text: 'Use drag and drop on the board for quick status changes. Use this dialog for field edits.'
    });

    const actions = footer.createDiv('nexus-task-board-modal-actions');
    const cancelButton = actions.createEl('button', {
      cls: 'mod-cta nexus-task-board-button nexus-task-board-button-secondary',
      text: 'Cancel',
      attr: { type: 'button' }
    });
    this.registerModalDomEvent(cancelButton, 'click', () => this.close());

    this.saveButton = actions.createEl('button', {
      cls: 'mod-cta nexus-task-board-button',
      text: 'Save task',
      attr: { type: 'button' }
    });
    this.registerModalDomEvent(this.saveButton, 'click', () => {
      void this.handleSave();
    });

    this.titleInput.focus();
    this.titleInput.select();
  }

  onClose(): void {
    this.options.onClose?.();
  }

  private getParentTaskOptionsForProject(projectId: string): TaskBoardParentTaskOption[] {
    return this.options.parentTasks.filter(task => task.projectId === projectId && task.id !== this.draft.id);
  }

  private registerModalDomEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    (this as unknown as Component).registerDomEvent(element, type, handler as EventListener);
  }

  private renderParentTaskOptions(): void {
    this.parentTaskSelect.empty();
    this.parentTaskSelect.createEl('option', { value: '', text: 'None' });
    const options = this.getParentTaskOptionsForProject(this.draft.projectId);
    options.forEach(task => {
      this.parentTaskSelect.createEl('option', {
        value: task.id,
        text: task.title
      });
    });
    this.parentTaskSelect.value = this.draft.parentTaskId;
  }

  private createField(container: HTMLElement, label: string): HTMLElement {
    const field = container.createDiv('nexus-task-board-field');
    field.createEl('label', { cls: 'nexus-task-board-field-label', text: label });
    return field;
  }

  private createTextField(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void
  ): HTMLInputElement {
    const field = this.createField(container, label);
    const input = field.createEl('input', {
      cls: 'nexus-task-board-input',
      attr: { type: 'text' }
    });
    input.value = value;
    this.registerModalDomEvent(input, 'input', () => onChange(input.value));
    return input;
  }

  private createTextAreaField(
    container: HTMLElement,
    label: string,
    value: string,
    onChange: (value: string) => void
  ): HTMLTextAreaElement {
    const field = this.createField(container, label);
    const textarea = field.createEl('textarea', {
      cls: 'nexus-task-board-input nexus-task-board-textarea'
    });
    textarea.value = value;
    textarea.rows = 4;
    this.registerModalDomEvent(textarea, 'input', () => onChange(textarea.value));
    return textarea;
  }

  private createSelectField(
    container: HTMLElement,
    label: string,
    options: Array<[string, string]>,
    value: string,
    onChange: (value: string) => void
  ): HTMLSelectElement {
    const field = this.createField(container, label);
    const select = field.createEl('select', {
      cls: 'nexus-task-board-input'
    });
    options.forEach(([optionValue, optionLabel]) => {
      select.createEl('option', {
        value: optionValue,
        text: optionLabel
      });
    });
    select.value = value;
    this.registerModalDomEvent(select, 'change', () => onChange(select.value));
    return select;
  }

  private async handleSave(): Promise<void> {
    if (!this.draft.title.trim()) {
      new Notice('Task title is required');
      return;
    }

    this.saveButton.disabled = true;
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
      this.saveButton.disabled = false;
    }
  }
}
