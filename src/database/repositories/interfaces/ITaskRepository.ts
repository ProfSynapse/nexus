/**
 * Location: src/database/repositories/interfaces/ITaskRepository.ts
 *
 * Task Repository Interface
 *
 * Defines task-specific operations beyond basic CRUD, including
 * DAG dependency queries, subtask hierarchy, and note links.
 *
 * Related Files:
 * - src/database/repositories/TaskRepository.ts - Implementation
 * - src/database/repositories/interfaces/IRepository.ts - Base interface
 */

import { IRepository } from './IRepository';
import { PaginatedResult, PaginationParams } from '../../../types/pagination/PaginationTypes';

/**
 * Task status values. Note: 'blocked' is derived, not stored.
 */
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';

/**
 * Task priority levels
 */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

/**
 * Note link relationship type
 */
export type LinkType = 'reference' | 'output' | 'input';

/**
 * Task metadata as stored in SQLite
 */
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

/**
 * Data required to create a new task
 */
export interface CreateTaskData {
  projectId: string;
  workspaceId: string;
  title: string;
  description?: string;
  parentTaskId?: string;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/**
 * Data for updating an existing task
 */
export interface UpdateTaskData {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: number;
  assignee?: string;
  tags?: string[];
  projectId?: string;
  parentTaskId?: string | null;
  completedAt?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Note link record
 */
export interface NoteLink {
  taskId: string;
  notePath: string;
  linkType: LinkType;
  created: number;
}

/**
 * Options for filtering task lists
 */
export interface TaskListOptions extends PaginationParams {
  status?: TaskStatus;
  priority?: TaskPriority;
  assignee?: string;
  parentTaskId?: string;
  includeSubtasks?: boolean;
}

/**
 * Task repository interface
 */
export interface ITaskRepository extends IRepository<TaskMetadata> {
  /**
   * Get tasks for a project with optional filtering/pagination
   */
  getByProject(projectId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>>;

  /**
   * Get tasks for a workspace with optional filtering/pagination
   */
  getByWorkspace(workspaceId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>>;

  /**
   * Get tasks with a specific status in a project
   */
  getByStatus(projectId: string, status: TaskStatus): Promise<TaskMetadata[]>;

  /**
   * Get tasks that this task depends ON (upstream dependencies)
   */
  getDependencies(taskId: string): Promise<TaskMetadata[]>;

  /**
   * Get tasks that depend ON this task (downstream dependents)
   */
  getDependents(taskId: string): Promise<TaskMetadata[]>;

  /**
   * Get direct child tasks (subtasks)
   */
  getChildren(taskId: string): Promise<TaskMetadata[]>;

  /**
   * Get tasks that are ready to work on (all deps complete)
   */
  getReadyTasks(projectId: string): Promise<TaskMetadata[]>;

  /**
   * Add a dependency edge (taskId depends on dependsOnTaskId)
   */
  addDependency(taskId: string, dependsOnTaskId: string): Promise<void>;

  /**
   * Remove a dependency edge
   */
  removeDependency(taskId: string, dependsOnTaskId: string): Promise<void>;

  /**
   * Get all note links for a task
   */
  getNoteLinks(taskId: string): Promise<NoteLink[]>;

  /**
   * Get tasks linked to a specific note
   */
  getByLinkedNote(notePath: string): Promise<TaskMetadata[]>;

  /**
   * Link a note to a task
   */
  addNoteLink(taskId: string, notePath: string, linkType: LinkType): Promise<void>;

  /**
   * Unlink a note from a task
   */
  removeNoteLink(taskId: string, notePath: string): Promise<void>;

  /**
   * Get all dependency edges for a project (for DAGService)
   */
  getAllDependencyEdges(projectId: string): Promise<{ taskId: string; dependsOnTaskId: string }[]>;
}
