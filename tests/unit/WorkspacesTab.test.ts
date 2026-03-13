import { App } from 'obsidian';
import { WorkspacesTab } from '../../src/settings/tabs/WorkspacesTab';
import { WorkspaceDetailRenderer } from '../../src/components/workspace/WorkspaceDetailRenderer';
import { SettingsRouter } from '../../src/settings/SettingsRouter';
import { TaskService } from '../../src/agents/taskManager/services/TaskService';
import { createMockElement } from '../helpers/mockFactories';

/**
 * Test-only interface exposing private WorkspacesTab members needed for testing.
 * Avoids `as any` while keeping test intent clear.
 */
interface TestableWorkspacesTab {
  currentWorkspace: { id: string; name: string } | null;
  currentView: string;
  projectsManager: {
    taskService: jest.Mocked<TaskService>;
    getCurrentProject(): { name: string };
    getCurrentTask(): { title: string };
    openTaskDetail(task: Record<string, unknown>): void;
    // Private field exposed for test setup
    currentProject: Record<string, unknown> | null;
  };
  render: jest.Mock;
  openProjectsPage(): Promise<void>;
  openProjectDetailAndRender(project: Record<string, unknown>): Promise<void>;
}

/**
 * Test-only interface exposing WorkspaceDetailRenderer's private
 * handleTaskCheckboxChange method.
 */
interface TestableDetailRenderer {
  handleTaskCheckboxChange(
    task: Record<string, unknown>,
    checked: boolean,
    callbacks: Record<string, unknown>
  ): Promise<void>;
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
  function createTab(): TestableWorkspacesTab {
    const container = createMockElement();
    const router = new SettingsRouter();
    const tab = new WorkspacesTab(container, router, {
      app: new App(),
      prefetchedWorkspaces: [],
      workspaceService: undefined
    });

    return tab as unknown as TestableWorkspacesTab;
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
    tab.projectsManager.taskService = taskService;
    tab.render = jest.fn();

    await tab.openProjectsPage();

    expect(taskService.listProjects).toHaveBeenCalledWith('ws-1', { pageSize: 1000 });
    expect(tab.currentView).toBe('projects');
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
    tab.projectsManager.taskService = taskService;
    tab.render = jest.fn();

    await tab.openProjectDetailAndRender(project);

    expect(taskService.listTasks).toHaveBeenCalledWith('proj-1', { pageSize: 1000, includeSubtasks: true });
    expect(tab.currentView).toBe('project-detail');
    const currentProject = tab.projectsManager.getCurrentProject();
    expect(currentProject.name).toBe('Planning');
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
    // Set up the project state through the projectsManager
    tab.projectsManager.openTaskDetail(task);

    // openTaskDetail needs a currentProject to be set
    const projectState = { id: 'proj-1', workspaceId: 'ws-1', name: 'Planning', description: '', status: 'active' };
    tab.projectsManager.currentProject = projectState;
    tab.projectsManager.openTaskDetail(task);

    const currentTask = tab.projectsManager.getCurrentTask();
    expect(currentTask.title).toBe('Draft timeline');
  });

  it('updates task status from checkbox changes', async () => {
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
    const onNavigateProjectDetail = jest.fn();

    const renderer = new WorkspaceDetailRenderer() as unknown as TestableDetailRenderer;
    const callbacks = {
      getTaskService: jest.fn().mockResolvedValue(taskService),
      onNavigateProjectDetail,
      safeRegisterDomEvent: jest.fn()
    };

    await renderer.handleTaskCheckboxChange(task, true, callbacks);

    expect(taskService.updateTask).toHaveBeenCalledWith('task-1', { status: 'done' });
    expect(task.status).toBe('done');
    expect(onNavigateProjectDetail).toHaveBeenCalled();
  });
});
