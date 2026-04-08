jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  App: jest.fn()
}), { virtual: true });

const modalOpenMock = jest.fn();
let lastModalOptions: Record<string, unknown> | null = null;

jest.mock('../../src/ui/tasks/TaskBoardEditModal', () => ({
  TaskBoardEditModal: jest.fn().mockImplementation((_app: unknown, options: Record<string, unknown>) => {
    lastModalOptions = options;
    return {
      open: modalOpenMock
    };
  })
}));

import { Notice } from 'obsidian';
import type { NoteLink, TaskMetadata } from '../../src/database/repositories/interfaces/ITaskRepository';
import type { ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';
import type { TaskBoardTask } from '../../src/ui/tasks/taskBoardTypes';
import { TaskBoardEditCoordinator } from '../../src/ui/tasks/services/TaskBoardEditCoordinator';

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

function createProject(overrides: Partial<ProjectMetadata> = {}): ProjectMetadata {
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Project One',
    status: 'active',
    created: 1,
    updated: 2,
    ...overrides
  };
}

function createLink(overrides: Partial<NoteLink> = {}): NoteLink {
  return {
    taskId: 'task-1',
    notePath: 'Notes/Task One.md',
    linkType: 'reference',
    created: 1,
    ...overrides
  };
}

describe('TaskBoardEditCoordinator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    lastModalOptions = null;
  });

  it('opens the modal with workspace-scoped project and parent task options', () => {
    const stateChanges: boolean[] = [];
    const onEditModalClose = jest.fn();

    const coordinator = new TaskBoardEditCoordinator({
      app: {} as never,
      getTaskService: () => null,
      getProjects: () => [
        createProject({ id: 'proj-1', workspaceId: 'ws-1', name: 'Alpha' }),
        createProject({ id: 'proj-2', workspaceId: 'ws-1', name: 'Beta' }),
        createProject({ id: 'proj-3', workspaceId: 'ws-2', name: 'Gamma' })
      ],
      getTasks: () => [
        createTask({ id: 'task-1', workspaceId: 'ws-1', projectId: 'proj-1' }),
        createTask({ id: 'task-2', workspaceId: 'ws-1', projectId: 'proj-2', title: 'Sibling task' }),
        createTask({ id: 'task-3', workspaceId: 'ws-2', projectId: 'proj-3', title: 'Other workspace task' })
      ],
      getEmbeddingService: () => undefined,
      reloadBoard: jest.fn().mockResolvedValue(undefined),
      renderBoard: jest.fn(),
      onEditModalStateChange: (isOpen) => stateChanges.push(isOpen),
      onEditModalClose,
      toDateInputValue: (timestamp) => timestamp ? '2026-04-08' : '',
      fromDateInputValue: () => undefined
    });

    coordinator.openEditModal(createTask({
      id: 'task-1',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      dueDate: 123,
      noteLinks: [createLink()]
    }));

    expect(modalOpenMock).toHaveBeenCalledTimes(1);
    expect(stateChanges).toEqual([true]);
    expect(lastModalOptions).not.toBeNull();
    expect(lastModalOptions?.projects).toEqual([
      { id: 'proj-1', name: 'Alpha' },
      { id: 'proj-2', name: 'Beta' }
    ]);
    expect(lastModalOptions?.parentTasks).toEqual([
      { id: 'task-2', title: 'Sibling task', projectId: 'proj-2' }
    ]);
    expect(lastModalOptions?.task).toEqual(expect.objectContaining({
      id: 'task-1',
      dueDate: '2026-04-08',
      noteLinks: [expect.objectContaining({ notePath: 'Notes/Task One.md' })]
    }));

    const onClose = lastModalOptions?.onClose as (() => void) | undefined;
    onClose?.();

    expect(stateChanges).toEqual([true, false]);
    expect(onEditModalClose).toHaveBeenCalledTimes(1);
  });

  it('saves task changes, moves the task, and syncs linked notes', async () => {
    const taskService = {
      updateTask: jest.fn().mockResolvedValue(undefined),
      moveTask: jest.fn().mockResolvedValue(undefined),
      unlinkNote: jest.fn().mockResolvedValue(undefined),
      linkNote: jest.fn().mockResolvedValue(undefined)
    };
    const reloadBoard = jest.fn().mockResolvedValue(undefined);
    const renderBoard = jest.fn();

    const coordinator = new TaskBoardEditCoordinator({
      app: {} as never,
      getTaskService: () => taskService as never,
      getProjects: () => [],
      getTasks: () => [],
      getEmbeddingService: () => undefined,
      reloadBoard,
      renderBoard,
      onEditModalStateChange: jest.fn(),
      onEditModalClose: jest.fn(),
      toDateInputValue: () => '',
      fromDateInputValue: (value) => value === '2026-04-10' ? 1712707200000 : undefined
    });

    const originalTask = createTask({
      id: 'task-1',
      projectId: 'proj-1',
      parentTaskId: 'parent-old',
      noteLinks: [
        createLink({ notePath: 'Notes/Keep.md' }),
        createLink({ notePath: 'Notes/Remove.md' })
      ]
    });

    await coordinator.saveTaskChanges(originalTask, {
      id: 'task-1',
      workspaceId: 'ws-1',
      projectId: 'proj-2',
      title: ' Updated task ',
      description: ' Refined description ',
      status: 'done',
      priority: 'high',
      dueDate: '2026-04-10',
      assignee: ' Alex ',
      tags: 'alpha, beta, ,  gamma ',
      parentTaskId: 'parent-new',
      noteLinks: [
        createLink({ notePath: 'Notes/Keep.md', linkType: 'reference' }),
        createLink({ notePath: 'Notes/Add.md', linkType: 'embed' })
      ]
    });

    expect(taskService.updateTask).toHaveBeenCalledWith('task-1', {
      title: 'Updated task',
      description: 'Refined description',
      status: 'done',
      priority: 'high',
      dueDate: 1712707200000,
      assignee: 'Alex',
      tags: ['alpha', 'beta', 'gamma']
    });
    expect(taskService.moveTask).toHaveBeenCalledWith('task-1', {
      projectId: 'proj-2',
      parentTaskId: 'parent-new'
    });
    expect(taskService.unlinkNote).toHaveBeenCalledWith('task-1', 'Notes/Remove.md');
    expect(taskService.linkNote).toHaveBeenCalledWith('task-1', 'Notes/Add.md', 'embed');
    expect(reloadBoard).toHaveBeenCalledTimes(1);
    expect(renderBoard).toHaveBeenCalledTimes(1);
    expect(Notice).toHaveBeenCalledWith('Task saved');
  });
});
