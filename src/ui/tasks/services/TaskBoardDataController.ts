import type NexusPlugin from '../../../main';
import type { WorkspaceService } from '../../../services/WorkspaceService';
import type { AgentRegistrationService } from '../../../services/agent/AgentRegistrationService';
import type { AgentManager } from '../../../services/AgentManager';
import type { HybridStorageAdapter } from '../../../database/adapters/HybridStorageAdapter';
import type { WorkspaceMetadata } from '../../../types/storage/StorageTypes';
import type { TaskService } from '../../../agents/taskManager/services/TaskService';
import type { ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { NoteLink } from '../../../database/repositories/interfaces/ITaskRepository';
import type { TaskBoardViewState } from '../taskBoardNavigation';
import type { TaskBoardTask } from '../taskBoardTypes';
import { TaskBoardFilterController } from './TaskBoardFilterController';

/**
 * Page size used when draining paginated task/project queries for the board.
 * Matches BaseRepository's hard cap so each drained page is the largest the
 * repository will return (see issue #272 — a single large-pageSize request
 * silently truncates to this cap).
 */
const BOARD_PAGE_SIZE = 200;

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
  private storageAdapter: HybridStorageAdapter | null = null;

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

    if (!this.storageAdapter) {
      this.storageAdapter = await this.plugin.getService<HybridStorageAdapter>('hybridStorageAdapter');
    }
  }

  /**
   * Block until the local SQLite cache is hydrated from JSONL so the first
   * board load reads real data instead of an empty cache. During a cold start
   * or cache rebuild the adapter reports query-ready only once hydration has
   * finished; without this gate `getWorkspaces()` returns [] and the board
   * renders "No tasks" with no later refresh. Resolves (and proceeds) on the
   * adapter's own idle timeout rather than hanging forever.
   */
  private async waitForQueryReady(): Promise<void> {
    const adapter = this.storageAdapter;
    if (adapter && typeof adapter.waitForQueryReady === 'function') {
      await adapter.waitForQueryReady();
    }
  }

  /**
   * Drain every page of a paginated query into a single array. The repository
   * caps pageSize at BOARD_PAGE_SIZE, so a single large-pageSize request would
   * silently return only the first page (issue #272). Walk pages sequentially
   * until hasNextPage is false.
   *
   * @param loadPage - loads a single 0-indexed page
   * @returns all items across pages
   */
  private async loadAllPages<T>(
    loadPage: (page: number) => Promise<{ items: T[]; hasNextPage: boolean }>
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 0;

    for (;;) {
      const result = await loadPage(page);
      items.push(...result.items);
      if (!result.hasNextPage) {
        return items;
      }
      page += 1;
    }
  }

  async loadBoardData(filterState: TaskBoardViewState): Promise<TaskBoardDataSnapshot> {
    const workspaceService = this.workspaceService;
    const taskService = this.taskService;
    if (!workspaceService || !taskService) {
      throw new Error('Task board services are not initialized');
    }

    await this.waitForQueryReady();

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
        // Drain all project pages, then filter out archived projects BEFORE
        // loading their tasks. This both fixes the >200 truncation (issue #272)
        // and excludes archived-project tasks from the board snapshot by never
        // fetching them — replacing the old workspace-wide listWorkspaceTasks
        // (which pulled archived-project tasks too) with per-visible-project
        // listTasks. includeSubtasks:true preserves the prior default
        // (listWorkspaceTasks only excluded subtasks when includeSubtasks===false).
        const projects = (await this.loadAllPages(page =>
          taskService.listProjects(workspace.id, { page, pageSize: BOARD_PAGE_SIZE })
        )).filter(project => project.status !== 'archived');

        const tasksByProject = await Promise.all(
          projects.map(project =>
            this.loadAllPages(page =>
              taskService.listTasks(project.id, {
                page,
                pageSize: BOARD_PAGE_SIZE,
                includeSubtasks: true
              })
            )
          )
        );

        return {
          workspace,
          projects,
          tasks: tasksByProject.flat()
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
