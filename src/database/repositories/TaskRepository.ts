/**
 * Location: src/database/repositories/TaskRepository.ts
 *
 * Task Repository Implementation
 *
 * Manages task entities with JSONL persistence and SQLite caching.
 * Includes DAG dependency management, subtask hierarchy, and note linking.
 * Tasks share a per-workspace JSONL file: .nexus/tasks/tasks_[workspaceId].jsonl
 *
 * Design Principles:
 * - Single Responsibility: Handles task CRUD, dependencies, and note links
 * - Hybrid Storage: JSONL source of truth + SQLite cache for queries
 * - Cache Invalidation: Automatic cache clearing after mutations
 * - Event Sourcing: All changes recorded as immutable events
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/ITaskRepository.ts - Interface
 * - src/database/repositories/ProjectRepository.ts - Sibling repository
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import { DatabaseRow, QueryParams } from './base/BaseRepository';
import {
  ITaskRepository,
  TaskMetadata,
  CreateTaskData,
  UpdateTaskData,
  NoteLink,
  LinkType,
  TaskStatus,
  TaskListOptions,
  TaskSortField
} from './interfaces/ITaskRepository';
import {
  TaskCreatedEvent,
  TaskUpdatedEvent,
  TaskDeletedEvent,
  TaskDependencyAddedEvent,
  TaskDependencyRemovedEvent,
  TaskNoteLinkedEvent,
  TaskNoteUnlinkedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';

interface TaskRow extends DatabaseRow {
  id: string;
  projectId: string;
  workspaceId: string;
  parentTaskId?: string | null;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskMetadata['priority'];
  created: number;
  updated: number;
  completedAt?: number | null;
  dueDate?: number | null;
  assignee?: string | null;
  tagsJson?: string | null;
  metadataJson?: string | null;
}

interface TaskDependencyRow extends DatabaseRow {
  taskId: string;
  dependsOnTaskId: string;
}

/**
 * Repository for task entities
 */
export class TaskRepository
  extends BaseRepository<TaskMetadata>
  implements ITaskRepository {

  protected readonly tableName = 'tasks';
  protected readonly entityType = 'task';

  protected jsonlPath(workspaceId: string): string {
    return `tasks/tasks_${workspaceId}.jsonl`;
  }

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<TaskMetadata | null> {
    return this.getCachedOrFetch(
      `task:get:${id}`,
      async () => {
        const row = await this.sqliteCache.queryOne<TaskRow>(
          'SELECT * FROM tasks WHERE id = ?',
          [id]
        );
        return row ? this.rowToEntity(row) : null;
      }
    );
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<TaskMetadata>> {
    const baseQuery = 'SELECT * FROM tasks ORDER BY updated DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM tasks';

    const result = await this.queryPaginated<TaskRow>(baseQuery, countQuery, options);
    return {
      ...result,
      items: result.items.map(row => this.rowToEntity(row))
    };
  }

  async create(data: CreateTaskData): Promise<string> {
    const id = this.generateId();
    const now = Date.now();
    const tagsJson = data.tags ? JSON.stringify(data.tags) : null;
    const metadataJson = data.metadata ? JSON.stringify(data.metadata) : null;

    try {
      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskCreatedEvent>(
          this.jsonlPath(data.workspaceId),
          {
            type: 'task_created',
            data: {
              id,
              projectId: data.projectId,
              workspaceId: data.workspaceId,
              parentTaskId: data.parentTaskId,
              title: data.title,
              description: data.description,
              status: 'todo',
              priority: data.priority ?? 'medium',
              created: now,
              updated: now,
              dueDate: data.dueDate,
              assignee: data.assignee,
              tagsJson: tagsJson ?? undefined,
              metadataJson: metadataJson ?? undefined
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO tasks (id, projectId, workspaceId, parentTaskId, title, description, status, priority, created, updated, dueDate, assignee, tagsJson, metadataJson)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            data.projectId,
            data.workspaceId,
            data.parentTaskId ?? null,
            data.title,
            data.description ?? null,
            'todo',
            data.priority ?? 'medium',
            now,
            now,
            data.dueDate ?? null,
            data.assignee ?? null,
            tagsJson,
            metadataJson
          ]
        );
      });

      // 3. Invalidate cache
      this.invalidateCache();
      this.log('create', { id, title: data.title });

      return id;
    } catch (error) {
      this.logError('create', error);
      throw error;
    }
  }

  async update(id: string, data: UpdateTaskData): Promise<void> {
    const now = Date.now();

    try {
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Task not found: ${id}`);
      }

      await this.transaction(async () => {
        // 1. Build event data
        const eventData: Record<string, unknown> = { updated: now };
        if (data.title !== undefined) eventData.title = data.title;
        if (data.description !== undefined) eventData.description = data.description;
        if (data.status !== undefined) eventData.status = data.status;
        if (data.priority !== undefined) eventData.priority = data.priority;
        if (data.dueDate !== undefined) eventData.dueDate = data.dueDate;
        if (data.assignee !== undefined) eventData.assignee = data.assignee;
        if (data.tags !== undefined) eventData.tagsJson = JSON.stringify(data.tags);
        if (data.projectId !== undefined) eventData.projectId = data.projectId;
        if (data.parentTaskId !== undefined) eventData.parentTaskId = data.parentTaskId;
        if (data.completedAt !== undefined) eventData.completedAt = data.completedAt;
        if (data.metadata !== undefined) eventData.metadataJson = JSON.stringify(data.metadata);

        await this.writeEvent<TaskUpdatedEvent>(
          this.jsonlPath(existing.workspaceId),
          {
            type: 'task_updated',
            taskId: id,
            data: eventData as TaskUpdatedEvent['data']
          }
        );

        // 2. Update SQLite cache
        const setClauses: string[] = ['updated = ?'];
        const params: QueryParams = [now];

        if (data.title !== undefined) { setClauses.push('title = ?'); params.push(data.title); }
        if (data.description !== undefined) { setClauses.push('description = ?'); params.push(data.description); }
        if (data.status !== undefined) { setClauses.push('status = ?'); params.push(data.status); }
        if (data.priority !== undefined) { setClauses.push('priority = ?'); params.push(data.priority); }
        if (data.dueDate !== undefined) { setClauses.push('dueDate = ?'); params.push(data.dueDate); }
        if (data.assignee !== undefined) { setClauses.push('assignee = ?'); params.push(data.assignee); }
        if (data.tags !== undefined) { setClauses.push('tagsJson = ?'); params.push(JSON.stringify(data.tags)); }
        if (data.projectId !== undefined) { setClauses.push('projectId = ?'); params.push(data.projectId); }
        if (data.parentTaskId !== undefined) { setClauses.push('parentTaskId = ?'); params.push(data.parentTaskId); }
        if (data.completedAt !== undefined) { setClauses.push('completedAt = ?'); params.push(data.completedAt); }
        if (data.metadata !== undefined) { setClauses.push('metadataJson = ?'); params.push(JSON.stringify(data.metadata)); }

        params.push(id);

        await this.sqliteCache.run(
          `UPDATE tasks SET ${setClauses.join(', ')} WHERE id = ?`,
          params
        );
      });

      // 3. Invalidate cache
      this.invalidateCache(id);
      this.log('update', { id });
    } catch (error) {
      this.logError('update', error);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Task not found: ${id}`);
      }

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskDeletedEvent>(
          this.jsonlPath(existing.workspaceId),
          {
            type: 'task_deleted',
            taskId: id
          }
        );

        // 2. Delete from SQLite (cascades: deps + note links removed, children parentTaskId set null)
        await this.sqliteCache.run('DELETE FROM tasks WHERE id = ?', [id]);
      });

      // 3. Invalidate cache
      this.invalidateCache();
      this.log('delete', { id });
    } catch (error) {
      this.logError('delete', error);
      throw error;
    }
  }

  async count(criteria?: Record<string, unknown>): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM tasks';
    const params: QueryParams = [];

    if (criteria) {
      const conditions: string[] = [];
      if (typeof criteria.projectId === 'string') { conditions.push('projectId = ?'); params.push(criteria.projectId); }
      if (typeof criteria.workspaceId === 'string') { conditions.push('workspaceId = ?'); params.push(criteria.workspaceId); }
      if (typeof criteria.status === 'string') { conditions.push('status = ?'); params.push(criteria.status); }
      if (typeof criteria.priority === 'string') { conditions.push('priority = ?'); params.push(criteria.priority); }
      if (typeof criteria.assignee === 'string') { conditions.push('assignee = ?'); params.push(criteria.assignee); }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  // ============================================================================
  // ITaskRepository Specific Methods
  // ============================================================================

  /**
   * Build a safe ORDER BY clause from whitelist sort fields.
   * Defaults to `t.updated DESC` if no valid sortBy is provided.
   */
  private buildOrderClause(options?: TaskListOptions): string {
    const SORT_COLUMN_MAP: Record<TaskSortField, string> = {
      created: 't.created',
      updated: 't.updated',
      priority: "CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END",
      title: 't.title',
      dueDate: 't.dueDate'
    };

    const sortField = options?.sortBy && SORT_COLUMN_MAP[options.sortBy]
      ? options.sortBy
      : 'updated';
    const sortDirection = options?.sortOrder === 'asc' ? 'ASC' : 'DESC';
    return `ORDER BY ${SORT_COLUMN_MAP[sortField]} ${sortDirection}`;
  }

  async getByProject(projectId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>> {
    let whereClause = 'WHERE t.projectId = ?';
    const params: QueryParams = [projectId];

    if (options?.status) { whereClause += ' AND t.status = ?'; params.push(options.status); }
    if (options?.priority) { whereClause += ' AND t.priority = ?'; params.push(options.priority); }
    if (options?.assignee) { whereClause += ' AND t.assignee = ?'; params.push(options.assignee); }
    if (options?.parentTaskId) { whereClause += ' AND t.parentTaskId = ?'; params.push(options.parentTaskId); }
    if (options?.includeSubtasks === false) { whereClause += ' AND t.parentTaskId IS NULL'; }

    const orderClause = this.buildOrderClause(options);
    const baseQuery = `SELECT t.* FROM tasks t ${whereClause} ${orderClause}`;
    const countQuery = `SELECT COUNT(*) as count FROM tasks t ${whereClause}`;

    const result = await this.queryPaginated<TaskRow>(baseQuery, countQuery, options, params);
    return {
      ...result,
      items: result.items.map(row => this.rowToEntity(row))
    };
  }

  async getByWorkspace(workspaceId: string, options?: TaskListOptions): Promise<PaginatedResult<TaskMetadata>> {
    let whereClause = 'WHERE t.workspaceId = ?';
    const params: QueryParams = [workspaceId];

    if (options?.status) { whereClause += ' AND t.status = ?'; params.push(options.status); }
    if (options?.priority) { whereClause += ' AND t.priority = ?'; params.push(options.priority); }
    if (options?.assignee) { whereClause += ' AND t.assignee = ?'; params.push(options.assignee); }

    const orderClause = this.buildOrderClause(options);
    const baseQuery = `SELECT t.* FROM tasks t ${whereClause} ${orderClause}`;
    const countQuery = `SELECT COUNT(*) as count FROM tasks t ${whereClause}`;

    const result = await this.queryPaginated<TaskRow>(baseQuery, countQuery, options, params);
    return {
      ...result,
      items: result.items.map(row => this.rowToEntity(row))
    };
  }

  async getByStatus(projectId: string, status: TaskStatus): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      'SELECT * FROM tasks WHERE projectId = ? AND status = ? ORDER BY updated DESC LIMIT 500',
      [projectId, status]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async getDependencies(taskId: string): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_dependencies td ON td.dependsOnTaskId = t.id
       WHERE td.taskId = ?
       LIMIT 500`,
      [taskId]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async getDependents(taskId: string): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      `SELECT t.* FROM tasks t
       JOIN task_dependencies td ON td.taskId = t.id
       WHERE td.dependsOnTaskId = ?
       LIMIT 500`,
      [taskId]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async getChildren(taskId: string): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      'SELECT * FROM tasks WHERE parentTaskId = ? ORDER BY created ASC LIMIT 500',
      [taskId]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async getReadyTasks(projectId: string): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.projectId = ? AND t.status = 'todo'
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON dep.id = td.dependsOnTaskId
           WHERE td.taskId = t.id AND dep.status NOT IN ('done', 'cancelled')
         )
       ORDER BY
         CASE t.priority
           WHEN 'critical' THEN 1
           WHEN 'high' THEN 2
           WHEN 'medium' THEN 3
           WHEN 'low' THEN 4
         END,
         t.created ASC
       LIMIT 500`,
      [projectId]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    try {
      const task = await this.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const now = Date.now();

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskDependencyAddedEvent>(
          this.jsonlPath(task.workspaceId),
          {
            type: 'task_dependency_added',
            taskId,
            dependsOnTaskId
          }
        );

        // 2. Insert into SQLite
        await this.sqliteCache.run(
          'INSERT OR IGNORE INTO task_dependencies (taskId, dependsOnTaskId, created) VALUES (?, ?, ?)',
          [taskId, dependsOnTaskId, now]
        );
      });

      this.invalidateCache();
      this.log('addDependency', { taskId, dependsOnTaskId });
    } catch (error) {
      this.logError('addDependency', error);
      throw error;
    }
  }

  async removeDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    try {
      const task = await this.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskDependencyRemovedEvent>(
          this.jsonlPath(task.workspaceId),
          {
            type: 'task_dependency_removed',
            taskId,
            dependsOnTaskId
          }
        );

        // 2. Remove from SQLite
        await this.sqliteCache.run(
          'DELETE FROM task_dependencies WHERE taskId = ? AND dependsOnTaskId = ?',
          [taskId, dependsOnTaskId]
        );
      });

      this.invalidateCache();
      this.log('removeDependency', { taskId, dependsOnTaskId });
    } catch (error) {
      this.logError('removeDependency', error);
      throw error;
    }
  }

  async getNoteLinks(taskId: string): Promise<NoteLink[]> {
    const rows = await this.sqliteCache.query<TaskRow>(
      'SELECT * FROM task_note_links WHERE taskId = ?',
      [taskId]
    );
    return rows.map(row => ({
      taskId: row.taskId as string,
      notePath: row.notePath as string,
      linkType: row.linkType as LinkType,
      created: row.created
    }));
  }

  async getByLinkedNote(notePath: string): Promise<TaskMetadata[]> {
    const rows = await this.sqliteCache.query<TaskDependencyRow>(
      `SELECT t.* FROM tasks t
       JOIN task_note_links tnl ON tnl.taskId = t.id
       WHERE tnl.notePath = ?
       LIMIT 500`,
      [notePath]
    );
    return rows.map(row => this.rowToEntity(row));
  }

  async addNoteLink(taskId: string, notePath: string, linkType: LinkType): Promise<void> {
    try {
      const task = await this.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const now = Date.now();

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskNoteLinkedEvent>(
          this.jsonlPath(task.workspaceId),
          {
            type: 'task_note_linked',
            taskId,
            notePath,
            linkType
          }
        );

        // 2. Insert into SQLite
        await this.sqliteCache.run(
          'INSERT OR IGNORE INTO task_note_links (taskId, notePath, linkType, created) VALUES (?, ?, ?, ?)',
          [taskId, notePath, linkType, now]
        );
      });

      this.invalidateCache(taskId);
      this.log('addNoteLink', { taskId, notePath, linkType });
    } catch (error) {
      this.logError('addNoteLink', error);
      throw error;
    }
  }

  async removeNoteLink(taskId: string, notePath: string): Promise<void> {
    try {
      const task = await this.getById(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<TaskNoteUnlinkedEvent>(
          this.jsonlPath(task.workspaceId),
          {
            type: 'task_note_unlinked',
            taskId,
            notePath
          }
        );

        // 2. Remove from SQLite
        await this.sqliteCache.run(
          'DELETE FROM task_note_links WHERE taskId = ? AND notePath = ?',
          [taskId, notePath]
        );
      });

      this.invalidateCache(taskId);
      this.log('removeNoteLink', { taskId, notePath });
    } catch (error) {
      this.logError('removeNoteLink', error);
      throw error;
    }
  }

  async getAllDependencyEdges(projectId: string): Promise<{ taskId: string; dependsOnTaskId: string }[]> {
    const rows = await this.sqliteCache.query<TaskDependencyRow>(
      `SELECT td.taskId, td.dependsOnTaskId
       FROM task_dependencies td
       JOIN tasks t ON t.id = td.taskId
       WHERE t.projectId = ?
       LIMIT 500`,
      [projectId]
    );
    return rows.map(row => ({
      taskId: row.taskId,
      dependsOnTaskId: row.dependsOnTaskId
    }));
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: DatabaseRow): TaskMetadata {
    const taskRow = row as TaskRow;
    let tags: string[] | undefined;
    if (taskRow.tagsJson) {
      try {
        tags = this.parseJsonValue<string[]>(taskRow.tagsJson);
      } catch {
        // Skip unparseable tags
      }
    }

    let metadata: Record<string, unknown> | undefined;
    if (taskRow.metadataJson) {
      try {
        metadata = this.parseJsonValue<Record<string, unknown>>(taskRow.metadataJson);
      } catch {
        // Skip unparseable metadata
      }
    }

    return {
      id: taskRow.id,
      projectId: taskRow.projectId,
      workspaceId: taskRow.workspaceId,
      parentTaskId: taskRow.parentTaskId ?? undefined,
      title: taskRow.title,
      description: taskRow.description ?? undefined,
      status: taskRow.status,
      priority: taskRow.priority,
      created: taskRow.created,
      updated: taskRow.updated,
      completedAt: taskRow.completedAt ?? undefined,
      dueDate: taskRow.dueDate ?? undefined,
      assignee: taskRow.assignee ?? undefined,
      tags,
      metadata
    };
  }

  private parseJsonValue<T>(json: string): T | undefined {
    try {
      return JSON.parse(json) as T;
    } catch {
      return undefined;
    }
  }
}
