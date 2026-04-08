import { Component, Notice, setIcon, type App } from 'obsidian';
import type { TaskStatus } from '../../../database/repositories/interfaces/ITaskRepository';
import { STATUS_COLUMNS, type SwimlaneGroup, type TaskBoardTask } from '../taskBoardTypes';

interface TaskBoardRendererDependencies {
  app: App;
  component: Component;
  getDragTaskId: () => string | null;
  setDragTaskId: (taskId: string | null) => void;
  getCollapsedSwimlanes: () => Set<string>;
  groupTasksByParent: (columnTasks: TaskBoardTask[]) => SwimlaneGroup[];
  onTaskStatusDrop: (taskId: string, newStatus: TaskStatus) => Promise<void>;
  onEditTask: (task: TaskBoardTask) => void;
  onFlushPendingEvent: () => Promise<void>;
}

export class TaskBoardRenderer {
  constructor(private readonly deps: TaskBoardRendererDependencies) {}

  renderColumns(container: HTMLElement, filteredTasks: TaskBoardTask[]): void {
    container.empty();
    const columns = container.createDiv('nexus-task-board-columns');

    STATUS_COLUMNS.forEach(column => {
      const columnEl = columns.createDiv('nexus-task-board-column');
      const header = columnEl.createDiv('nexus-task-board-column-header');
      header.createEl('h3', { text: column.label });

      const columnTasks = filteredTasks.filter(task => task.status === column.id);
      const body = columnEl.createDiv('nexus-task-board-column-body');
      body.dataset.status = column.id;

      this.safeRegisterDomEvent(body, 'dragover', (event: DragEvent) => {
        event.preventDefault();
        body.addClass('is-drop-target');
      });
      this.safeRegisterDomEvent(body, 'dragleave', () => body.removeClass('is-drop-target'));
      this.safeRegisterDomEvent(body, 'drop', (event: DragEvent) => {
        event.preventDefault();
        body.removeClass('is-drop-target');
        const taskId = this.deps.getDragTaskId();
        this.deps.setDragTaskId(null);
        if (!taskId) {
          return;
        }
        void this.deps.onTaskStatusDrop(taskId, column.id);
      });

      const groups = this.deps.groupTasksByParent(columnTasks);
      const cardCount = groups.reduce((sum, group) => sum + group.children.length, 0);

      header.createEl('span', {
        cls: 'nexus-task-board-column-count',
        text: String(cardCount)
      });

      if (cardCount === 0) {
        body.createDiv({
          cls: 'nexus-task-board-empty-column',
          text: 'No tasks'
        });
        return;
      }

      groups.forEach(group => {
        this.renderSwimlane(body, group, column.id);
      });
    });
  }

  private renderSwimlane(container: HTMLElement, group: SwimlaneGroup, columnStatus: TaskStatus): void {
    const swimlane = container.createDiv('nexus-task-board-swimlane');
    const collapsedSwimlanes = this.deps.getCollapsedSwimlanes();
    const collapseKey = `${columnStatus}::${group.parentId || '__ungrouped'}`;
    const isCollapsed = collapsedSwimlanes.has(collapseKey);

    if (isCollapsed) {
      swimlane.addClass('is-collapsed');
    }

    const headerEl = swimlane.createDiv('nexus-task-board-swimlane-header');

    if (group.parentTask) {
      const toggleBtn = headerEl.createEl('button', {
        cls: 'clickable-icon nexus-task-board-swimlane-toggle',
        attr: {
          'aria-label': `Toggle ${group.parentTask.title}`,
          'aria-expanded': String(!isCollapsed),
          type: 'button'
        }
      });
      setIcon(toggleBtn, isCollapsed ? 'chevron-right' : 'chevron-down');

      this.safeRegisterDomEvent(toggleBtn, 'click', () => {
        if (collapsedSwimlanes.has(collapseKey)) {
          collapsedSwimlanes.delete(collapseKey);
          swimlane.removeClass('is-collapsed');
          toggleBtn.setAttribute('aria-expanded', 'true');
          setIcon(toggleBtn, 'chevron-down');
        } else {
          collapsedSwimlanes.add(collapseKey);
          swimlane.addClass('is-collapsed');
          toggleBtn.setAttribute('aria-expanded', 'false');
          setIcon(toggleBtn, 'chevron-right');
        }
      });

      headerEl.createDiv({
        cls: 'nexus-task-board-swimlane-title',
        text: group.parentTask.title
      });

      headerEl.createDiv({
        cls: 'nexus-task-board-swimlane-progress',
        text: `${group.progress.done}/${group.progress.total}`
      });
    } else {
      swimlane.addClass('nexus-task-board-swimlane-ungrouped');
      headerEl.createDiv({
        cls: 'nexus-task-board-swimlane-title',
        text: 'Ungrouped'
      });
    }

    const bodyEl = swimlane.createDiv('nexus-task-board-swimlane-body');
    group.children.forEach(task => {
      this.renderTaskCard(bodyEl, task);
    });
  }

  private renderTaskCard(container: HTMLElement, task: TaskBoardTask): void {
    const card = container.createDiv('nexus-task-board-card');
    card.draggable = true;

    this.safeRegisterDomEvent(card, 'dragstart', (event: DragEvent) => {
      this.deps.setDragTaskId(task.id);
      card.addClass('is-dragging');
      event.dataTransfer?.setData('text/plain', task.id);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
      }
    });

    this.safeRegisterDomEvent(card, 'dragend', () => {
      card.removeClass('is-dragging');
      this.deps.setDragTaskId(null);
      void this.deps.onFlushPendingEvent();
    });

    const row = card.createDiv('nexus-task-board-card-row');
    row.createDiv({
      cls: 'nexus-task-board-card-title',
      text: task.title
    });

    const editButton = row.createEl('button', {
      cls: 'clickable-icon nexus-task-board-icon-button',
      attr: {
        'aria-label': `Edit ${task.title}`,
        type: 'button'
      }
    });
    setIcon(editButton, 'edit');
    this.safeRegisterDomEvent(editButton, 'click', (event: MouseEvent) => {
      event.stopPropagation();
      this.deps.onEditTask(task);
    });

    card.createDiv({
      cls: 'nexus-task-board-card-meta',
      text: `${task.workspaceName} · ${task.projectName}`
    });

    if (task.noteLinks.length > 0) {
      const linksRow = card.createDiv('nexus-task-board-card-links');
      task.noteLinks.forEach(link => {
        const fileName = link.notePath.split('/').pop()?.replace(/\.md$/, '') || link.notePath;
        const linkEl = linksRow.createEl('a', {
          cls: 'nexus-task-board-card-link',
          text: fileName,
          attr: { 'aria-label': link.notePath }
        });
        this.safeRegisterDomEvent(linkEl, 'click', (event: MouseEvent) => {
          event.stopPropagation();
          const file = this.deps.app.vault.getFileByPath(link.notePath);
          if (file) {
            void this.deps.app.workspace.getLeaf(false).openFile(file);
          } else {
            new Notice(`File not found: ${link.notePath}`);
          }
        });
      });
    }
  }

  private safeRegisterDomEvent<K extends keyof HTMLElementEventMap>(
    element: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    this.deps.component.registerDomEvent(element, type, handler);
  }
}
