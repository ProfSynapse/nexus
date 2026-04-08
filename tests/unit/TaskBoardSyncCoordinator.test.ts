jest.mock('obsidian', () => ({
  Notice: jest.fn()
}), { virtual: true });

import { Notice } from 'obsidian';
import type { TaskBoardDataChangedEvent } from '../../src/services/task/TaskBoardEvents';
import type { TaskBoardTask } from '../../src/ui/tasks/taskBoardTypes';
import { TaskBoardSyncCoordinator } from '../../src/ui/tasks/services/TaskBoardSyncCoordinator';

function createTask(overrides: Partial<TaskBoardTask> = {}): TaskBoardTask {
  return {
    id: 'task-1',
    projectId: 'proj-1',
    workspaceId: 'ws-1',
    title: 'Task one',
    description: '',
    status: 'todo',
    priority: 'medium',
    created: 1,
    updated: 2,
    projectName: 'Project One',
    workspaceName: 'Workspace One',
    noteLinks: [],
    ...overrides
  } as TaskBoardTask;
}

function createEvent(overrides: Partial<TaskBoardDataChangedEvent> = {}): TaskBoardDataChangedEvent {
  return {
    workspaceId: 'ws-1',
    entity: 'task',
    action: 'updated',
    taskId: 'task-1',
    ...overrides
  };
}

describe('TaskBoardSyncCoordinator', () => {
  let tasks: TaskBoardTask[];
  let pendingEvent: TaskBoardDataChangedEvent | null;
  let isSyncingBoardData: boolean;
  let isEditModalOpen: boolean;
  let dragTaskId: string | null;
  let isClosing: boolean;
  let isReady: boolean;
  let loadBoardData: jest.Mock;
  let refreshColumns: jest.Mock;
  let renderBoard: jest.Mock;
  let taskService: { updateTask: jest.Mock };

  function createCoordinator() {
    return new TaskBoardSyncCoordinator({
      getTaskService: () => taskService as never,
      getTasks: () => tasks,
      getFilterState: () => ({
        workspaceId: 'ws-1',
        projectId: 'all',
        search: '',
        sortField: 'updated',
        sortOrder: 'desc'
      }),
      getIsClosing: () => isClosing,
      getIsReady: () => isReady,
      getIsSyncingBoardData: () => isSyncingBoardData,
      setIsSyncingBoardData: (next) => {
        isSyncingBoardData = next;
      },
      getIsEditModalOpen: () => isEditModalOpen,
      getDragTaskId: () => dragTaskId,
      getPendingEvent: () => pendingEvent,
      setPendingEvent: (event) => {
        pendingEvent = event;
      },
      loadBoardData,
      refreshColumns,
      renderBoard
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    tasks = [createTask({ id: 'task-1', status: 'todo' })];
    pendingEvent = null;
    isSyncingBoardData = false;
    isEditModalOpen = false;
    dragTaskId = null;
    isClosing = false;
    isReady = true;
    loadBoardData = jest.fn().mockResolvedValue(undefined);
    refreshColumns = jest.fn();
    renderBoard = jest.fn();
    taskService = {
      updateTask: jest.fn().mockResolvedValue(undefined)
    };
  });

  it('rolls back optimistic status changes when the update fails', async () => {
    taskService.updateTask.mockRejectedValue(new Error('Status update failed'));
    const coordinator = createCoordinator();

    await coordinator.handleTaskStatusDrop('task-1', 'done');

    expect(tasks[0].status).toBe('todo');
    expect(refreshColumns).toHaveBeenCalledTimes(2);
    expect(Notice).toHaveBeenCalledWith('Status update failed');
  });

  it('defers relevant board events while the edit modal is open and flushes them later', async () => {
    isEditModalOpen = true;
    const coordinator = createCoordinator();
    const event = createEvent({ action: 'updated' });

    await coordinator.handleTaskBoardEvent(event);

    expect(pendingEvent).toEqual(event);
    expect(loadBoardData).not.toHaveBeenCalled();

    isEditModalOpen = false;
    await coordinator.flushPendingEvent();

    expect(pendingEvent).toBeNull();
    expect(loadBoardData).toHaveBeenCalledTimes(1);
    expect(refreshColumns).toHaveBeenCalledTimes(1);
  });

  it('uses a full render for moved or project-scoped events', async () => {
    const coordinator = createCoordinator();

    await coordinator.syncFromEvent(createEvent({ action: 'moved' }));
    await coordinator.syncFromEvent(createEvent({ entity: 'project', action: 'updated', projectId: 'proj-1' }));

    expect(renderBoard).toHaveBeenCalledTimes(2);
    expect(refreshColumns).not.toHaveBeenCalled();
  });
});
