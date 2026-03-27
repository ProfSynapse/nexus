import {
  ItemView,
  Notice,
  setIcon,
  type WorkspaceLeaf,
  type ViewStateResult
} from 'obsidian';
import type NexusPlugin from '../../main';
import type { WorkspaceService } from '../../services/WorkspaceService';
import type { AgentRegistrationService } from '../../services/agent/AgentRegistrationService';
import type { AgentManager } from '../../services/AgentManager';
import type { WorkspaceMetadata } from '../../types/storage/StorageTypes';
import type { TaskService } from '../../agents/taskManager/services/TaskService';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';
import { TaskBoardEditModal, type TaskBoardEditableTask, type TaskBoardParentTaskOption, type TaskBoardProjectOption } from './TaskBoardEditModal';
import { TASK_BOARD_VIEW_TYPE, type TaskBoardViewState } from './taskBoardNavigation';
import { TaskBoardEvents, type TaskBoardDataChangedEvent } from '../../services/task/TaskBoardEvents';

interface TaskManagerAgentLike {
  getTaskService?: () => TaskService;
}

interface TaskBoardTask extends TaskMetadata {
  projectName: string;
  workspaceName: string;
}

const STATUS_COLUMNS: Array<{ id: TaskStatus; label: string }> = [
  { id: 'todo', label: 'Todo' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' }
];

type TaskSortField = 'created' | 'updated' | 'priority' | 'title' | 'dueDate';
type TaskSortOrder = 'asc' | 'desc';

const SORT_OPTIONS: Array<{ field: TaskSortField; label: string }> = [
  { field: 'created', label: 'Date created' },
  { field: 'updated', label: 'Last updated' },
  { field: 'priority', label: 'Priority' },
  { field: 'title', label: 'Title' },
  { field: 'dueDate', label: 'Due date' }
];

const PRIORITY_ORDER: Record<string, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4
};

export class TaskBoardView extends ItemView {
  private workspaceService: WorkspaceService | null = null;
  private taskService: TaskService | null = null;
  private agentRegistrationService: AgentRegistrationService | null = null;
  private workspaces: WorkspaceMetadata[] = [];
  private projects: ProjectMetadata[] = [];
  private tasks: TaskBoardTask[] = [];
  private filterState: TaskBoardViewState = {
    workspaceId: '',
    projectId: '',
    search: '',
    sortField: 'created',
    sortOrder: 'asc'
  };
  private dragTaskId: string | null = null;
  private isClosing = false;
  private isReady = false;
  private isSyncingBoardData = false;
  private isEditModalOpen = false;
  private hasPendingEventSync = false;
  private columnsContainer: HTMLElement | null = null;
  private statsContainer: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: NexusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TASK_BOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Task Board';
  }

  getIcon(): string {
    return 'layout-grid';
  }

  getState(): TaskBoardViewState {
    return { ...this.filterState };
  }

  async setState(state: TaskBoardViewState, _result: ViewStateResult): Promise<void> {
    this.filterState = {
      workspaceId: state?.workspaceId || '',
      projectId: state?.projectId || '',
      search: state?.search || '',
      sortField: state?.sortField || 'created',
      sortOrder: state?.sortOrder || 'asc'
    };

    if (this.isReady) {
      this.ensureValidFilters();
      this.renderBoard();
    }
  }

  async onOpen(): Promise<void> {
    this.isClosing = false;
    this.renderLoading('Loading task board...');
    void this.initializeView();
  }

  async onClose(): Promise<void> {
    this.isClosing = true;
  }

  private get contentContainer(): HTMLElement {
    return this.containerEl.children[1] as HTMLElement;
  }

  private renderLoading(message: string): void {
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-task-board-view');
    const loading = container.createDiv('nexus-task-board-loading');
    loading.createDiv({ cls: 'nexus-task-board-loading-text', text: message });
  }

  private async initializeView(): Promise<void> {
    try {
      await this.ensureServices();
      await this.loadBoardData();
      if (this.isClosing) {
        return;
      }
      this.isReady = true;
      this.renderBoard();
    } catch (error) {
      if (this.isClosing) {
        return;
      }

      console.error('[TaskBoardView] Failed to initialize:', error);
      this.renderError(error instanceof Error ? error.message : 'Failed to load task board');
    }
  }

  private async ensureServices(): Promise<void> {
    if (!this.workspaceService) {
      this.workspaceService = await this.plugin.getService<WorkspaceService>('workspaceService');
    }
    if (!this.agentRegistrationService) {
      this.agentRegistrationService = await this.plugin.getService<AgentRegistrationService>('agentRegistrationService');
    }

    if (!this.workspaceService || !this.agentRegistrationService) {
      throw new Error('Task board services are not available yet');
    }

    await this.agentRegistrationService.initializeAllAgents();

    const agentManager = await this.plugin.getService<AgentManager>('agentManager');
    if (!agentManager) {
      throw new Error('Agent manager is not available');
    }

    const taskAgent = agentManager.getAgent('taskManager') as TaskManagerAgentLike;
    if (!taskAgent.getTaskService) {
      throw new Error('Task manager is not available');
    }

    this.taskService = taskAgent.getTaskService();
    this.registerEvent(TaskBoardEvents.onDataChanged((event) => {
      void this.handleTaskBoardEvent(event);
    }));
  }

  private async loadBoardData(): Promise<void> {
    if (!this.workspaceService || !this.taskService) {
      throw new Error('Task board services are not initialized');
    }

    const workspaces = await this.workspaceService.getWorkspaces({
      sortBy: 'lastAccessed',
      sortOrder: 'desc'
    });
    this.workspaces = workspaces.filter(workspace => !workspace.isArchived);

    if (!this.filterState.workspaceId) {
      const activeWorkspace = await this.workspaceService.getActiveWorkspace();
      this.filterState.workspaceId = activeWorkspace?.id || 'all';
    }

    const workspaceData = await Promise.all(
      this.workspaces.map(async workspace => {
        const [projectsResult, tasksResult] = await Promise.all([
          this.taskService!.listProjects(workspace.id, { pageSize: 1000 }),
          this.taskService!.listWorkspaceTasks(workspace.id, { pageSize: 10000 })
        ]);

        return {
          workspace,
          projects: projectsResult.items.filter(project => project.status !== 'archived'),
          tasks: tasksResult.items
        };
      })
    );

    this.projects = workspaceData.flatMap(entry => entry.projects);
    const projectMap = new Map(this.projects.map(project => [project.id, project]));

    this.tasks = workspaceData.flatMap(entry =>
      entry.tasks
        .filter(task => projectMap.has(task.projectId))
        .map(task => ({
          ...task,
          projectName: projectMap.get(task.projectId)?.name || 'Unknown project',
          workspaceName: entry.workspace.name
        }))
    );

    this.ensureValidFilters();
  }

  private ensureValidFilters(): void {
    const workspaceIds = new Set(this.workspaces.map(workspace => workspace.id));
    if (this.filterState.workspaceId && this.filterState.workspaceId !== 'all' && !workspaceIds.has(this.filterState.workspaceId)) {
      this.filterState.workspaceId = 'all';
    }

    const availableProjectIds = new Set(this.getFilteredProjectsForToolbar().map(project => project.id));
    if (this.filterState.projectId && this.filterState.projectId !== 'all' && !availableProjectIds.has(this.filterState.projectId)) {
      this.filterState.projectId = 'all';
    }
  }

  private renderError(message: string): void {
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-task-board-view');

    const errorEl = container.createDiv('nexus-task-board-error');
    errorEl.createEl('h3', { text: 'Task board unavailable' });
    errorEl.createEl('p', { text: message });

    const retryButton = errorEl.createEl('button', {
      cls: 'mod-cta nexus-task-board-button',
      text: 'Retry',
      attr: { type: 'button' }
    });
    this.registerDomEvent(retryButton, 'click', () => {
      this.renderLoading('Loading task board...');
      void this.initializeView();
    });
  }

  private renderBoard(): void {
    const container = this.contentContainer;
    container.empty();
    container.addClass('nexus-task-board-view');

    const shell = container.createDiv('nexus-task-board-shell');
    this.renderHeader(shell);
    this.renderToolbar(shell);
    this.columnsContainer = shell.createDiv();
    this.renderColumns();
  }

  /**
   * Re-render only the columns and stats, preserving the toolbar (search input keeps focus).
   */
  private refreshColumns(): void {
    if (this.columnsContainer) {
      this.renderColumns();
    }
    if (this.statsContainer) {
      this.statsContainer.empty();
      const filteredTasks = this.getFilteredAndSortedTasks();
      const projectCount = new Set(filteredTasks.map(task => task.projectId)).size;
      this.statsContainer.createDiv({
        cls: 'nexus-task-board-stat',
        text: `${filteredTasks.length} tasks`
      });
      this.statsContainer.createDiv({
        cls: 'nexus-task-board-stat',
        text: `${projectCount} projects`
      });
    }
  }

  private renderHeader(container: HTMLElement): void {
    const header = container.createDiv('nexus-task-board-header');
    const text = header.createDiv();
    text.createDiv({ cls: 'nexus-task-board-kicker', text: 'Workspace view' });
    text.createEl('h2', { text: 'Task Board' });
    text.createEl('p', {
      cls: 'nexus-task-board-subtitle',
      text: 'Drag cards to change status. Use the edit icon for task details.'
    });
  }

  private renderToolbar(container: HTMLElement): void {
    const toolbar = container.createDiv('nexus-task-board-toolbar');

    const workspaceField = toolbar.createDiv('nexus-task-board-field');
    workspaceField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Workspace' });
    const workspaceSelect = workspaceField.createEl('select', { cls: 'nexus-task-board-input' });
    workspaceSelect.createEl('option', { value: 'all', text: 'All workspaces' });
    this.workspaces.forEach(workspace => {
      workspaceSelect.createEl('option', {
        value: workspace.id,
        text: workspace.name
      });
    });
    workspaceSelect.value = this.filterState.workspaceId || 'all';
    this.registerDomEvent(workspaceSelect, 'change', () => {
      this.filterState.workspaceId = workspaceSelect.value;
      this.ensureValidFilters();
      this.refreshColumns();
    });

    const projectField = toolbar.createDiv('nexus-task-board-field');
    projectField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Project' });
    const projectSelect = projectField.createEl('select', { cls: 'nexus-task-board-input' });
    projectSelect.createEl('option', { value: 'all', text: 'All projects' });
    this.getFilteredProjectsForToolbar().forEach(project => {
      projectSelect.createEl('option', {
        value: project.id,
        text: project.name
      });
    });
    projectSelect.value = this.filterState.projectId || 'all';
    this.registerDomEvent(projectSelect, 'change', () => {
      this.filterState.projectId = projectSelect.value;
      this.refreshColumns();
    });

    const searchField = toolbar.createDiv('nexus-task-board-field nexus-task-board-field-search');
    searchField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Search' });
    const searchInput = searchField.createEl('input', {
      cls: 'nexus-task-board-input',
      attr: {
        type: 'search',
        placeholder: 'Search tasks'
      }
    });
    searchInput.value = this.filterState.search || '';
    this.registerDomEvent(searchInput, 'input', () => {
      this.filterState.search = searchInput.value;
      this.refreshColumns();
    });

    const sortField = toolbar.createDiv('nexus-task-board-field');
    sortField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Sort by' });
    const sortSelect = sortField.createEl('select', { cls: 'nexus-task-board-input' });
    SORT_OPTIONS.forEach(option => {
      sortSelect.createEl('option', {
        value: option.field,
        text: option.label
      });
    });
    sortSelect.value = this.filterState.sortField || 'created';
    this.registerDomEvent(sortSelect, 'change', () => {
      this.filterState.sortField = sortSelect.value;
      this.refreshColumns();
    });

    const orderField = toolbar.createDiv('nexus-task-board-field');
    orderField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Order' });
    const orderSelect = orderField.createEl('select', { cls: 'nexus-task-board-input' });
    orderSelect.createEl('option', { value: 'asc', text: 'Ascending' });
    orderSelect.createEl('option', { value: 'desc', text: 'Descending' });
    orderSelect.value = this.filterState.sortOrder || 'asc';
    this.registerDomEvent(orderSelect, 'change', () => {
      this.filterState.sortOrder = orderSelect.value;
      this.refreshColumns();
    });

    this.statsContainer = toolbar.createDiv('nexus-task-board-stats');
    const filteredTasks = this.getFilteredAndSortedTasks();
    const projectCount = new Set(filteredTasks.map(task => task.projectId)).size;
    this.statsContainer.createDiv({
      cls: 'nexus-task-board-stat',
      text: `${filteredTasks.length} tasks`
    });
    this.statsContainer.createDiv({
      cls: 'nexus-task-board-stat',
      text: `${projectCount} projects`
    });
  }

  private renderColumns(): void {
    if (!this.columnsContainer) return;
    this.columnsContainer.empty();
    const columns = this.columnsContainer.createDiv('nexus-task-board-columns');
    const filteredTasks = this.getFilteredAndSortedTasks();

    STATUS_COLUMNS.forEach(column => {
      const columnEl = columns.createDiv('nexus-task-board-column');
      const header = columnEl.createDiv('nexus-task-board-column-header');
      header.createEl('h3', { text: column.label });
      header.createEl('span', {
        cls: 'nexus-task-board-column-count',
        text: String(filteredTasks.filter(task => task.status === column.id).length)
      });

      const body = columnEl.createDiv('nexus-task-board-column-body');
      body.dataset.status = column.id;
      this.registerDomEvent(body, 'dragover', (event) => {
        event.preventDefault();
        body.addClass('is-drop-target');
      });
      this.registerDomEvent(body, 'dragleave', () => body.removeClass('is-drop-target'));
      this.registerDomEvent(body, 'drop', (event) => {
        event.preventDefault();
        body.removeClass('is-drop-target');
        const taskId = this.dragTaskId;
        this.dragTaskId = null;
        if (!taskId) {
          return;
        }
        void this.handleTaskStatusDrop(taskId, column.id);
      });

      const tasks = filteredTasks.filter(task => task.status === column.id);
      if (tasks.length === 0) {
        body.createDiv({
          cls: 'nexus-task-board-empty-column',
          text: 'No tasks'
        });
      }

      tasks.forEach(task => {
        const card = body.createDiv('nexus-task-board-card');
        card.draggable = true;
        this.registerDomEvent(card, 'dragstart', (event) => {
          this.dragTaskId = task.id;
          card.addClass('is-dragging');
          event.dataTransfer?.setData('text/plain', task.id);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
          }
        });
        this.registerDomEvent(card, 'dragend', () => {
          card.removeClass('is-dragging');
          this.dragTaskId = null;
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
        this.registerDomEvent(editButton, 'click', (event) => {
          event.stopPropagation();
          this.openEditModal(task);
        });

        card.createDiv({
          cls: 'nexus-task-board-card-meta',
          text: `${task.workspaceName} · ${task.projectName}`
        });
      });
    });
  }

  private getFilteredProjectsForToolbar(): ProjectMetadata[] {
    if (!this.filterState.workspaceId || this.filterState.workspaceId === 'all') {
      return this.projects;
    }
    return this.projects.filter(project => project.workspaceId === this.filterState.workspaceId);
  }

  private getFilteredAndSortedTasks(): TaskBoardTask[] {
    const searchQuery = (this.filterState.search || '').trim().toLowerCase();

    const filtered = this.tasks.filter(task => {
      const matchesWorkspace = !this.filterState.workspaceId || this.filterState.workspaceId === 'all'
        || task.workspaceId === this.filterState.workspaceId;
      const matchesProject = !this.filterState.projectId || this.filterState.projectId === 'all'
        || task.projectId === this.filterState.projectId;

      if (!matchesWorkspace || !matchesProject) {
        return false;
      }

      if (!searchQuery) {
        return true;
      }

      const haystack = [
        task.title,
        task.description,
        task.projectName,
        task.workspaceName,
        task.assignee,
        task.tags?.join(', ')
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      return haystack.includes(searchQuery);
    });

    const sortField = (this.filterState.sortField || 'created') as TaskSortField;
    const sortOrder = (this.filterState.sortOrder || 'asc') as TaskSortOrder;
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'created':
          comparison = a.created - b.created;
          break;
        case 'updated':
          comparison = a.updated - b.updated;
          break;
        case 'priority':
          comparison = (PRIORITY_ORDER[a.priority] ?? 5) - (PRIORITY_ORDER[b.priority] ?? 5);
          break;
        case 'title':
          comparison = a.title.localeCompare(b.title);
          break;
        case 'dueDate': {
          const aDue = a.dueDate ?? Number.MAX_SAFE_INTEGER;
          const bDue = b.dueDate ?? Number.MAX_SAFE_INTEGER;
          comparison = aDue - bDue;
          break;
        }
      }
      return comparison * multiplier;
    });

    return filtered;
  }

  private openEditModal(task: TaskBoardTask): void {
    this.isEditModalOpen = true;
    const taskData: TaskBoardEditableTask = {
      id: task.id,
      workspaceId: task.workspaceId,
      projectId: task.projectId,
      title: task.title,
      description: task.description || '',
      status: task.status,
      priority: task.priority,
      dueDate: this.toDateInputValue(task.dueDate),
      assignee: task.assignee || '',
      tags: task.tags?.join(', ') || '',
      parentTaskId: task.parentTaskId || ''
    };

    const projects = this.projects
      .filter(project => project.workspaceId === task.workspaceId)
      .map<TaskBoardProjectOption>(project => ({
        id: project.id,
        name: project.name
      }));

    const parentTasks = this.tasks
      .filter(candidate => candidate.workspaceId === task.workspaceId && candidate.id !== task.id)
      .map<TaskBoardParentTaskOption>(candidate => ({
        id: candidate.id,
        title: candidate.title,
        projectId: candidate.projectId
      }));

    new TaskBoardEditModal(this.app, {
      task: taskData,
      projects,
      parentTasks,
      onSave: async (updatedTask) => {
        await this.saveTaskChanges(task, updatedTask);
      },
      onClose: () => {
        this.isEditModalOpen = false;
        if (this.hasPendingEventSync) {
          this.hasPendingEventSync = false;
          void this.syncFromEvent();
        }
      }
    }).open();
  }

  private async saveTaskChanges(originalTask: TaskBoardTask, updatedTask: TaskBoardEditableTask): Promise<void> {
    if (!this.taskService) {
      throw new Error('Task service is not available');
    }

    const normalizedTags = updatedTask.tags
      .split(',')
      .map(tag => tag.trim())
      .filter(Boolean);

    await this.taskService.updateTask(originalTask.id, {
      title: updatedTask.title.trim(),
      description: updatedTask.description.trim() || undefined,
      status: updatedTask.status,
      priority: updatedTask.priority,
      dueDate: this.fromDateInputValue(updatedTask.dueDate),
      assignee: updatedTask.assignee.trim() || undefined,
      tags: normalizedTags.length > 0 ? normalizedTags : undefined
    });

    const projectChanged = updatedTask.projectId !== originalTask.projectId;
    const parentChanged = (updatedTask.parentTaskId || '') !== (originalTask.parentTaskId || '');
    if (projectChanged || parentChanged) {
      await this.taskService.moveTask(originalTask.id, {
        projectId: projectChanged ? updatedTask.projectId : undefined,
        parentTaskId: parentChanged ? (updatedTask.parentTaskId || null) : undefined
      });
    }

    await this.loadBoardData();
    this.renderBoard();
    new Notice('Task saved');
  }

  private async handleTaskStatusDrop(taskId: string, newStatus: TaskStatus): Promise<void> {
    if (!this.taskService) {
      new Notice('Task service is not available');
      return;
    }

    const task = this.tasks.find(entry => entry.id === taskId);
    if (!task || task.status === newStatus) {
      return;
    }

    const previousStatus = task.status;
    task.status = newStatus;
    this.refreshColumns();

    try {
      await this.taskService.updateTask(taskId, { status: newStatus });
    } catch (error) {
      task.status = previousStatus;
      this.refreshColumns();
      const message = error instanceof Error ? error.message : 'Failed to update task status';
      new Notice(message);
    }
  }

  private async handleTaskBoardEvent(event: TaskBoardDataChangedEvent): Promise<void> {
    if (this.isClosing || !this.isReady) {
      return;
    }

    const isRelevantWorkspace = !this.filterState.workspaceId
      || this.filterState.workspaceId === 'all'
      || this.filterState.workspaceId === event.workspaceId;

    if (!isRelevantWorkspace) {
      return;
    }

    if (this.isEditModalOpen || this.dragTaskId || this.isSyncingBoardData) {
      this.hasPendingEventSync = true;
      return;
    }

    await this.syncFromEvent();
  }

  private async syncFromEvent(): Promise<void> {
    if (this.isClosing || !this.isReady || this.isSyncingBoardData) {
      return;
    }

    this.isSyncingBoardData = true;
    try {
      await this.loadBoardData();
      if (!this.isClosing) {
        this.renderBoard();
      }
    } catch (error) {
      console.error('[TaskBoardView] Event sync failed:', error);
    } finally {
      this.isSyncingBoardData = false;
    }
  }

  private toDateInputValue(timestamp?: number): string {
    if (!timestamp) {
      return '';
    }
    return new Date(timestamp).toISOString().slice(0, 10);
  }

  private fromDateInputValue(value: string): number | undefined {
    if (!value) {
      return undefined;
    }
    const timestamp = new Date(`${value}T00:00:00`).getTime();
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
}
