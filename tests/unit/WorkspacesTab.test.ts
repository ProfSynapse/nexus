import { App } from 'obsidian';
import { WorkspacesTab } from '../../src/settings/tabs/WorkspacesTab';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { TaskService } from '../../src/agents/taskManager/services/TaskService';

function createMockElement(): HTMLElement {
  const element: Record<string, any> = {
    classList: {
      add: jest.fn(),
      remove: jest.fn()
    },
    addClass: jest.fn(),
    removeClass: jest.fn(),
    setAttribute: jest.fn(),
    empty: jest.fn(),
    createEl: jest.fn((_tag: string, _options?: Record<string, unknown>) => createMockElement()),
    createDiv: jest.fn((_cls?: string) => createMockElement()),
    createSpan: jest.fn((_options?: Record<string, unknown>) => createMockElement()),
    appendChild: jest.fn(),
    textContent: ''
  };

  return element as unknown as HTMLElement;
}

function createMockTaskService(): jest.Mocked<TaskService> {
  return {
    createProject: jest.fn(),
    listProjects: jest.fn(),
    updateProject: jest.fn(),
    archiveProject: jest.fn(),
    deleteProject: jest.fn(),
    createTask: jest.fn(),
    listTasks: jest.fn(),
    updateTask: jest.fn(),
    moveTask: jest.fn(),
    deleteTask: jest.fn(),
    addDependency: jest.fn(),
    removeDependency: jest.fn(),
    getNextActions: jest.fn(),
    getBlockedTasks: jest.fn(),
    getDependencyTree: jest.fn(),
    linkNote: jest.fn(),
    unlinkNote: jest.fn(),
    getTasksForNote: jest.fn(),
    getWorkspaceSummary: jest.fn()
  } as unknown as jest.Mocked<TaskService>;
}

describe('WorkspacesTab task management', () => {
  function createTab() {
    const container = createMockElement();
    const router = new SettingsRouter();
    const tab = new WorkspacesTab(container, router, {
      app: new App(),
      prefetchedWorkspaces: [],
      workspaceService: undefined
    });

    return tab as any;
  }

  it('opens the projects page for the current workspace', async () => {
    const tab = createTab();
    const taskService = createMockTaskService();
    taskService.listProjects.mockResolvedValue({
      items: [
        { id: 'proj-1', workspaceId: 'ws-1', name: 'Planning', description: 'Desc', status: 'active', created: 1, updated: 1 }
      ],
      totalItems: 1,
      totalPages: 1,
      currentPage: 1,
      pageSize: 1000,
      hasNextPage: false
    });
    taskService.listTasks.mockResolvedValue({
      items: [],
      totalItems: 0,
      totalPages: 0,
      currentPage: 1,
      pageSize: 1000,
      hasNextPage: false
    });

    tab.currentWorkspace = { id: 'ws-1', name: 'Workspace' };
    tab.taskService = taskService;
    tab.render = jest.fn();

    await tab.openProjectsPage();

    expect(taskService.listProjects).toHaveBeenCalledWith('ws-1', { pageSize: 1000 });
    expect(tab.currentView).toBe('projects');
    expect(tab.currentProjects).toHaveLength(1);
    expect(tab.render).toHaveBeenCalled();
  });

  it('opens a project detail page with task rows', async () => {
    const tab = createTab();
    const taskService = createMockTaskService();
    const project = {
      id: 'proj-1',
      workspaceId: 'ws-1',
      name: 'Planning',
      description: 'Desc',
      status: 'active' as const,
      created: 1,
      updated: 1
    };

    taskService.listTasks.mockResolvedValue({
      items: [
        {
          id: 'task-1',
          projectId: 'proj-1',
          workspaceId: 'ws-1',
          title: 'Draft timeline',
          status: 'todo',
          priority: 'medium',
          created: 1,
          updated: 1
        }
      ],
      totalItems: 1,
      totalPages: 1,
      currentPage: 1,
      pageSize: 1000,
      hasNextPage: false
    });

    tab.currentWorkspace = { id: 'ws-1', name: 'Workspace' };
    tab.taskService = taskService;
    tab.render = jest.fn();

    await tab.openProjectDetail(project);

    expect(taskService.listTasks).toHaveBeenCalledWith('proj-1', { pageSize: 1000, includeSubtasks: true });
    expect(tab.currentView).toBe('project-detail');
    expect(tab.currentProject.name).toBe('Planning');
    expect(tab.currentTasks).toHaveLength(1);
  });

  it('opens the task detail page for editing', () => {
    const tab = createTab();
    const task = {
      id: 'task-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      title: 'Draft timeline',
      description: 'Desc',
      status: 'todo' as const,
      priority: 'high' as const,
      created: 1,
      updated: 1
    };

    tab.currentWorkspace = { id: 'ws-1', name: 'Workspace' };
    tab.currentProject = { id: 'proj-1', workspaceId: 'ws-1', name: 'Planning', description: '', status: 'active' };
    tab.render = jest.fn();

    tab.openTaskDetail(task);

    expect(tab.currentView).toBe('task-detail');
    expect(tab.currentTask.title).toBe('Draft timeline');
    expect(tab.editingTaskOriginal).toEqual(task);
    expect(tab.render).toHaveBeenCalled();
  });

  it('updates task status from checkbox changes', async () => {
    const tab = createTab();
    const taskService = createMockTaskService();
    const task = {
      id: 'task-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      title: 'Draft timeline',
      status: 'todo' as const,
      priority: 'medium' as const,
      created: 1,
      updated: 1
    };

    taskService.updateTask.mockResolvedValue();
    tab.taskService = taskService;
    tab.currentTasks = [task];
    tab.render = jest.fn();

    await tab.handleTaskCheckboxChange(task, true);

    expect(taskService.updateTask).toHaveBeenCalledWith('task-1', { status: 'done' });
    expect(tab.currentTasks[0].status).toBe('done');
    expect(tab.render).toHaveBeenCalled();
  });
});
