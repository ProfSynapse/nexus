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
import type { EmbeddingService } from '../../services/embeddings/EmbeddingService';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskMetadata, TaskStatus, NoteLink, LinkType } from '../../database/repositories/interfaces/ITaskRepository';
import { TaskBoardEditModal, type TaskBoardEditableTask, type TaskBoardParentTaskOption, type TaskBoardProjectOption } from './TaskBoardEditModal';
import { TASK_BOARD_VIEW_TYPE, type TaskBoardViewState } from './taskBoardNavigation';
import { TaskBoardEvents, type TaskBoardDataChangedEvent } from '../../services/task/TaskBoardEvents';

interface TaskManagerAgentLike {
  getTaskService?: () => TaskService;
}

interface TaskBoardTask extends TaskMetadata {
  projectName: string;
  workspaceName: string;
  noteLinks: NoteLink[];
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

interface SwimlaneGroup {
  parentId: string | null;
  parentTask: TaskBoardTask | null;
  children: TaskBoardTask[];
  progress: { done: number; total: number };
}

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
  private collapsedSwimlanes = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private plugin: NexusPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return TASK_BOARD_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Task board';
  }

  getIcon(): string {
    return 'layout-grid';
  }

  getState(): TaskBoardViewState {
    return { ...this.filterState };
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Obsidian ItemView lifecycle method
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

  // eslint-disable-next-line @typescript-eslint/require-await -- Obsidian ItemView lifecycle method
  async onOpen(): Promise<void> {
    this.isClosing = false;
    this.renderLoading('Loading task board...');
    void this.initializeView();
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- Obsidian ItemView lifecycle method
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
    loading.createDiv('nexus-task-board-spinner');
    loading.createDiv({ cls: 'nexus-task-board-loading-text', text: message });
  }

  private async initializeView(): Promise<void> {
    const maxAttempts = 40;
    const delayMs = 750;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.isClosing) {
        return;
      }

      try {
        await this.ensureServices();
        await this.loadBoardData();
        if (this.isClosing) {
          return;
        }
        this.isReady = true;
        this.renderBoard();
        return;
      } catch {
        if (this.isClosing) {
          return;
        }

        if (attempt < maxAttempts) {
          this.renderLoading('Waiting for services to start...');
          await new Promise(resolve => setTimeout(resolve, delayMs));
        } else {
          this.renderError('Task board services did not become available. Please try again later.');
        }
      }
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
    const workspaceService = this.workspaceService;
    const taskService = this.taskService;
    if (!workspaceService || !taskService) {
      throw new Error('Task board services are not initialized');
    }

    const workspaces = await workspaceService.getWorkspaces({
      sortBy: 'lastAccessed',
      sortOrder: 'desc'
    });
    this.workspaces = workspaces.filter(workspace => !workspace.isArchived);

    if (!this.filterState.workspaceId) {
      const activeWorkspace = await workspaceService.getActiveWorkspace();
      this.filterState.workspaceId = activeWorkspace?.id || 'all';
    }

    const workspaceData = await Promise.all(
      this.workspaces.map(async workspace => {
        const [projectsResult, tasksResult] = await Promise.all([
          taskService.listProjects(workspace.id, { pageSize: 1000 }),
          taskService.listWorkspaceTasks(workspace.id, { pageSize: 10000 })
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

    const allTasks = workspaceData.flatMap(entry =>
      entry.tasks
        .filter(task => projectMap.has(task.projectId))
        .map(task => ({
          ...task,
          projectName: projectMap.get(task.projectId)?.name || 'Unknown project',
          workspaceName: entry.workspace.name,
          noteLinks: [] as NoteLink[]
        }))
    );

    // Load note links for all tasks
    const noteLinksResults = await Promise.all(
      allTasks.map(task =>
        taskService.getNoteLinks(task.id).catch(() => [] as NoteLink[])
      )
    );
    allTasks.forEach((task, index) => {
      task.noteLinks = noteLinksResults[index];
    });

    this.tasks = allTasks;

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
    this.columnsContainer = shell.createDiv('nexus-task-board-columns-wrapper');
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
    text.createEl('h2', { text: 'Task board' });
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

      const columnTasks = filteredTasks.filter(task => task.status === column.id);

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

      const groups = this.groupTasksByParent(columnTasks);
      const cardCount = groups.reduce((sum, g) => sum + g.children.length, 0);

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

  private renderSwimlane(container: HTMLElement, group: SwimlaneGroup, columnStatus: string): void {
    const swimlane = container.createDiv('nexus-task-board-swimlane');

    const collapseKey = `${columnStatus}::${group.parentId || '__ungrouped'}`;
    const isCollapsed = this.collapsedSwimlanes.has(collapseKey);
    if (isCollapsed) {
      swimlane.addClass('is-collapsed');
    }

    const headerEl = swimlane.createDiv('nexus-task-board-swimlane-header');

    if (group.parentTask) {
      // Parent swimlane with collapse toggle and progress
      const toggleBtn = headerEl.createEl('button', {
        cls: 'clickable-icon nexus-task-board-swimlane-toggle',
        attr: {
          'aria-label': `Toggle ${group.parentTask.title}`,
          'aria-expanded': String(!isCollapsed),
          type: 'button'
        }
      });
      setIcon(toggleBtn, isCollapsed ? 'chevron-right' : 'chevron-down');

      this.registerDomEvent(toggleBtn, 'click', () => {
        if (this.collapsedSwimlanes.has(collapseKey)) {
          this.collapsedSwimlanes.delete(collapseKey);
          swimlane.removeClass('is-collapsed');
          toggleBtn.setAttribute('aria-expanded', 'true');
          setIcon(toggleBtn, 'chevron-down');
        } else {
          this.collapsedSwimlanes.add(collapseKey);
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
      // Ungrouped section
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

    if (task.noteLinks.length > 0) {
      const linksRow = card.createDiv('nexus-task-board-card-links');
      task.noteLinks.forEach(link => {
        const fileName = link.notePath.split('/').pop()?.replace(/\.md$/, '') || link.notePath;
        const linkEl = linksRow.createEl('a', {
          cls: 'nexus-task-board-card-link',
          text: fileName,
          attr: { 'aria-label': link.notePath }
        });
        this.registerDomEvent(linkEl, 'click', (event) => {
          event.stopPropagation();
          const file = this.app.vault.getFileByPath(link.notePath);
          if (file) {
            void this.app.workspace.getLeaf(false).openFile(file);
          } else {
            new Notice(`File not found: ${link.notePath}`);
          }
        });
      });
    }
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

  private groupTasksByParent(columnTasks: TaskBoardTask[]): SwimlaneGroup[] {
    const allTaskMap = new Map(this.tasks.map(t => [t.id, t]));

    // Identify which task IDs are parents (have at least one child in the filtered set)
    const parentIdsWithChildren = new Set<string>();
    for (const task of this.getFilteredAndSortedTasks()) {
      if (task.parentTaskId && task.parentTaskId !== task.id && allTaskMap.has(task.parentTaskId)) {
        parentIdsWithChildren.add(task.parentTaskId);
      }
    }

    const grouped = new Map<string, TaskBoardTask[]>();
    const ungrouped: TaskBoardTask[] = [];

    for (const task of columnTasks) {
      // If this task IS a parent (it's a swimlane header, not a card)
      if (parentIdsWithChildren.has(task.id)) {
        continue;
      }

      const parentId = task.parentTaskId;
      if (parentId && parentId !== task.id && allTaskMap.has(parentId) && parentIdsWithChildren.has(parentId)) {
        const group = grouped.get(parentId);
        if (group) {
          group.push(task);
        } else {
          grouped.set(parentId, [task]);
        }
      } else {
        ungrouped.push(task);
      }
    }

    const groups: SwimlaneGroup[] = [];
    for (const [parentId, children] of grouped) {
      groups.push({
        parentId,
        parentTask: allTaskMap.get(parentId) || null,
        children,
        progress: this.getParentProgress(parentId, parentIdsWithChildren)
      });
    }

    // Sort groups using same sort logic as tasks, applied to the parent task
    const sortField = (this.filterState.sortField || 'created') as TaskSortField;
    const sortOrder = (this.filterState.sortOrder || 'asc') as TaskSortOrder;
    const multiplier = sortOrder === 'asc' ? 1 : -1;

    groups.sort((a, b) => {
      if (!a.parentTask || !b.parentTask) return 0;
      let comparison = 0;
      switch (sortField) {
        case 'created': comparison = a.parentTask.created - b.parentTask.created; break;
        case 'updated': comparison = a.parentTask.updated - b.parentTask.updated; break;
        case 'priority': comparison = (PRIORITY_ORDER[a.parentTask.priority] ?? 5) - (PRIORITY_ORDER[b.parentTask.priority] ?? 5); break;
        case 'title': comparison = a.parentTask.title.localeCompare(b.parentTask.title); break;
        case 'dueDate': {
          const aDue = a.parentTask.dueDate ?? Number.MAX_SAFE_INTEGER;
          const bDue = b.parentTask.dueDate ?? Number.MAX_SAFE_INTEGER;
          comparison = aDue - bDue;
          break;
        }
      }
      return comparison * multiplier;
    });

    if (ungrouped.length > 0) {
      groups.push({
        parentId: null,
        parentTask: null,
        children: ungrouped,
        progress: { done: 0, total: 0 }
      });
    }

    return groups;
  }

  private getParentProgress(parentTaskId: string, parentIds: Set<string>): { done: number; total: number } {
    // Count across ALL tasks (not just current column), but respect workspace/project filter
    const children = this.tasks.filter(task => {
      if (task.parentTaskId !== parentTaskId) return false;
      if (parentIds.has(task.id)) return false; // skip tasks that are themselves parents (they're headers)

      const matchesWorkspace = !this.filterState.workspaceId || this.filterState.workspaceId === 'all'
        || task.workspaceId === this.filterState.workspaceId;
      const matchesProject = !this.filterState.projectId || this.filterState.projectId === 'all'
        || task.projectId === this.filterState.projectId;
      return matchesWorkspace && matchesProject;
    });

    return {
      done: children.filter(t => t.status === 'done').length,
      total: children.length
    };
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
      parentTaskId: task.parentTaskId || '',
      noteLinks: [...task.noteLinks]
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

    const embeddingService = this.plugin.getServiceIfReady<EmbeddingService>('embeddingService') ?? undefined;

    new TaskBoardEditModal(this.app, {
      task: taskData,
      projects,
      parentTasks,
      embeddingService,
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

    // Sync note links: compare original vs updated
    const originalPaths = new Set(originalTask.noteLinks.map(link => link.notePath));
    const updatedLinks = updatedTask.noteLinks.filter(link => link.notePath.trim());
    const updatedPaths = new Map<string, LinkType>(updatedLinks.map(link => [link.notePath.trim(), link.linkType || 'reference']));

    // Remove links that were deleted
    for (const path of originalPaths) {
      if (!updatedPaths.has(path)) {
        await this.taskService.unlinkNote(originalTask.id, path);
      }
    }

    // Add new links (or re-link with potentially different type)
    for (const [path, linkType] of updatedPaths) {
      if (!originalPaths.has(path)) {
        await this.taskService.linkNote(originalTask.id, path, linkType);
      }
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
