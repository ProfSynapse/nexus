import type { ProjectMetadata } from '../../src/database/repositories/interfaces/IProjectRepository';
import type { WorkspaceMetadata } from '../../src/types/storage/StorageTypes';
import type { TaskBoardViewState } from '../../src/ui/tasks/taskBoardNavigation';
import type { TaskBoardTask } from '../../src/ui/tasks/taskBoardTypes';
import { TaskBoardFilterController } from '../../src/ui/tasks/services/TaskBoardFilterController';

function createWorkspace(overrides: Partial<WorkspaceMetadata> = {}): WorkspaceMetadata {
  return {
    id: 'ws-1',
    name: 'Workspace One',
    rootFolder: 'Workspace One',
    created: 1,
    lastAccessed: 10,
    sessionCount: 0,
    traceCount: 0,
    ...overrides
  };
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

describe('TaskBoardFilterController', () => {
  it('normalizes and validates workspace and project filters against available data', () => {
    const workspaces = [createWorkspace({ id: 'ws-1' })];
    const projects = [createProject({ id: 'proj-1', workspaceId: 'ws-1' })];
    const state: TaskBoardViewState = {
      workspaceId: 'missing-workspace',
      projectId: 'missing-project',
      search: '',
      sortField: 'updated',
      sortOrder: 'desc'
    };

    expect(
      TaskBoardFilterController.ensureValidFilters(state, workspaces, projects)
    ).toEqual({
      workspaceId: 'all',
      projectId: 'all',
      search: '',
      sortField: 'updated',
      sortOrder: 'desc'
    });
  });

  it('returns only projects in the selected workspace for the toolbar', () => {
    const projects = [
      createProject({ id: 'proj-1', workspaceId: 'ws-1', name: 'Alpha' }),
      createProject({ id: 'proj-2', workspaceId: 'ws-2', name: 'Beta' })
    ];

    expect(
      TaskBoardFilterController.getFilteredProjectsForToolbar(projects, { workspaceId: 'ws-1' })
    ).toEqual([projects[0]]);

    expect(
      TaskBoardFilterController.getFilteredProjectsForToolbar(projects, { workspaceId: 'all' })
    ).toEqual(projects);
  });

  it('filters tasks by workspace, project, and search query', () => {
    const tasks = [
      createTask({
        id: 'task-1',
        title: 'Write migration plan',
        description: 'SQLite migration',
        workspaceId: 'ws-1',
        projectId: 'proj-1'
      }),
      createTask({
        id: 'task-2',
        title: 'Review UI',
        workspaceId: 'ws-2',
        projectId: 'proj-2',
        projectName: 'Project Two',
        workspaceName: 'Workspace Two'
      })
    ];

    expect(
      TaskBoardFilterController.getFilteredAndSortedTasks(tasks, {
        workspaceId: 'ws-1',
        projectId: 'proj-1',
        search: 'migration'
      })
    ).toEqual([tasks[0]]);
  });

  it('sorts tasks using the configured field and order', () => {
    const tasks = [
      createTask({
        id: 'task-low',
        title: 'Low priority',
        priority: 'low',
        dueDate: 50
      }),
      createTask({
        id: 'task-critical',
        title: 'Critical priority',
        priority: 'critical',
        dueDate: 10
      }),
      createTask({
        id: 'task-medium',
        title: 'Medium priority',
        priority: 'medium',
        dueDate: undefined
      })
    ];

    expect(
      TaskBoardFilterController.getFilteredAndSortedTasks(tasks, {
        sortField: 'priority',
        sortOrder: 'asc'
      }).map(task => task.id)
    ).toEqual(['task-critical', 'task-medium', 'task-low']);

    expect(
      TaskBoardFilterController.getFilteredAndSortedTasks(tasks, {
        sortField: 'dueDate',
        sortOrder: 'desc'
      }).map(task => task.id)
    ).toEqual(['task-medium', 'task-low', 'task-critical']);
  });
});
