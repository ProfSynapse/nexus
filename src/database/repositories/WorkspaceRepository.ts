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
import { DatabaseRow } from './base/BaseRepository';
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
import { parseJsonColumn } from '../utils/jsonColumn';
import { purgeWorkspaceRows, workspaceOwnedStreamPaths } from '../workspaceOwnership';
import { workspaceStreamPath, workspaceStreamPathForRemoval } from './base/workspaceStreamPath';

type SqliteValue = string | number | null;

interface WorkspaceRow extends DatabaseRow {
  id: string;
  name: string;
  description?: string | null;
  rootFolder: string;
  created: number;
  lastAccessed: number;
  isActive: number;
  isArchived?: number | null;
  dedicatedAgentId?: string | null;
  contextJson?: string | null;
}

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
  protected readonly jsonlPath = (id: string): string => workspaceStreamPath(id, this.entityType);

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
        const row = await this.sqliteCache.queryOne<WorkspaceRow>(
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
              isActive: data.isActive,
              isArchived: data.isArchived,
              dedicatedAgentId: data.dedicatedAgentId,
              contextJson
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO workspaces (id, name, description, rootFolder, created, lastAccessed, isActive, isArchived, dedicatedAgentId, contextJson)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            data.name,
            data.description ?? null,
            data.rootFolder,
            data.created ?? now,
            now,
            // Default to 1 (active) if not specified
            data.isActive !== undefined ? (data.isActive ? 1 : 0) : 1,
            data.isArchived !== undefined ? (data.isArchived ? 1 : 0) : 0,
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
        const eventData: Partial<{ name: string; description: string; rootFolder: string; lastAccessed: number; isActive: boolean; isArchived: boolean; dedicatedAgentId: string; contextJson: string }> = {
          lastAccessed: data.lastAccessed ?? Date.now()
        };
        if (data.name !== undefined) eventData.name = data.name;
        if (data.description !== undefined) eventData.description = data.description;
        if (data.rootFolder !== undefined) eventData.rootFolder = data.rootFolder;
        if (data.isActive !== undefined) eventData.isActive = data.isActive;
        if (data.isArchived !== undefined) eventData.isArchived = data.isArchived;
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
        const params: SqliteValue[] = [];

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
        if (data.isArchived !== undefined) {
          setClauses.push('isArchived = ?');
          params.push(data.isArchived ? 1 : 0);
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

  /**
   * Permanently delete a workspace and everything keyed to it.
   *
   * This is the only destructive delete in the storage layer and it is reachable
   * only from the settings UI (`WorkspacesTab`) — the AI gets `archiveWorkspace`,
   * which is reversible. Do not expose it to a tool.
   *
   * ## Ordering, and what happens when half of it fails
   *
   * JSONL is the source of truth and SQLite is a rebuildable cache, so the two
   * halves are NOT symmetric and the order is a deliberate choice:
   *
   *   1. Tombstone. A `workspace_deleted` event goes into the workspace stream
   *      first. If everything after this fails, the stream that survives is
   *      self-cancelling — replay creates the workspace and its children, then
   *      `WorkspaceEventApplier.applyWorkspaceDeleted` purges all of them again
   *      (both paths share `purgeWorkspaceRows`). It also makes
   *      `reconcileMissingWorkspaces` skip the file.
   *   2. Streams. Both owned streams are removed (workspace AND tasks — see
   *      `workspaceOwnedStreamPaths`). Every removal is attempted even if an
   *      earlier one throws, so a retry has less to do, and the errors are
   *      aggregated and rethrown.
   *   3. SQLite. Only if step 2 removed everything.
   *
   * The failure modes this produces, on purpose:
   *
   * - **Stream removal fails** → we throw BEFORE touching SQLite. Nothing is
   *   destroyed, the workspace still lists, and `WorkspaceService` skips its
   *   'deleted' notification because we threw. The delete is a retryable no-op.
   * - **SQLite purge fails** (a local transaction, so barely reachable) → the
   *   rows are stale cache over a JSONL store that no longer has the workspace.
   *   The next `rebuildCache()` clears them. It converges on deleted.
   *
   * The order is chosen so that every partial failure converges toward the
   * user's intent (deleted) rather than away from it. The opposite order —
   * SQLite first — converges on the workspace coming BACK with all its states
   * at the next rebuild, which is the shape of #333 and the bug this method
   * was rewritten to remove.
   */
  async delete(id: string): Promise<void> {
    try {
      // 1. Tombstone, so a stream we fail to remove still cancels itself out.
      //
      // Minted with the REMOVAL guard, not `this.jsonlPath` (the write guard):
      // the streams most in need of a permanent delete are the malformed ones
      // the write guard now refuses to create, and they are already on disk.
      // Routing this through the write tier would throw here and skip both the
      // stream removal and the SQLite purge below, making every pre-existing
      // phantom workspace undeletable. Path safety is still enforced.
      await this.writeEvent<WorkspaceDeletedEvent>(
        workspaceStreamPathForRemoval(id, this.entityType),
        {
          type: 'workspace_deleted',
          workspaceId: id
        }
      );

      // 2. Remove the source of truth: every stream the workspace owns.
      const streamFailures: string[] = [];
      for (const streamPath of workspaceOwnedStreamPaths(id)) {
        try {
          await this.jsonlWriter.deleteStream(streamPath);
        } catch (error) {
          streamFailures.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (streamFailures.length > 0) {
        throw new Error(
          `Workspace ${id} was not deleted: its event stream(s) could not be removed ` +
          `(${streamFailures.join('; ')}). Nothing was removed from the cache, so the ` +
          'workspace is unchanged and the delete can be retried.'
        );
      }

      // 3. Now the cache, which is only ever catching up to the event store.
      await this.transaction(async () => {
        await purgeWorkspaceRows(this.sqliteCache, id);
      });

      // 4. Invalidate cache
      this.invalidateCache();
      this.log('delete', { id });
    } catch (error) {
      this.logError('delete', error);
      throw error;
    }
  }

  async count(criteria?: Record<string, unknown>): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM workspaces';
    const params: SqliteValue[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (typeof criteria.isActive === 'boolean') {
        conditions.push('isActive = ?');
        params.push(criteria.isActive ? 1 : 0);
      }
      if (typeof criteria.isArchived === 'boolean') {
        conditions.push('isArchived = ?');
        params.push(criteria.isArchived ? 1 : 0);
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
    const ALLOWED_SORT_COLUMNS = ['id', 'name', 'created', 'lastAccessed', 'isActive', 'isArchived', 'rootFolder'] as const;
    const ALLOWED_SORT_ORDERS = ['asc', 'desc'] as const;

    const requestedSort = options?.sortBy ?? 'lastAccessed';
    const requestedOrder = options?.sortOrder ?? 'desc';

    if (!ALLOWED_SORT_COLUMNS.includes(requestedSort as typeof ALLOWED_SORT_COLUMNS[number])) {
      throw new Error(`Invalid sort column: ${requestedSort}`);
    }
    if (!ALLOWED_SORT_ORDERS.includes(requestedOrder)) {
      throw new Error(`Invalid sort order: ${requestedOrder}`);
    }
    const sortBy = requestedSort;
    const sortOrder = requestedOrder;

    let whereClause = '';
    const params: SqliteValue[] = [];
    const filters: string[] = [];

    if (options?.search && options.search.trim()) {
      const searchTerm = `%${options.search.trim().toLowerCase()}%`;
      filters.push('(LOWER(name) LIKE ? OR LOWER(COALESCE(description, \'\')) LIKE ? OR LOWER(rootFolder) LIKE ?)');
      params.push(searchTerm, searchTerm, searchTerm);
    }

    if (options?.filter) {
      if (options.filter.isActive !== undefined) {
        filters.push('isActive = ?');
        params.push(options.filter.isActive ? 1 : 0);
      }
      if (options.filter.isArchived !== undefined) {
        filters.push('isArchived = ?');
        params.push(options.filter.isArchived ? 1 : 0);
      }
      if (typeof options.filter.rootFolder === 'string') {
        filters.push('rootFolder = ?');
        params.push(options.filter.rootFolder);
      }
    }

    if (filters.length > 0) {
      whereClause = `WHERE ${filters.join(' AND ')}`;
    }

    const baseQuery = `SELECT * FROM workspaces ${whereClause} ORDER BY ${sortBy} ${sortOrder}`;
    const countQuery = `SELECT COUNT(*) as count FROM workspaces ${whereClause}`;

    const result = await this.queryPaginated<WorkspaceRow>(baseQuery, countQuery, options, params);
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
    const rows = await this.sqliteCache.searchWorkspaces(query) as WorkspaceRow[];
    return rows.map(row => this.rowToEntity(row));
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: DatabaseRow): WorkspaceMetadata {
    const workspaceRow = row as WorkspaceRow;
    const context = parseJsonColumn<WorkspaceMetadata['context']>(workspaceRow.contextJson, `WorkspaceRepository.context#${workspaceRow.id}`);

    return {
      id: workspaceRow.id,
      name: workspaceRow.name,
      description: workspaceRow.description ?? undefined,
      rootFolder: workspaceRow.rootFolder,
      created: workspaceRow.created,
      lastAccessed: workspaceRow.lastAccessed,
      isActive: workspaceRow.isActive === 1,
      isArchived: workspaceRow.isArchived === 1,
      dedicatedAgentId: workspaceRow.dedicatedAgentId ?? undefined,
      context
    };
  }

}
