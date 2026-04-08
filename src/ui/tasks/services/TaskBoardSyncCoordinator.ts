import { Notice } from 'obsidian';
import type { TaskService } from '../../../agents/taskManager/services/TaskService';
import type { TaskBoardDataChangedEvent } from '../../../services/task/TaskBoardEvents';
import type { TaskBoardViewState } from '../taskBoardNavigation';
import type { TaskBoardTask } from '../taskBoardTypes';
import type { TaskStatus } from '../../../database/repositories/interfaces/ITaskRepository';

interface TaskBoardSyncCoordinatorDependencies {
  getTaskService: () => TaskService | null;
  getTasks: () => TaskBoardTask[];
  getFilterState: () => TaskBoardViewState;
  getIsClosing: () => boolean;
  getIsReady: () => boolean;
  getIsSyncingBoardData: () => boolean;
  setIsSyncingBoardData: (isSyncing: boolean) => void;
  getIsEditModalOpen: () => boolean;
  getDragTaskId: () => string | null;
  getPendingEvent: () => TaskBoardDataChangedEvent | null;
  setPendingEvent: (event: TaskBoardDataChangedEvent | null) => void;
  loadBoardData: () => Promise<void>;
  refreshColumns: () => void;
  renderBoard: () => void;
}

export class TaskBoardSyncCoordinator {
  constructor(private readonly deps: TaskBoardSyncCoordinatorDependencies) {}

  async handleTaskStatusDrop(taskId: string, newStatus: TaskStatus): Promise<void> {
    const taskService = this.deps.getTaskService();
    if (!taskService) {
      new Notice('Task service is not available');
      return;
    }

    const task = this.deps.getTasks().find(entry => entry.id === taskId);
    if (!task || task.status === newStatus) {
      return;
    }

    const previousStatus = task.status;
    task.status = newStatus;
    this.deps.refreshColumns();

    try {
      await taskService.updateTask(taskId, { status: newStatus });
    } catch (error) {
      task.status = previousStatus;
      this.deps.refreshColumns();
      const message = error instanceof Error ? error.message : 'Failed to update task status';
      new Notice(message);
    }
  }

  async handleTaskBoardEvent(event: TaskBoardDataChangedEvent): Promise<void> {
    if (this.deps.getIsClosing() || !this.deps.getIsReady()) {
      return;
    }

    const filterState = this.deps.getFilterState();
    const isRelevantWorkspace = !filterState.workspaceId ||
      filterState.workspaceId === 'all' ||
      filterState.workspaceId === event.workspaceId;

    if (!isRelevantWorkspace) {
      return;
    }

    if (this.deps.getIsEditModalOpen() || this.deps.getDragTaskId() || this.deps.getIsSyncingBoardData()) {
      this.deps.setPendingEvent(event);
      return;
    }

    await this.syncFromEvent(event);
  }

  async flushPendingEvent(): Promise<void> {
    const pendingEvent = this.deps.getPendingEvent();
    if (!pendingEvent) {
      return;
    }

    this.deps.setPendingEvent(null);
    await this.syncFromEvent(pendingEvent);
  }

  async syncFromEvent(event?: TaskBoardDataChangedEvent): Promise<void> {
    if (this.deps.getIsClosing() || !this.deps.getIsReady() || this.deps.getIsSyncingBoardData()) {
      return;
    }

    this.deps.setIsSyncingBoardData(true);
    try {
      await this.deps.loadBoardData();
      if (!this.deps.getIsClosing()) {
        if (event?.entity === 'task' && event.action !== 'moved') {
          this.deps.refreshColumns();
        } else {
          this.deps.renderBoard();
        }
      }
    } catch (error) {
      console.error('[TaskBoardView] Event sync failed:', error);
      new Notice('Task board sync failed. Data may be stale.');
    } finally {
      this.deps.setIsSyncingBoardData(false);
    }
  }
}
