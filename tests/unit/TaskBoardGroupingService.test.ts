import type { TaskBoardViewState } from '../../src/ui/tasks/taskBoardNavigation';
import type { TaskBoardTask } from '../../src/ui/tasks/taskBoardTypes';
import { TaskBoardGroupingService } from '../../src/ui/tasks/services/TaskBoardGroupingService';

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
  };
}

describe('TaskBoardGroupingService', () => {
  it('groups child tasks under parent swimlanes and leaves unrelated tasks ungrouped', () => {
    const parent = createTask({ id: 'parent', title: 'Parent task' });
    const childA = createTask({ id: 'child-a', parentTaskId: 'parent', title: 'Child A' });
    const childB = createTask({ id: 'child-b', parentTaskId: 'parent', title: 'Child B' });
    const solo = createTask({ id: 'solo', title: 'Solo task' });
    const allTasks = [parent, childA, childB, solo];

    const groups = TaskBoardGroupingService.groupTasksByParent(
      allTasks,
      allTasks.filter(task => task.status === 'todo'),
      {}
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(
      expect.objectContaining({
        parentId: 'parent',
        parentTask: expect.objectContaining({ id: 'parent' }),
        children: [childA, childB]
      })
    );
    expect(groups[1]).toEqual(
      expect.objectContaining({
        parentId: null,
        children: [solo]
      })
    );
  });

  it('computes swimlane progress across filtered siblings only', () => {
    const parent = createTask({ id: 'parent', title: 'Parent task' });
    const doneChild = createTask({
      id: 'done-child',
      parentTaskId: 'parent',
      status: 'done'
    });
    const otherWorkspaceChild = createTask({
      id: 'other-workspace',
      parentTaskId: 'parent',
      workspaceId: 'ws-2',
      workspaceName: 'Workspace Two'
    });

    const groups = TaskBoardGroupingService.groupTasksByParent(
      [parent, doneChild, otherWorkspaceChild],
      [doneChild],
      { workspaceId: 'ws-1' }
    );

    expect(groups[0].progress).toEqual({ done: 1, total: 1 });
  });

  it('sorts parent swimlanes using the configured sort field and order', () => {
    const alphaParent = createTask({
      id: 'parent-a',
      title: 'Alpha parent',
      priority: 'low'
    });
    const betaParent = createTask({
      id: 'parent-b',
      title: 'Beta parent',
      priority: 'critical'
    });
    const alphaChild = createTask({ id: 'child-a', parentTaskId: 'parent-a' });
    const betaChild = createTask({ id: 'child-b', parentTaskId: 'parent-b' });
    const state: TaskBoardViewState = {
      sortField: 'priority',
      sortOrder: 'asc'
    };

    const groups = TaskBoardGroupingService.groupTasksByParent(
      [alphaParent, betaParent, alphaChild, betaChild],
      [alphaParent, betaParent, alphaChild, betaChild],
      state
    );

    expect(groups[0].parentId).toBe('parent-b');
    expect(groups[1].parentId).toBe('parent-a');
  });
});
