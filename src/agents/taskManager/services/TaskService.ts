/**
 * Location: src/agents/taskManager/services/TaskService.ts
 * Purpose: Business logic facade for task management. Orchestrates repositories and DAGService.
 * All tool-facing operations go through this service.
 *
 * Used by: All TaskManager tools
 * Dependencies: ProjectRepository, TaskRepository, IDAGService
 */

import {
  Edge,
  TaskNode,
  DependencyTree,
  TaskWithBlockers,
  IDAGService,
  CreateProjectData,
  UpdateProjectData,
  CreateTaskData,
  UpdateTaskData,
  TaskListOptions,
  ProjectListOptions,
  ProjectSummary,
  WorkspaceTaskSummary,
  LinkType,
  TaskStatus
} from '../types';
import type { IProjectRepository, ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { ITaskRepository, TaskMetadata, NoteLink } from '../../../database/repositories/interfaces/ITaskRepository';
import { PaginatedResult } from '../../../types/pagination/PaginationTypes';
import { TaskBoardEvents } from '../../../services/task/TaskBoardEvents';

/**
 * Function type for resolving a workspace identifier (UUID or name) to a UUID.
 * Returns the resolved UUID if found, or null if no match.
 */
export type WorkspaceResolver = (workspaceId: string) => Promise<string | null>;

export class TaskService {
  private resolveWorkspace: WorkspaceResolver | null;

  constructor(
    private projectRepo: IProjectRepository,
    private taskRepo: ITaskRepository,
    private dagService: IDAGService,
    resolveWorkspace?: WorkspaceResolver
  ) {
    this.resolveWorkspace = resolveWorkspace ?? null;
  }

  /**
   * Resolve a raw workspace identifier (UUID or name) to a workspace UUID.
   * If no resolver is configured, returns the raw ID unchanged.
   * Throws if the workspace cannot be found.
   */
  private async resolveWorkspaceId(rawId: string): Promise<string> {
    if (!this.resolveWorkspace) return rawId;

    const resolvedId = await this.resolveWorkspace(rawId);
    if (!resolvedId) {
      throw new Error(
        `Workspace "${rawId}" not found. Call loadWorkspace or createWorkspace first to get a valid workspaceId.`
      );
    }
    return resolvedId;
  }

  // ────────────────────────────────────────────────────────────────
  // Projects
  // ────────────────────────────────────────────────────────────────

  async createProject(workspaceId: string, data: CreateProjectData): Promise<string> {
    // Resolve workspace name → UUID transparently
    workspaceId = await this.resolveWorkspaceId(workspaceId);

    // Check for duplicate name in workspace
    const existing = await this.projectRepo.getByName(workspaceId, data.name);
    if (existing) {
      throw new Error(`Project "${data.name}" already exists in this workspace`);
    }

    const now = Date.now();
    const projectId = await this.projectRepo.create({
      name: data.name,
      description: data.description,
      workspaceId,
      metadata: data.metadata
    });

    TaskBoardEvents.notify({
      workspaceId,
      entity: 'project',
      action: 'created',
      projectId
    });

    return projectId;
  }

  async listProjects(workspaceId: string, options?: ProjectListOptions): Promise<PaginatedResult<ProjectMetadata>> {
    workspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.projectRepo.getByWorkspace(workspaceId, {
      page: options?.page,
      pageSize: options?.pageSize,
      status: options?.status
    });
  }

  async updateProject(projectId: string, data: UpdateProjectData): Promise<void> {
    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    // If renaming, check for duplicate
    if (data.name && data.name !== project.name) {
      const existing = await this.projectRepo.getByName(project.workspaceId, data.name);
      if (existing) {
        throw new Error(`Project "${data.name}" already exists in this workspace`);
      }
    }

    await this.projectRepo.update(projectId, {
      ...data,
      updated: Date.now()
    });

    TaskBoardEvents.notify({
      workspaceId: project.workspaceId,
      entity: 'project',
      action: 'updated',
      projectId
    });
  }

  async archiveProject(projectId: string): Promise<void> {
    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    await this.projectRepo.update(projectId, {
      status: 'archived',
      updated: Date.now()
    });

    TaskBoardEvents.notify({
      workspaceId: project.workspaceId,
      entity: 'project',
      action: 'archived',
      projectId
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    await this.projectRepo.delete(projectId);

    TaskBoardEvents.notify({
      workspaceId: project.workspaceId,
      entity: 'project',
      action: 'deleted',
      projectId
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Tasks
  // ────────────────────────────────────────────────────────────────

  async createTask(projectId: string, data: CreateTaskData): Promise<string> {
    // Verify project exists
    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    // Verify parent task exists if specified
    if (data.parentTaskId) {
      const parent = await this.taskRepo.getById(data.parentTaskId);
      if (!parent) {
        throw new Error(`Parent task "${data.parentTaskId}" not found`);
      }
      if (parent.projectId !== projectId) {
        throw new Error('Parent task must be in the same project');
      }
    }

    const taskId = await this.taskRepo.create({
      projectId,
      workspaceId: project.workspaceId,
      title: data.title,
      description: data.description,
      parentTaskId: data.parentTaskId,
      priority: data.priority ?? 'medium',
      dueDate: data.dueDate,
      assignee: data.assignee,
      tags: data.tags,
      metadata: data.metadata
    });

    // Create initial dependency edges
    if (data.dependsOn && data.dependsOn.length > 0) {
      const allEdges = await this.taskRepo.getAllDependencyEdges(projectId);
      for (const depId of data.dependsOn) {
        const depTask = await this.taskRepo.getById(depId);
        if (!depTask) {
          throw new Error(`Dependency task "${depId}" not found`);
        }
        if (depTask.projectId !== projectId) {
          throw new Error(`Dependency task "${depId}" is in a different project`);
        }
        // Validate no cycle (add edge to check list for subsequent checks)
        const isSafe = this.dagService.validateNoCycle(taskId, depId, allEdges);
        if (!isSafe) {
          throw new Error(`Adding dependency on "${depId}" would create a cycle`);
        }
        allEdges.push({ taskId, dependsOnTaskId: depId });
        await this.taskRepo.addDependency(taskId, depId);
      }
    }

    // Create initial note links
    if (data.linkedNotes && data.linkedNotes.length > 0) {
      for (const notePath of data.linkedNotes) {
        await this.taskRepo.addNoteLink(taskId, notePath, 'reference');
      }
    }

    TaskBoardEvents.notify({
      workspaceId: project.workspaceId,
      entity: 'task',
      action: 'created',
      taskId,
      projectId
    });

    return taskId;
  }

  async listTasks(projectId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>> {
    return this.taskRepo.getByProject(projectId, {
      page: options?.page,
      pageSize: options?.pageSize,
      status: options?.status,
      priority: options?.priority,
      assignee: options?.assignee,
      parentTaskId: options?.parentTaskId,
      sortBy: options?.sortBy,
      sortOrder: options?.sortOrder
    });
  }

  async listWorkspaceTasks(workspaceId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>> {
    workspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.taskRepo.getByWorkspace(workspaceId, {
      page: options?.page,
      pageSize: options?.pageSize,
      status: options?.status,
      priority: options?.priority,
      assignee: options?.assignee,
      parentTaskId: options?.parentTaskId,
      includeSubtasks: options?.includeSubtasks,
      sortBy: options?.sortBy,
      sortOrder: options?.sortOrder
    });
  }

  async updateTask(taskId: string, data: UpdateTaskData): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const updateData: Partial<TaskMetadata> & { updated: number } = {
      ...data,
      updated: Date.now()
    };

    // Set completedAt when marking done
    if (data.status === 'done' && task.status !== 'done') {
      updateData.completedAt = Date.now();
    }
    // Clear completedAt if re-opening
    if (data.status && data.status !== 'done' && task.status === 'done') {
      updateData.completedAt = undefined;
    }

    await this.taskRepo.update(taskId, updateData);

    TaskBoardEvents.notify({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'updated',
      taskId,
      projectId: task.projectId
    });
  }

  async moveTask(taskId: string, target: { projectId?: string; parentTaskId?: string | null }): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    const updateData: Partial<TaskMetadata> & { updated: number } = { updated: Date.now() };

    if (target.projectId && target.projectId !== task.projectId) {
      const newProject = await this.projectRepo.getById(target.projectId);
      if (!newProject) {
        throw new Error(`Target project "${target.projectId}" not found`);
      }
      // Cross-workspace moves are prohibited
      if (newProject.workspaceId !== task.workspaceId) {
        throw new Error('Cannot move task to a project in a different workspace');
      }
      updateData.projectId = target.projectId;
    }

    if (target.parentTaskId !== undefined) {
      if (target.parentTaskId === null) {
        // Move to top-level
        updateData.parentTaskId = undefined;
      } else {
        const parent = await this.taskRepo.getById(target.parentTaskId);
        if (!parent) {
          throw new Error(`Parent task "${target.parentTaskId}" not found`);
        }
        // Can't make a task its own parent
        if (target.parentTaskId === taskId) {
          throw new Error('A task cannot be its own parent');
        }
        updateData.parentTaskId = target.parentTaskId;
      }
    }

    await this.taskRepo.update(taskId, updateData);

    TaskBoardEvents.notify({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'moved',
      taskId,
      projectId: (updateData.projectId as string | undefined) || task.projectId
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    await this.taskRepo.delete(taskId);

    TaskBoardEvents.notify({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'deleted',
      taskId,
      projectId: task.projectId
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Dependencies
  // ────────────────────────────────────────────────────────────────

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const depTask = await this.taskRepo.getById(dependsOnTaskId);
    if (!depTask) throw new Error(`Dependency task "${dependsOnTaskId}" not found`);

    if (task.projectId !== depTask.projectId) {
      throw new Error('Dependencies must be within the same project');
    }

    const allEdges = await this.taskRepo.getAllDependencyEdges(task.projectId);
    const isSafe = this.dagService.validateNoCycle(taskId, dependsOnTaskId, allEdges);
    if (!isSafe) {
      throw new Error('Adding this dependency would create a cycle');
    }

    await this.taskRepo.addDependency(taskId, dependsOnTaskId);
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.taskRepo.removeDependency(taskId, dependsOnTaskId);
  }

  // ────────────────────────────────────────────────────────────────
  // DAG Queries
  // ────────────────────────────────────────────────────────────────

  async getNextActions(projectId: string): Promise<TaskMetadata[]> {
    const allTasks = await this.taskRepo.getByProject(projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(projectId);

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const readyNodes = this.dagService.getNextActions(nodes, allEdges);
    const readyIds = new Set(readyNodes.map(n => n.id));

    // Sort by priority then creation date
    const priorityOrder: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
    return allTasks.items
      .filter(t => readyIds.has(t.id))
      .sort((a, b) => {
        const pDiff = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
        return pDiff !== 0 ? pDiff : a.created - b.created;
      });
  }

  async getBlockedTasks(projectId: string): Promise<TaskWithBlockers[]> {
    const allTasks = await this.taskRepo.getByProject(projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(projectId);

    const taskMap = new Map<string, TaskMetadata>();
    for (const t of allTasks.items) {
      taskMap.set(t.id, t);
    }

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const blockedNodes = this.dagService.getBlockedTasks(nodes, allEdges);
    const blockedIds = new Set(blockedNodes.map(n => n.id));

    const result: TaskWithBlockers[] = [];
    for (const task of allTasks.items) {
      if (!blockedIds.has(task.id)) continue;

      // Find which dependencies are blocking
      const blockers: TaskMetadata[] = [];
      for (const edge of allEdges) {
        if (edge.taskId !== task.id) continue;
        const depTask = taskMap.get(edge.dependsOnTaskId);
        if (depTask && depTask.status !== 'done' && depTask.status !== 'cancelled') {
          blockers.push(depTask);
        }
      }
      result.push({ task, blockedBy: blockers });
    }

    return result;
  }

  async getDependencyTree(taskId: string): Promise<DependencyTree> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const allTasks = await this.taskRepo.getByProject(task.projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(task.projectId);

    const taskMap = new Map<string, TaskMetadata>();
    for (const t of allTasks.items) {
      taskMap.set(t.id, t);
    }

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const { dependencies, dependents } = this.dagService.getDependencyTree(taskId, nodes, allEdges);

    return {
      task,
      dependencies: dependencies
        .map(dId => ({ task: taskMap.get(dId)!, dependencies: [], dependents: [] }))
        .filter(n => n.task),
      dependents: dependents
        .map(dId => ({ task: taskMap.get(dId)!, dependencies: [], dependents: [] }))
        .filter(n => n.task)
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Note Links
  // ────────────────────────────────────────────────────────────────

  async linkNote(taskId: string, notePath: string, linkType: LinkType): Promise<void> {
    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    await this.taskRepo.addNoteLink(taskId, notePath, linkType);
  }

  async unlinkNote(taskId: string, notePath: string): Promise<void> {
    await this.taskRepo.removeNoteLink(taskId, notePath);
  }

  async getTasksForNote(notePath: string): Promise<TaskMetadata[]> {
    return this.taskRepo.getByLinkedNote(notePath);
  }

  // ────────────────────────────────────────────────────────────────
  // Workspace Summary (for loadWorkspace integration)
  // ────────────────────────────────────────────────────────────────

  async getWorkspaceSummary(workspaceId: string): Promise<WorkspaceTaskSummary> {
    workspaceId = await this.resolveWorkspaceId(workspaceId);
    const projects = await this.projectRepo.getByWorkspace(workspaceId, { pageSize: 1000 });
    const allTasks = await this.taskRepo.getByWorkspace(workspaceId, { pageSize: 10000 });

    // Build project summaries
    const projectItems: ProjectSummary[] = [];
    const taskCountByProject = new Map<string, number>();
    for (const task of allTasks.items) {
      taskCountByProject.set(task.projectId, (taskCountByProject.get(task.projectId) ?? 0) + 1);
    }
    for (const project of projects.items) {
      if (project.status !== 'archived') {
        projectItems.push({
          id: project.id,
          name: project.name,
          taskCount: taskCountByProject.get(project.id) ?? 0,
          status: project.status
        });
      }
    }

    // Count by status
    const byStatus: Record<TaskStatus, number> = { todo: 0, in_progress: 0, done: 0, cancelled: 0 };
    let overdue = 0;
    const now = Date.now();
    for (const task of allTasks.items) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1;
      if (task.dueDate && task.dueDate < now && task.status !== 'done' && task.status !== 'cancelled') {
        overdue++;
      }
    }

    // Compute next actions in-memory from already-fetched workspace tasks.
    // Fetch edges per active project in parallel (avoids N+1 sequential getNextActions calls
    // that each re-fetched all tasks + edges independently).
    const activeProjects = projects.items.filter(p => p.status === 'active');
    const edgeArrays = await Promise.all(
      activeProjects.map(p => this.taskRepo.getAllDependencyEdges(p.id))
    );
    const allEdges: Edge[] = edgeArrays.flat();

    const activeProjectIds = new Set(activeProjects.map(p => p.id));
    const activeTasks = allTasks.items.filter(t => activeProjectIds.has(t.projectId));
    const nodes: TaskNode[] = activeTasks.map(t => ({ id: t.id, status: t.status }));
    const readyNodes = this.dagService.getNextActions(nodes, allEdges);
    const readyIds = new Set(readyNodes.map(n => n.id));

    const priorityOrder: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
    const topNextActions = activeTasks
      .filter(t => readyIds.has(t.id))
      .sort((a, b) => {
        const pDiff = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
        return pDiff !== 0 ? pDiff : a.created - b.created;
      })
      .slice(0, 5);

    // Recently completed (last 5)
    const completed = allTasks.items
      .filter(t => t.status === 'done' && t.completedAt)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 5);

    return {
      projects: {
        total: projects.totalItems,
        active: projectItems.length,
        items: projectItems
      },
      tasks: {
        total: allTasks.totalItems,
        byStatus,
        overdue,
        nextActions: topNextActions,
        recentlyCompleted: completed
      }
    };
  }
}
