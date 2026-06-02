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
  TaskStatus,
  TaskWithNoteLinks,
  TaskNoteLink,
  LinkedNoteInput
} from '../types';
import type { IProjectRepository, ProjectMetadata } from '../../../database/repositories/interfaces/IProjectRepository';
import type { ITaskRepository, TaskMetadata, NoteLink } from '../../../database/repositories/interfaces/ITaskRepository';
import { PaginatedResult } from '../../../types/pagination/PaginationTypes';
import { logger } from '../../../utils/logger';

export interface TaskBoardEventPayload {
  workspaceId: string;
  entity: 'task' | 'project';
  action: 'created' | 'updated' | 'deleted' | 'moved' | 'archived';
  taskId?: string;
  projectId?: string;
}

export interface TaskBoardNotifier {
  notify(event: TaskBoardEventPayload): void;
}

/**
 * Function type for resolving a workspace identifier (UUID or name) to a UUID.
 * Returns the resolved UUID if found, or null if no match.
 */
export type WorkspaceResolver = (workspaceId: string) => Promise<string | null>;
export type TaskQueryReadyWaiter = () => Promise<boolean>;

/**
 * Normalize a createTask linkedNotes item to a uniform { notePath, linkType } shape.
 * A plain string is a vault path with linkType defaulting to "reference"; an object
 * keeps its notePath and falls back to "reference" when linkType is omitted.
 *
 * notePath is required and must be non-empty. Tool param schemas are advisory only —
 * they are not enforced at runtime before reaching the service — so guard here to reject
 * a missing/empty/whitespace notePath rather than silently persist an empty link.
 */
function normalizeLinkedNote(link: LinkedNoteInput): { notePath: string; linkType: LinkType } {
  if (typeof link === 'string') {
    if (link.trim().length === 0) {
      throw new Error('linkedNotes: notePath is required and cannot be empty');
    }
    return { notePath: link, linkType: 'reference' };
  }
  if (!link.notePath || link.notePath.trim().length === 0) {
    throw new Error('linkedNotes: notePath is required and cannot be empty');
  }
  return { notePath: link.notePath, linkType: link.linkType ?? 'reference' };
}

export class TaskService {
  private resolveWorkspace: WorkspaceResolver | null;

  constructor(
    private projectRepo: IProjectRepository,
    private taskRepo: ITaskRepository,
    private dagService: IDAGService,
    resolveWorkspace?: WorkspaceResolver,
    private taskBoardNotifier?: TaskBoardNotifier,
    private waitForQueryReady?: TaskQueryReadyWaiter
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
    if (rawId === 'default') return rawId;

    const resolvedId = await this.resolveWorkspace(rawId);
    if (!resolvedId) {
      throw new Error(
        `Workspace "${rawId}" not found. Call loadWorkspace or createWorkspace first to get a valid workspaceId.`
      );
    }
    return resolvedId;
  }

  private notifyTaskBoard(event: TaskBoardEventPayload): void {
    this.taskBoardNotifier?.notify(event);
  }

  private async ensureQueryReady(): Promise<void> {
    if (!this.waitForQueryReady) return;

    const ready = await this.waitForQueryReady();
    if (!ready) {
      throw new Error('Task storage is not ready yet');
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Projects
  // ────────────────────────────────────────────────────────────────

  async createProject(workspaceId: string, data: CreateProjectData): Promise<string> {
    await this.ensureQueryReady();

    // Resolve workspace name → UUID transparently
    workspaceId = await this.resolveWorkspaceId(workspaceId);

    // Check for duplicate name in workspace
    const existing = await this.projectRepo.getByName(workspaceId, data.name);
    if (existing) {
      throw new Error(`Project "${data.name}" already exists in this workspace`);
    }

    const projectId = await this.projectRepo.create({
      name: data.name,
      description: data.description,
      workspaceId,
      metadata: data.metadata
    });

    this.notifyTaskBoard({
      workspaceId,
      entity: 'project',
      action: 'created',
      projectId
    });

    return projectId;
  }

  async listProjects(workspaceId: string, options?: ProjectListOptions): Promise<PaginatedResult<ProjectMetadata>> {
    await this.ensureQueryReady();

    workspaceId = await this.resolveWorkspaceId(workspaceId);
    return this.projectRepo.getByWorkspace(workspaceId, {
      page: options?.page,
      pageSize: options?.pageSize,
      status: options?.status
    });
  }

  async updateProject(projectId: string, data: UpdateProjectData): Promise<void> {
    await this.ensureQueryReady();

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

    this.notifyTaskBoard({
      workspaceId: project.workspaceId,
      entity: 'project',
      action: 'updated',
      projectId
    });
  }

  async archiveProject(projectId: string): Promise<void> {
    await this.ensureQueryReady();

    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    await this.projectRepo.update(projectId, {
      status: 'archived',
      updated: Date.now()
    });

    this.notifyTaskBoard({
      workspaceId: project.workspaceId,
      entity: 'project',
      action: 'archived',
      projectId
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.ensureQueryReady();

    const project = await this.projectRepo.getById(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found`);
    }

    await this.projectRepo.delete(projectId);

    this.notifyTaskBoard({
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
    await this.ensureQueryReady();

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

    // Create initial note links. Each item is either a plain string (vault path,
    // linkType defaults to "reference") or an object { notePath, linkType? }.
    // Normalize to { notePath, linkType } first so the link-creation loop has a
    // single shape.
    if (data.linkedNotes && data.linkedNotes.length > 0) {
      for (const link of data.linkedNotes.map(normalizeLinkedNote)) {
        await this.taskRepo.addNoteLink(taskId, link.notePath, link.linkType);
      }
    }

    this.notifyTaskBoard({
      workspaceId: project.workspaceId,
      entity: 'task',
      action: 'created',
      taskId,
      projectId
    });

    return taskId;
  }

  async listTasks(projectId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskWithNoteLinks>> {
    await this.ensureQueryReady();

    const result = await this.taskRepo.getByProject(projectId, {
      page: options?.page,
      pageSize: options?.pageSize,
      status: options?.status,
      priority: options?.priority,
      assignee: options?.assignee,
      parentTaskId: options?.parentTaskId,
      sortBy: options?.sortBy,
      sortOrder: options?.sortOrder
    });

    return {
      ...result,
      items: await this.attachNoteLinks(result.items)
    };
  }

  async listWorkspaceTasks(workspaceId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>> {
    await this.ensureQueryReady();

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
    await this.ensureQueryReady();

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

    this.notifyTaskBoard({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'updated',
      taskId,
      projectId: task.projectId
    });
  }

  async moveTask(taskId: string, target: { projectId?: string; parentTaskId?: string | null }): Promise<void> {
    await this.ensureQueryReady();

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

    this.notifyTaskBoard({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'moved',
      taskId,
      projectId: (updateData.projectId) || task.projectId
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.ensureQueryReady();

    const task = await this.taskRepo.getById(taskId);
    if (!task) {
      throw new Error(`Task "${taskId}" not found`);
    }

    await this.taskRepo.delete(taskId);

    this.notifyTaskBoard({
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
    await this.ensureQueryReady();

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
    await this.ensureQueryReady();

    await this.taskRepo.removeDependency(taskId, dependsOnTaskId);
  }

  // ────────────────────────────────────────────────────────────────
  // DAG Queries
  // ────────────────────────────────────────────────────────────────

  async getNextActions(projectId: string): Promise<TaskWithNoteLinks[]> {
    await this.ensureQueryReady();

    const allTasks = await this.taskRepo.getByProject(projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(projectId);

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const readyNodes = this.dagService.getNextActions(nodes, allEdges);
    const readyIds = new Set(readyNodes.map(n => n.id));

    // Sort by priority then creation date
    const priorityOrder: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };
    const ready = allTasks.items
      .filter(t => readyIds.has(t.id))
      .sort((a, b) => {
        const pDiff = (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3);
        return pDiff !== 0 ? pDiff : a.created - b.created;
      });

    return this.attachNoteLinks(ready);
  }

  async getBlockedTasks(projectId: string): Promise<TaskWithBlockers[]> {
    await this.ensureQueryReady();

    const allTasks = await this.taskRepo.getByProject(projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(projectId);

    const taskMap = new Map<string, TaskMetadata>();
    for (const t of allTasks.items) {
      taskMap.set(t.id, t);
    }

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const blockedNodes = this.dagService.getBlockedTasks(nodes, allEdges);
    const blockedIds = new Set(blockedNodes.map(n => n.id));

    // First pass: build the result from raw tasks, recording which task IDs actually
    // land in the response (blocked tasks ∪ their active blockers). We then enrich ONLY
    // that subset with note links, rather than every task in the project — getNoteLinks
    // is one query per task, so enriching all project tasks here would be O(all-tasks)
    // even when only a handful are returned.
    const rawResult: TaskWithBlockers[] = [];
    const returnedIds = new Set<string>();
    for (const task of allTasks.items) {
      if (!blockedIds.has(task.id)) continue;

      // Find which dependencies are blocking
      const blockers: TaskWithNoteLinks[] = [];
      for (const edge of allEdges) {
        if (edge.taskId !== task.id) continue;
        const depTask = taskMap.get(edge.dependsOnTaskId);
        if (depTask && depTask.status !== 'done' && depTask.status !== 'cancelled') {
          returnedIds.add(depTask.id);
          // Cast: placeholder until enrichment below replaces this with the enriched task.
          blockers.push(depTask as TaskWithNoteLinks);
        }
      }
      returnedIds.add(task.id);
      rawResult.push({ task: task as TaskWithNoteLinks, blockedBy: blockers });
    }

    // Enrich only the tasks that appear in the result, then swap placeholders for the
    // enriched versions via a lookup (keeps the enrich-once dedup — each returned task
    // is fetched at most once).
    const enriched = await this.attachNoteLinks(
      allTasks.items.filter(t => returnedIds.has(t.id))
    );
    const enrichedById = new Map<string, TaskWithNoteLinks>();
    for (const t of enriched) {
      enrichedById.set(t.id, t);
    }

    return rawResult.map(entry => ({
      task: enrichedById.get(entry.task.id) ?? { ...entry.task, noteLinks: [] },
      blockedBy: entry.blockedBy.map(b => enrichedById.get(b.id) ?? { ...b, noteLinks: [] })
    }));
  }

  async getDependencyTree(taskId: string): Promise<DependencyTree> {
    await this.ensureQueryReady();

    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    const allTasks = await this.taskRepo.getByProject(task.projectId, { pageSize: 10000 });
    const allEdges = await this.taskRepo.getAllDependencyEdges(task.projectId);

    const nodes: TaskNode[] = allTasks.items.map(t => ({ id: t.id, status: t.status }));
    const { dependencies, dependents } = this.dagService.getDependencyTree(taskId, nodes, allEdges);

    // Enrich ONLY the tasks that appear in the tree (root ∪ dependencies ∪ dependents),
    // not every task in the project. getNoteLinks is one query per task, so enriching all
    // project tasks would be O(all-tasks) even when the tree is small. The root may not
    // appear in getByProject results (e.g. cross-project edge cases), so include it
    // explicitly to guarantee it carries note links.
    const treeIds = new Set<string>([task.id, ...dependencies, ...dependents]);
    const tasksById = new Map<string, TaskMetadata>();
    for (const t of allTasks.items) {
      tasksById.set(t.id, t);
    }
    const tasksToEnrich: TaskMetadata[] = [task];
    for (const id of treeIds) {
      if (id === task.id) continue;
      const t = tasksById.get(id);
      if (t) tasksToEnrich.push(t);
    }

    const enriched = await this.attachNoteLinks(tasksToEnrich);
    const enrichedById = new Map<string, TaskWithNoteLinks>();
    for (const t of enriched) {
      enrichedById.set(t.id, t);
    }

    const mapTaskIds = (taskIds: string[]): DependencyTree[] =>
      taskIds.reduce<DependencyTree[]>((acc, relatedTaskId) => {
        const relatedTask = enrichedById.get(relatedTaskId);
        if (relatedTask) {
          acc.push({ task: relatedTask, dependencies: [], dependents: [] });
        }
        return acc;
      }, []);

    return {
      task: enrichedById.get(task.id) ?? { ...task, noteLinks: [] },
      dependencies: mapTaskIds(dependencies),
      dependents: mapTaskIds(dependents)
    };
  }

  // ────────────────────────────────────────────────────────────────
  // Note Links
  // ────────────────────────────────────────────────────────────────

  async linkNote(taskId: string, notePath: string, linkType: LinkType): Promise<void> {
    await this.ensureQueryReady();

    const task = await this.taskRepo.getById(taskId);
    if (!task) throw new Error(`Task "${taskId}" not found`);

    await this.taskRepo.addNoteLink(taskId, notePath, linkType);

    this.notifyTaskBoard({
      workspaceId: task.workspaceId,
      entity: 'task',
      action: 'updated',
      taskId,
      projectId: task.projectId
    });
  }

  async unlinkNote(taskId: string, notePath: string): Promise<void> {
    await this.ensureQueryReady();

    const task = await this.taskRepo.getById(taskId);
    await this.taskRepo.removeNoteLink(taskId, notePath);

    if (task) {
      this.notifyTaskBoard({
        workspaceId: task.workspaceId,
        entity: 'task',
        action: 'updated',
        taskId,
        projectId: task.projectId
      });
    }
  }

  async getNoteLinks(taskId: string): Promise<NoteLink[]> {
    await this.ensureQueryReady();

    return this.taskRepo.getNoteLinks(taskId);
  }

  /**
   * Enrich a batch of tasks with their linked-note metadata for AI-facing read surfaces.
   *
   * Note links live in a separate table from tasks, so they must be joined per task.
   * Fetches are parallelized with Promise.all (no batch repo method exists) and each
   * task's lookup falls back to an empty array on failure so one bad task never sinks
   * the whole read. Mirrors the UI enrichment in TaskBoardDataController.
   *
   * N+1 note: this issues one getNoteLinks call per task. Parallelization keeps it to a
   * single await; an aggregate repo method (e.g. getNoteLinksForTasks) would reduce the
   * round-trip count if list sizes grow — documented as acceptable for current scale.
   */
  private async attachNoteLinks(tasks: TaskMetadata[]): Promise<TaskWithNoteLinks[]> {
    const linkArrays = await Promise.all(
      tasks.map(task =>
        this.getNoteLinks(task.id).catch((error) => {
          // Degrade to [] so one bad task never sinks the whole read, but route the
          // failure through the observability seam so a persistent getNoteLinks failure
          // is distinguishable from a task that genuinely has no links. systemWarn is the
          // project's centralized warn-level seam (muted by default; flipping warn on
          // emits everywhere) — so this is latent until warn-level logging is enabled.
          logger.systemWarn(
            `getNoteLinks failed for task ${task.id}; returning empty noteLinks: ${error instanceof Error ? error.message : String(error)}`,
            'TaskService.attachNoteLinks'
          );
          return [] as NoteLink[];
        })
      )
    );

    return tasks.map((task, index) => ({
      ...task,
      noteLinks: linkArrays[index].map((link): TaskNoteLink => ({
        notePath: link.notePath,
        linkType: link.linkType
      }))
    }));
  }

  async getTasksForNote(notePath: string): Promise<TaskMetadata[]> {
    await this.ensureQueryReady();

    return this.taskRepo.getByLinkedNote(notePath);
  }

  // ────────────────────────────────────────────────────────────────
  // Workspace Summary (for loadWorkspace integration)
  // ────────────────────────────────────────────────────────────────

  async getWorkspaceSummary(workspaceId: string): Promise<WorkspaceTaskSummary> {
    await this.ensureQueryReady();

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

    // Enrich only the two short lists surfaced to the AI (max 5 each) with note links —
    // enriching the entire workspace task set would be wasteful since the summary only
    // returns these slices.
    const [nextActionsWithLinks, completedWithLinks] = await Promise.all([
      this.attachNoteLinks(topNextActions),
      this.attachNoteLinks(completed)
    ]);

    return {
      projects: {
        total: projects.totalItems,
        active: projectItems.filter(p => p.status === 'active').length,
        items: projectItems
      },
      tasks: {
        total: allTasks.totalItems,
        byStatus,
        overdue,
        nextActions: nextActionsWithLinks,
        recentlyCompleted: completedWithLinks
      }
    };
  }
}
