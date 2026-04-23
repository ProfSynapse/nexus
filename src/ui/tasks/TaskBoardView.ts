import {
  ItemView,
  type WorkspaceLeaf,
  type ViewStateResult
} from 'obsidian';
import type NexusPlugin from '../../main';
import type { ExternalSyncEvent, HybridStorageAdapter } from '../../database/adapters/HybridStorageAdapter';
import type { ProjectMetadata } from '../../database/repositories/interfaces/IProjectRepository';
import type { TaskStatus } from '../../database/repositories/interfaces/ITaskRepository';
import type { WorkspaceMetadata } from '../../types/storage/StorageTypes';
import { TASK_BOARD_VIEW_TYPE, type TaskBoardViewState } from './taskBoardNavigation';
import { TaskBoardEvents, type TaskBoardDataChangedEvent } from '../../services/task/TaskBoardEvents';
import {
  SORT_OPTIONS,
  type SwimlaneGroup,
  type TaskBoardTask
} from './taskBoardTypes';
import { TaskBoardDataController } from './services/TaskBoardDataController';
import { TaskBoardEditCoordinator } from './services/TaskBoardEditCoordinator';
import { TaskBoardFilterController } from './services/TaskBoardFilterController';
import { TaskBoardGroupingService } from './services/TaskBoardGroupingService';
import { TaskBoardRenderer } from './services/TaskBoardRenderer';
import { TaskBoardSyncCoordinator } from './services/TaskBoardSyncCoordinator';

export class TaskBoardView extends ItemView {
  private dataController: TaskBoardDataController;
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
  private pendingEvent: TaskBoardDataChangedEvent | null = null;
  private columnsContainer: HTMLElement | null = null;
  private statsContainer: HTMLElement | null = null;
  private projectSelect: HTMLSelectElement | null = null;
  private collapsedSwimlanes = new Set<string>();
  private hasRegisteredTaskBoardEvents = false;
  private hasRegisteredExternalSync = false;
  private editCoordinator: TaskBoardEditCoordinator;
  private renderer: TaskBoardRenderer;
  private syncCoordinator: TaskBoardSyncCoordinator;

  constructor(leaf: WorkspaceLeaf, private plugin: NexusPlugin) {
    super(leaf);
    this.dataController = new TaskBoardDataController(plugin);
    this.editCoordinator = new TaskBoardEditCoordinator({
      app: this.app,
      getTaskService: () => this.dataController.getTaskService(),
      getProjects: () => this.projects,
      getTasks: () => this.tasks,
      getEmbeddingService: () => this.plugin.getServiceIfReady('embeddingService') ?? undefined,
      reloadBoard: () => this.loadBoardData(),
      renderBoard: () => this.renderBoard(),
      onEditModalStateChange: (isOpen) => {
        this.isEditModalOpen = isOpen;
      },
      onEditModalClose: () => {
        void this.syncCoordinator.flushPendingEvent();
      },
      toDateInputValue: (timestamp) => this.toDateInputValue(timestamp),
      fromDateInputValue: (value) => this.fromDateInputValue(value)
    });
    this.syncCoordinator = new TaskBoardSyncCoordinator({
      getTaskService: () => this.dataController.getTaskService(),
      getTasks: () => this.tasks,
      getFilterState: () => this.filterState,
      getIsClosing: () => this.isClosing,
      getIsReady: () => this.isReady,
      getIsSyncingBoardData: () => this.isSyncingBoardData,
      setIsSyncingBoardData: (isSyncing) => {
        this.isSyncingBoardData = isSyncing;
      },
      getIsEditModalOpen: () => this.isEditModalOpen,
      getDragTaskId: () => this.dragTaskId,
      getPendingEvent: () => this.pendingEvent,
      setPendingEvent: (event) => {
        this.pendingEvent = event;
      },
      loadBoardData: () => this.loadBoardData(),
      refreshColumns: () => this.refreshColumns(),
      renderBoard: () => this.renderBoard()
    });
    this.renderer = new TaskBoardRenderer({
      app: this.app,
      component: this,
      getDragTaskId: () => this.dragTaskId,
      setDragTaskId: (taskId) => {
        this.dragTaskId = taskId;
      },
      getCollapsedSwimlanes: () => this.collapsedSwimlanes,
      groupTasksByParent: (columnTasks) => this.groupTasksByParent(columnTasks),
      onTaskStatusDrop: (taskId, newStatus) => this.handleTaskStatusDrop(taskId, newStatus),
      onEditTask: (task) => this.openEditModal(task),
      onFlushPendingEvent: () => this.syncCoordinator.flushPendingEvent()
    });
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
    this.filterState = TaskBoardFilterController.normalizeState(state);

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
    this.workspaces = [];
    this.projects = [];
    this.tasks = [];
    this.columnsContainer = null;
    this.statsContainer = null;
    this.projectSelect = null;
    this.hasRegisteredTaskBoardEvents = false;
    this.hasRegisteredExternalSync = false;
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
    await this.dataController.ensureServices();

    if (!this.hasRegisteredTaskBoardEvents) {
      this.registerEvent(TaskBoardEvents.onDataChanged((event) => {
        void this.handleTaskBoardEvent(event);
      }));
      this.hasRegisteredTaskBoardEvents = true;
    }

    if (!this.hasRegisteredExternalSync) {
      const adapter = this.plugin.getServiceIfReady<HybridStorageAdapter>('hybridStorageAdapter');
      if (adapter?.onExternalSync) {
        this.registerEvent(adapter.onExternalSync((event) => {
          void this.handleExternalSync(event);
        }));
        this.hasRegisteredExternalSync = true;
      }
    }
  }

  private async loadBoardData(): Promise<void> {
    const snapshot = await this.dataController.loadBoardData(this.filterState);
    this.workspaces = snapshot.workspaces;
    this.projects = snapshot.projects;
    this.tasks = snapshot.tasks;
    this.filterState = snapshot.filterState;
  }

  private ensureValidFilters(): void {
    this.filterState = TaskBoardFilterController.ensureValidFilters(
      this.filterState,
      this.workspaces,
      this.projects
    );
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
      const stats = TaskBoardFilterController.getStats(filteredTasks);
      this.statsContainer.createDiv({
        cls: 'nexus-task-board-stat',
        text: `${stats.taskCount} tasks`
      });
      this.statsContainer.createDiv({
        cls: 'nexus-task-board-stat',
        text: `${stats.projectCount} projects`
      });
    }
  }

  private refreshProjectDropdown(): void {
    if (!this.projectSelect) return;

    const currentValue = this.filterState.projectId || 'all';

    this.projectSelect.empty();
    this.projectSelect.createEl('option', { value: 'all', text: 'All projects' });
    this.getFilteredProjectsForToolbar().forEach(project => {
      this.projectSelect!.createEl('option', {
        value: project.id,
        text: project.name
      });
    });

    const optionValues = new Set(
      Array.from(this.projectSelect.options).map(o => o.value)
    );
    this.projectSelect.value = optionValues.has(currentValue) ? currentValue : 'all';
    this.filterState.projectId = this.projectSelect.value;
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
      this.refreshProjectDropdown();
      this.refreshColumns();
    });

    const projectField = toolbar.createDiv('nexus-task-board-field');
    projectField.createEl('label', { cls: 'nexus-task-board-field-label', text: 'Project' });
    this.projectSelect = projectField.createEl('select', { cls: 'nexus-task-board-input' });
    const projectSelect = this.projectSelect;
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
    const stats = TaskBoardFilterController.getStats(filteredTasks);
    this.statsContainer.createDiv({
      cls: 'nexus-task-board-stat',
      text: `${stats.taskCount} tasks`
    });
    this.statsContainer.createDiv({
      cls: 'nexus-task-board-stat',
      text: `${stats.projectCount} projects`
    });
  }

  private renderColumns(): void {
    if (!this.columnsContainer) return;
    const filteredTasks = this.getFilteredAndSortedTasks();
    this.renderer.renderColumns(this.columnsContainer, filteredTasks);
  }

  private getFilteredProjectsForToolbar(): ProjectMetadata[] {
    return TaskBoardFilterController.getFilteredProjectsForToolbar(this.projects, this.filterState);
  }

  private getFilteredAndSortedTasks(): TaskBoardTask[] {
    return TaskBoardFilterController.getFilteredAndSortedTasks(this.tasks, this.filterState);
  }

  private groupTasksByParent(columnTasks: TaskBoardTask[]): SwimlaneGroup[] {
    return TaskBoardGroupingService.groupTasksByParent(this.tasks, columnTasks, this.filterState);
  }

  private openEditModal(task: TaskBoardTask): void {
    this.editCoordinator.openEditModal(task);
  }

  private async handleTaskStatusDrop(taskId: string, newStatus: TaskStatus): Promise<void> {
    await this.syncCoordinator.handleTaskStatusDrop(taskId, newStatus);
  }

  private async handleTaskBoardEvent(event: TaskBoardDataChangedEvent): Promise<void> {
    await this.syncCoordinator.handleTaskBoardEvent(event);
  }

  private async handleExternalSync(event: ExternalSyncEvent): Promise<void> {
    const hasWorkspaceChanges = event.modified.some((entry) => entry.category === 'workspaces');
    const taskWorkspaceIds = Array.from(new Set(
      event.modified
        .filter((entry) => entry.category === 'tasks')
        .map((entry) => entry.businessId)
    ));

    if (!hasWorkspaceChanges && taskWorkspaceIds.length === 0) {
      return;
    }

    await this.syncCoordinator.handleExternalSync(taskWorkspaceIds, hasWorkspaceChanges);
  }

  private async syncFromEvent(event?: TaskBoardDataChangedEvent): Promise<void> {
    await this.syncCoordinator.syncFromEvent(event);
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
