/**
 * Location: src/database/repositories/WorkspaceRepository.ts
 *
 * Workspace Repository Implementation
 *
 * Manages workspace entities with JSONL persistence and SQLite caching.
 * Each workspace has its own JSONL file: .nexus/workspaces/ws_[id].jsonl
 *
 * Design Principles:
 * - Single Responsibility: Only handles workspace CRUD operations
 * - Hybrid Storage: JSONL source of truth + SQLite cache for queries
 * - Cache Invalidation: Automatic cache clearing after mutations
 * - Event Sourcing: All changes recorded as immutable events
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/IWorkspaceRepository.ts - Interface
 * - src/types/storage/HybridStorageTypes.ts - WorkspaceMetadata type
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import {
  IWorkspaceRepository,
  CreateWorkspaceData,
  UpdateWorkspaceData
} from './interfaces/IWorkspaceRepository';
import { WorkspaceMetadata } from '../../types/storage/HybridStorageTypes';
import {
  WorkspaceCreatedEvent,
  WorkspaceUpdatedEvent,
  WorkspaceDeletedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryOptions } from '../interfaces/IStorageAdapter';
import { QueryCache } from '../optimizations/QueryCache';

/**
 * Repository for workspace entities
 *
 * Handles CRUD operations with JSONL persistence and SQLite caching.
 * Each workspace gets its own JSONL file for all related events.
 */
export class WorkspaceRepository
  extends BaseRepository<WorkspaceMetadata>
  implements IWorkspaceRepository {

  protected readonly tableName = 'workspaces';
  protected readonly entityType = 'workspace';
  protected readonly jsonlPath = (id: string) => `workspaces/ws_${id}.jsonl`;

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<WorkspaceMetadata | null> {
    return this.getCachedOrFetch(
      QueryCache.workspaceKey(id),
      async () => {
        const row = await this.sqliteCache.queryOne<any>(
          'SELECT * FROM workspaces WHERE id = ?',
          [id]
        );
        return row ? this.rowToEntity(row) : null;
      }
    );
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<WorkspaceMetadata>> {
    return this.getWorkspaces(options);
  }

  async create(data: CreateWorkspaceData): Promise<string> {
    // Use provided ID or generate a new one
    const id = data.id || this.generateId();
    const now = Date.now();
    const contextJson = data.context ? JSON.stringify(data.context) : undefined;

    try {
      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<WorkspaceCreatedEvent>(
          this.jsonlPath(id),
          {
            type: 'workspace_created',
            data: {
              id,
              name: data.name,
              description: data.description,
              rootFolder: data.rootFolder,
              created: data.created ?? now,
              dedicatedAgentId: data.dedicatedAgentId,
              contextJson
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO workspaces (id, name, description, rootFolder, created, lastAccessed, isActive, dedicatedAgentId, contextJson)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            data.name,
            data.description ?? null,
            data.rootFolder,
            data.created ?? now,
            now,
            // Default to 1 (active) if not specified
            data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1,
            data.dedicatedAgentId ?? null,
            contextJson ?? null  // SQLite needs null, not undefined
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

  async update(id: string, data: UpdateWorkspaceData): Promise<void> {
    try {
      await this.transaction(async () => {
        // 1. Write event to JSONL
        const eventData: Partial<{ name: string; description: string; rootFolder: string; lastAccessed: number; isActive: boolean; dedicatedAgentId: string; contextJson: string }> = {
          lastAccessed: data.lastAccessed ?? Date.now()
        };
        if (data.name !== undefined) eventData.name = data.name;
        if (data.description !== undefined) eventData.description = data.description;
        if (data.rootFolder !== undefined) eventData.rootFolder = data.rootFolder;
        if (data.isActive !== undefined) eventData.isActive = data.isActive;
        if (data.dedicatedAgentId !== undefined) eventData.dedicatedAgentId = data.dedicatedAgentId;
        if (data.context !== undefined) eventData.contextJson = JSON.stringify(data.context);

        await this.writeEvent<WorkspaceUpdatedEvent>(
          this.jsonlPath(id),
          {
            type: 'workspace_updated',
            workspaceId: id,
            data: eventData
          }
        );

        // 2. Update SQLite cache
        const setClauses: string[] = [];
        const params: any[] = [];

        if (data.name !== undefined) {
          setClauses.push('name = ?');
          params.push(data.name);
        }
        if (data.description !== undefined) {
          setClauses.push('description = ?');
          params.push(data.description);
        }
        if (data.rootFolder !== undefined) {
          setClauses.push('rootFolder = ?');
          params.push(data.rootFolder);
        }
        if (data.isActive !== undefined) {
          setClauses.push('isActive = ?');
          params.push(data.isActive ? 1 : 0);
        }
        if (data.dedicatedAgentId !== undefined) {
          setClauses.push('dedicatedAgentId = ?');
          params.push(data.dedicatedAgentId);
        }
        if (data.context !== undefined) {
          setClauses.push('contextJson = ?');
          params.push(JSON.stringify(data.context));
        }

        setClauses.push('lastAccessed = ?');
        params.push(data.lastAccessed ?? Date.now());
        params.push(id);

        if (setClauses.length > 0) {
          await this.sqliteCache.run(
            `UPDATE workspaces SET ${setClauses.join(', ')} WHERE id = ?`,
            params
          );
        }
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
      await this.transaction(async () => {
        // 1. Write event to JSONL
        await this.writeEvent<WorkspaceDeletedEvent>(
          this.jsonlPath(id),
          {
            type: 'workspace_deleted',
            workspaceId: id
          }
        );

        // 2. Delete from SQLite (cascades to sessions, states, traces)
        await this.sqliteCache.run('DELETE FROM workspaces WHERE id = ?', [id]);
      });

      // 3. Invalidate cache
      this.invalidateCache();
      this.log('delete', { id });
    } catch (error) {
      this.logError('delete', error);
      throw error;
    }
  }

  async count(criteria?: Record<string, any>): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM workspaces';
    const params: any[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (criteria.isActive !== undefined) {
        conditions.push('isActive = ?');
        params.push(criteria.isActive ? 1 : 0);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  // ============================================================================
  // IWorkspaceRepository Specific Methods
  // ============================================================================

  async getWorkspaces(options?: QueryOptions): Promise<PaginatedResult<WorkspaceMetadata>> {
    const sortBy = options?.sortBy ?? 'lastAccessed';
    const sortOrder = options?.sortOrder ?? 'desc';

    let whereClause = '';
    const params: any[] = [];

    if (options?.filter) {
      const filters: string[] = [];
      if (options.filter.isActive !== undefined) {
        filters.push('isActive = ?');
        params.push(options.filter.isActive ? 1 : 0);
      }
      if (filters.length > 0) {
        whereClause = `WHERE ${filters.join(' AND ')}`;
      }
    }

    const baseQuery = `SELECT * FROM workspaces ${whereClause} ORDER BY ${sortBy} ${sortOrder}`;
    const countQuery = `SELECT COUNT(*) as count FROM workspaces ${whereClause}`;

    const result = await this.queryPaginated<any>(baseQuery, countQuery, options, params);
    return {
      items: result.items.map(row => this.rowToEntity(row)),
      page: result.page,
      pageSize: result.pageSize,
      totalItems: result.totalItems,
      totalPages: result.totalPages,
      hasNextPage: result.hasNextPage,
      hasPreviousPage: result.hasPreviousPage
    };
  }

  async getByName(name: string): Promise<WorkspaceMetadata | null> {
    const row = await this.sqliteCache.queryOne<any>(
      'SELECT * FROM workspaces WHERE name = ?',
      [name]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async updateLastAccessed(id: string): Promise<void> {
    const now = Date.now();

    try {
      await this.transaction(async () => {
        await this.writeEvent<WorkspaceUpdatedEvent>(
          this.jsonlPath(id),
          {
            type: 'workspace_updated',
            workspaceId: id,
            data: { lastAccessed: now }
          }
        );

        await this.sqliteCache.run(
          'UPDATE workspaces SET lastAccessed = ? WHERE id = ?',
          [now, id]
        );
      });

      this.invalidateCache(id);
    } catch (error) {
      this.logError('updateLastAccessed', error);
      throw error;
    }
  }

  async search(query: string): Promise<WorkspaceMetadata[]> {
    const rows = await this.sqliteCache.searchWorkspaces(query);
    return rows.map(row => this.rowToEntity(row));
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: any): WorkspaceMetadata {
    // Parse context from JSON string
    let context = undefined;
    if (row.contextJson) {
      try {
        context = JSON.parse(row.contextJson);
      } catch (e) {
        console.warn('[WorkspaceRepository] Failed to parse contextJson:', e);
      }
    }

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      rootFolder: row.rootFolder,
      created: row.created,
      lastAccessed: row.lastAccessed,
      isActive: row.isActive === 1,
      dedicatedAgentId: row.dedicatedAgentId ?? undefined,
      context
    };
  }
}
