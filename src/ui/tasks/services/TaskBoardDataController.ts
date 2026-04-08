import type NexusPlugin from '../../../main';
import type { WorkspaceService } from '../../../services/WorkspaceService';
import type { AgentRegistrationService } from '../../../services/agent/AgentRegistrationService';
import type { AgentManager } from '../../../services/AgentManager';
import type { WorkspaceMetadata } from '../../../types/storage/StorageTypes';
import type { TaskService } from '../../../agents/taskManager/services/TaskService';
import type { ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { NoteLink } from '../../../database/repositories/interfaces/ITaskRepository';
import type { TaskBoardViewState } from '../taskBoardNavigation';
import type { TaskBoardTask } from '../taskBoardTypes';
import { TaskBoardFilterController } from './TaskBoardFilterController';

interface TaskManagerAgentLike {
  getTaskService?: () => TaskService;
}

export interface TaskBoardDataSnapshot {
  workspaces: WorkspaceMetadata[];
  projects: ProjectMetadata[];
  tasks: TaskBoardTask[];
  filterState: TaskBoardViewState;
}

export class TaskBoardDataController {
  private workspaceService: WorkspaceService | null = null;
  private agentRegistrationService: AgentRegistrationService | null = null;
  private taskService: TaskService | null = null;

  constructor(private plugin: NexusPlugin) {}

  getWorkspaceService(): WorkspaceService | null {
    return this.workspaceService;
  }

  getTaskService(): TaskService | null {
    return this.taskService;
  }

  async ensureServices(): Promise<void> {
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
  }

  async loadBoardData(filterState: TaskBoardViewState): Promise<TaskBoardDataSnapshot> {
    const workspaceService = this.workspaceService;
    const taskService = this.taskService;
    if (!workspaceService || !taskService) {
      throw new Error('Task board services are not initialized');
    }

    const nextFilterState = TaskBoardFilterController.normalizeState(filterState);
    const workspaces = (await workspaceService.getWorkspaces({
      sortBy: 'lastAccessed',
      sortOrder: 'desc'
    })).filter(workspace => !workspace.isArchived);

    if (!nextFilterState.workspaceId) {
      const activeWorkspace = await workspaceService.getActiveWorkspace();
      nextFilterState.workspaceId = activeWorkspace?.id || 'all';
    }

    const workspaceData = await Promise.all(
      workspaces.map(async workspace => {
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

    const projects = workspaceData.flatMap(entry => entry.projects);
    const projectMap = new Map(projects.map(project => [project.id, project]));

    const tasks = workspaceData.flatMap(entry =>
      entry.tasks
        .filter(task => projectMap.has(task.projectId))
        .map(task => ({
          ...task,
          projectName: projectMap.get(task.projectId)?.name || 'Unknown project',
          workspaceName: entry.workspace.name,
          noteLinks: [] as NoteLink[]
        }))
    );

    const noteLinksResults = await Promise.all(
      tasks.map(task =>
        taskService.getNoteLinks(task.id).catch(() => [] as NoteLink[])
      )
    );

    tasks.forEach((task, index) => {
      task.noteLinks = noteLinksResults[index];
    });

    return {
      workspaces,
      projects,
      tasks,
      filterState: TaskBoardFilterController.ensureValidFilters(nextFilterState, workspaces, projects)
    };
  }
}
