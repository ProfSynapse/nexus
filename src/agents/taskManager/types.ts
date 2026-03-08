/**
 * Location: src/agents/taskManager/types.ts
 * Purpose: Type definitions for the TaskManager agent — data model, DTOs, and tool parameter/result types.
 *
 * Used by: DAGService, TaskService, all TaskManager tools, loadWorkspace integration
 */

import { CommonParameters, CommonResult } from '../../types';

// ────────────────────────────────────────────────────────────────
// Enums / Literal Unions
// ────────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'completed' | 'archived';
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type LinkType = 'reference' | 'output' | 'input';

// ────────────────────────────────────────────────────────────────
// Core Entities
// ────────────────────────────────────────────────────────────────

export interface ProjectMetadata {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: ProjectStatus;
  created: number;
  updated: number;
  metadata?: Record<string, unknown>;
}

export interface TaskMetadata {
  id: string;
  projectId: string;
  workspaceId: string;
  parentTaskId?: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  created: number;
  updated: number;
  completedAt?: number;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// DAG Types
// ────────────────────────────────────────────────────────────────

export interface Edge {
  taskId: string;
  dependsOnTaskId: string;
}

export interface TaskNode {
  id: string;
  status: TaskStatus;
}

export interface DependencyTree {
  task: TaskMetadata;
  dependencies: DependencyTree[];
  dependents: DependencyTree[];
}

export interface TaskWithBlockers {
  task: TaskMetadata;
  blockedBy: TaskMetadata[];
}

// ────────────────────────────────────────────────────────────────
// Note Links
// ────────────────────────────────────────────────────────────────

export interface NoteLink {
  taskId: string;
  notePath: string;
  linkType: LinkType;
  created: number;
}

// ────────────────────────────────────────────────────────────────
// CRUD DTOs
// ────────────────────────────────────────────────────────────────

export interface CreateProjectData {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateProjectData {
  name?: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
}

export interface CreateTaskData {
  title: string;
  description?: string;
  parentTaskId?: string;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  dependsOn?: string[];
  linkedNotes?: string[];
  metadata?: Record<string, unknown>;
}

export interface UpdateTaskData {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────
// Query Options
// ────────────────────────────────────────────────────────────────

export interface TaskListOptions {
  page?: number;
  pageSize?: number;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
}

export interface ProjectListOptions {
  page?: number;
  pageSize?: number;
  status?: ProjectStatus;
}

// ────────────────────────────────────────────────────────────────
// Workspace Summary (for loadWorkspace integration)
// ────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  taskCount: number;
  status: ProjectStatus;
}

export interface WorkspaceTaskSummary {
  projects: {
    total: number;
    active: number;
    items: ProjectSummary[];
  };
  tasks: {
    total: number;
    byStatus: Record<TaskStatus, number>;
    overdue: number;
    nextActions: TaskMetadata[];
    recentlyCompleted: TaskMetadata[];
  };
}

// ────────────────────────────────────────────────────────────────
// Tool Parameter Types
// ────────────────────────────────────────────────────────────────

export interface CreateProjectParameters extends CommonParameters {
  workspaceId: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface ListProjectsParameters extends CommonParameters {
  workspaceId: string;
  status?: ProjectStatus;
  page?: number;
  pageSize?: number;
}

export interface UpdateProjectParameters extends CommonParameters {
  projectId: string;
  name?: string;
  description?: string;
  status?: ProjectStatus;
  metadata?: Record<string, unknown>;
}

export interface ArchiveProjectParameters extends CommonParameters {
  projectId: string;
}

export interface CreateTaskParameters extends CommonParameters {
  projectId: string;
  title: string;
  description?: string;
  parentTaskId?: string;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  dependsOn?: string[];
  linkedNotes?: string[];
  metadata?: Record<string, unknown>;
}

export interface ListTasksParameters extends CommonParameters {
  projectId: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
  page?: number;
  pageSize?: number;
}

export interface UpdateTaskParameters extends CommonParameters {
  taskId: string;
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  addDependencies?: string[];
  removeDependencies?: string[];
  metadata?: Record<string, unknown>;
}

export interface MoveTaskParameters extends CommonParameters {
  taskId: string;
  projectId?: string;
  parentTaskId?: string | null;
}

export interface QueryTasksParameters extends CommonParameters {
  projectId: string;
  query: 'nextActions' | 'blockedTasks' | 'dependencyTree';
  taskId?: string;
}

export interface LinkNoteParameters extends CommonParameters {
  taskId: string;
  notePath: string;
  linkType?: LinkType;
  action?: 'link' | 'unlink';
}

// ────────────────────────────────────────────────────────────────
// Tool Result Types
// ────────────────────────────────────────────────────────────────

export interface CreateProjectResult extends CommonResult {
  projectId?: string;
}

export interface ListProjectsResult extends CommonResult {
  projects?: ProjectMetadata[];
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}

export interface UpdateProjectResult extends CommonResult {}

export interface ArchiveProjectResult extends CommonResult {}

export interface CreateTaskResult extends CommonResult {
  taskId?: string;
}

export interface ListTasksResult extends CommonResult {
  tasks?: TaskMetadata[];
  pagination?: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
    hasNextPage: boolean;
  };
}

export interface UpdateTaskResult extends CommonResult {}

export interface MoveTaskResult extends CommonResult {}

export interface QueryTasksResult extends CommonResult {
  query?: string;
  tasks?: TaskMetadata[];
  tree?: DependencyTree;
  blockedTasks?: TaskWithBlockers[];
}

export interface LinkNoteResult extends CommonResult {}

// ────────────────────────────────────────────────────────────────
// Service Interfaces
// ────────────────────────────────────────────────────────────────

export interface IDAGService {
  validateNoCycle(taskId: string, dependsOnTaskId: string, allEdges: Edge[]): boolean;
  topologicalSort(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getNextActions(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getBlockedTasks(tasks: TaskNode[], edges: Edge[]): TaskNode[];
  getDependencyTree(rootTaskId: string, tasks: TaskNode[], edges: Edge[]): { dependencies: string[]; dependents: string[] };
}
