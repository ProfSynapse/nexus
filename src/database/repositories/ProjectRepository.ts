/**
 * Location: src/database/repositories/ProjectRepository.ts
 *
 * Project Repository Implementation
 *
 * Manages project entities with JSONL persistence and SQLite caching.
 * Projects share a per-workspace JSONL file: .nexus/tasks/tasks_[workspaceId].jsonl
 *
 * Design Principles:
 * - Single Responsibility: Only handles project CRUD operations
 * - Hybrid Storage: JSONL source of truth + SQLite cache for queries
 * - Cache Invalidation: Automatic cache clearing after mutations
 * - Event Sourcing: All changes recorded as immutable events
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/IProjectRepository.ts - Interface
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import { DatabaseRow, QueryParams } from './base/BaseRepository';
import {
  IProjectRepository,
  ProjectMetadata,
  CreateProjectData,
  UpdateProjectData
} from './interfaces/IProjectRepository';
import {
  ProjectCreatedEvent,
  ProjectUpdatedEvent,
  ProjectDeletedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';

interface ProjectRow extends DatabaseRow {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  status: ProjectMetadata['status'];
  created: number;
  updated: number;
  metadataJson?: string | null;
}

/**
 * Repository for project entities
 */
export class ProjectRepository
  extends BaseRepository<ProjectMetadata>
  implements IProjectRepository {

  protected readonly tableName = 'projects';
  protected readonly entityType = 'project';

  protected jsonlPath(workspaceId: string): string {
    return `tasks/tasks_${workspaceId}.jsonl`;
  }

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<ProjectMetadata | null> {
    return this.getCachedOrFetch(
      `project:get:${id}`,
      async () => {
        const row = await this.sqliteCache.queryOne<ProjectRow>(
          'SELECT * FROM projects WHERE id = ?',
          [id]
        );
        return row ? this.rowToEntity(row) : null;
      }
    );
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<ProjectMetadata>> {
    const baseQuery = 'SELECT * FROM projects ORDER BY updated DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM projects';

    const result = await this.queryPaginated<ProjectRow>(baseQuery, countQuery, options);
    return {
      ...result,
      items: result.items.map(row => this.rowToEntity(row))
    };
  }

  async create(data: CreateProjectData): Promise<string> {
    const id = this.generateId();
    const now = Date.now();
    const metadataJson = data.metadata ? JSON.stringify(data.metadata) : null;

    try {
      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<ProjectCreatedEvent>(
          this.jsonlPath(data.workspaceId),
          {
            type: 'project_created',
            data: {
              id,
              workspaceId: data.workspaceId,
              name: data.name,
              description: data.description,
              status: 'active',
              created: now,
              updated: now,
              metadataJson: metadataJson ?? undefined
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO projects (id, workspaceId, name, description, status, created, updated, metadataJson)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            data.workspaceId,
            data.name,
            data.description ?? null,
            'active',
            now,
            now,
            metadataJson
          ]
        );
      });

      // 3. Invalidate cache
      this.invalidateCache();
      this.log('create', { id, name: data.name });

      return id;
    } catch (error) {
      this.logError('create', error);
      throw error;
    }
  }

  async update(id: string, data: UpdateProjectData): Promise<void> {
    const now = Date.now();

    try {
      // Look up the project to get workspaceId for JSONL path
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Project not found: ${id}`);
      }

      await this.transaction(async () => {
        // 1. Write event to JSONL
        const eventData: Record<string, unknown> = { updated: now };
        if (data.name !== undefined) eventData.name = data.name;
        if (data.description !== undefined) eventData.description = data.description;
        if (data.status !== undefined) eventData.status = data.status;
        if (data.metadata !== undefined) eventData.metadataJson = JSON.stringify(data.metadata);

        await this.writeEvent<ProjectUpdatedEvent>(
          this.jsonlPath(existing.workspaceId),
          {
            type: 'project_updated',
            projectId: id,
            data: eventData as ProjectUpdatedEvent['data']
          }
        );

        // 2. Update SQLite cache
        const setClauses: string[] = ['updated = ?'];
        const params: QueryParams = [now];

        if (data.name !== undefined) {
          setClauses.push('name = ?');
          params.push(data.name);
        }
        if (data.description !== undefined) {
          setClauses.push('description = ?');
          params.push(data.description);
        }
        if (data.status !== undefined) {
          setClauses.push('status = ?');
          params.push(data.status);
        }
        if (data.metadata !== undefined) {
          setClauses.push('metadataJson = ?');
          params.push(JSON.stringify(data.metadata));
        }

        params.push(id);

        await this.sqliteCache.run(
          `UPDATE projects SET ${setClauses.join(', ')} WHERE id = ?`,
          params
        );
      });

      // 3. Invalidate cache
      const statusChanged = data.status !== undefined && data.status !== existing.status;
      if (statusChanged) {
        this.invalidateCache();
        this.queryCache.invalidateByType('task');
      } else {
        this.invalidateCache(id);
      }
      this.log('update', { id });
    } catch (error) {
      this.logError('update', error);
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    try {
      // Look up the project to get workspaceId for JSONL path
      const existing = await this.getById(id);
      if (!existing) {
        throw new Error(`Project not found: ${id}`);
      }

      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<ProjectDeletedEvent>(
          this.jsonlPath(existing.workspaceId),
          {
            type: 'project_deleted',
            projectId: id
          }
        );

        // 2. Delete from SQLite (cascades to tasks, deps, note links)
        await this.sqliteCache.run('DELETE FROM projects WHERE id = ?', [id]);
      });

      // 3. Invalidate cache (project + all tasks in project)
      this.invalidateCache();
      this.queryCache.invalidateByType('task');
      this.log('delete', { id });
    } catch (error) {
      this.logError('delete', error);
      throw error;
    }
  }

  async count(criteria?: Record<string, unknown>): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM projects';
    const params: QueryParams = [];

    if (criteria) {
      const conditions: string[] = [];
      if (typeof criteria.workspaceId === 'string') {
        conditions.push('workspaceId = ?');
        params.push(criteria.workspaceId);
      }
      if (typeof criteria.status === 'string') {
        conditions.push('status = ?');
        params.push(criteria.status);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  // ============================================================================
  // IProjectRepository Specific Methods
  // ============================================================================

  async getByWorkspace(
    workspaceId: string,
    options?: PaginationParams & { status?: string }
  ): Promise<PaginatedResult<ProjectMetadata>> {
    let whereClause = 'WHERE workspaceId = ?';
    const params: QueryParams = [workspaceId];

    if (options?.status) {
      whereClause += ' AND status = ?';
      params.push(options.status);
    }

    const baseQuery = `SELECT * FROM projects ${whereClause} ORDER BY updated DESC`;
    const countQuery = `SELECT COUNT(*) as count FROM projects ${whereClause}`;

    const result = await this.queryPaginated<ProjectRow>(baseQuery, countQuery, options, params);
    return {
      ...result,
      items: result.items.map(row => this.rowToEntity(row))
    };
  }

  async getByName(workspaceId: string, name: string): Promise<ProjectMetadata | null> {
    const row = await this.sqliteCache.queryOne<ProjectRow>(
      'SELECT * FROM projects WHERE workspaceId = ? AND name = ?',
      [workspaceId, name]
    );
    return row ? this.rowToEntity(row) : null;
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: DatabaseRow): ProjectMetadata {
    const projectRow = row as ProjectRow;
    let metadata: Record<string, unknown> | undefined;
    if (projectRow.metadataJson) {
      try {
        metadata = JSON.parse(projectRow.metadataJson) as Record<string, unknown>;
      } catch {
        // Skip unparseable metadata
      }
    }

    return {
      id: projectRow.id,
      workspaceId: projectRow.workspaceId,
      name: projectRow.name,
      description: projectRow.description ?? undefined,
      status: projectRow.status,
      created: projectRow.created,
      updated: projectRow.updated,
      metadata
    };
  }
}
