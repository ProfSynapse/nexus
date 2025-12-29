/**
 * Location: src/database/repositories/SessionRepository.ts
 *
 * Session Repository Implementation
 *
 * Manages session entities within workspaces.
 * Session events are written to the workspace's JSONL file.
 *
 * Design Principles:
 * - Sessions belong to workspaces (parent-child relationship)
 * - Events go to workspace JSONL file: workspaces/ws_[workspaceId].jsonl
 * - SQLite provides fast queries with workspace filtering
 * - Active session tracking for workspace context
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/ISessionRepository.ts - Interface
 * - src/types/storage/HybridStorageTypes.ts - SessionMetadata type
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import {
  ISessionRepository,
  CreateSessionData,
  UpdateSessionData
} from './interfaces/ISessionRepository';
import { SessionMetadata } from '../../types/storage/HybridStorageTypes';
import {
  SessionCreatedEvent,
  SessionUpdatedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryCache } from '../optimizations/QueryCache';

/**
 * Repository for session entities
 *
 * Handles CRUD operations for sessions within workspaces.
 * Events are written to the workspace's JSONL file.
 */
export class SessionRepository
  extends BaseRepository<SessionMetadata>
  implements ISessionRepository {

  protected readonly tableName = 'sessions';
  protected readonly entityType = 'session';
  // Sessions write to workspace JSONL file
  protected readonly jsonlPath = (workspaceId: string) => `workspaces/ws_${workspaceId}.jsonl`;

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<SessionMetadata | null> {
    // First get the session to find its workspaceId
    const row = await this.sqliteCache.queryOne<any>(
      'SELECT * FROM sessions WHERE id = ?',
      [id]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<SessionMetadata>> {
    const baseQuery = 'SELECT * FROM sessions ORDER BY startTime DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM sessions';
    const result = await this.queryPaginated<any>(baseQuery, countQuery, options);
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

  async create(data: CreateSessionData & { workspaceId: string }): Promise<string> {
    const id = this.generateId();
    const now = Date.now();

    try {
      await this.transaction(async () => {
        // 1. Write event to workspace JSONL
        await this.writeEvent<SessionCreatedEvent>(
          this.jsonlPath(data.workspaceId),
          {
            type: 'session_created',
            workspaceId: data.workspaceId,
            data: {
              id,
              name: data.name,
              description: data.description,
              startTime: data.startTime ?? now
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO sessions (id, workspaceId, name, description, startTime, isActive)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            id,
            data.workspaceId,
            data.name,
            data.description ?? null,
            data.startTime ?? now,
            data.isActive ? 1 : 0
          ]
        );
      });

      // 3. Invalidate cache
      this.invalidateCache();
      this.log('create', { id, workspaceId: data.workspaceId, name: data.name });

      return id;
    } catch (error) {
      this.logError('create', error);
      throw error;
    }
  }

  async update(id: string, data: UpdateSessionData & { workspaceId: string }): Promise<void> {
    try {
      await this.transaction(async () => {
        // 1. Write event to workspace JSONL
        await this.writeEvent<SessionUpdatedEvent>(
          this.jsonlPath(data.workspaceId),
          {
            type: 'session_updated',
            workspaceId: data.workspaceId,
            sessionId: id,
            data: {
              name: data.name,
              description: data.description,
              endTime: data.endTime,
              isActive: data.isActive
            }
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
        if (data.endTime !== undefined) {
          setClauses.push('endTime = ?');
          params.push(data.endTime);
        }
        if (data.isActive !== undefined) {
          setClauses.push('isActive = ?');
          params.push(data.isActive ? 1 : 0);
        }

        if (setClauses.length > 0) {
          params.push(id);
          await this.sqliteCache.run(
            `UPDATE sessions SET ${setClauses.join(', ')} WHERE id = ?`,
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
        // Get workspace ID first
        const session = await this.getById(id);
        if (!session) {
          throw new Error(`Session not found: ${id}`);
        }

        // Delete from SQLite (cascades to states and traces)
        await this.sqliteCache.run('DELETE FROM sessions WHERE id = ?', [id]);
      });

      // Invalidate cache
      this.invalidateCache();
      this.log('delete', { id });
    } catch (error) {
      this.logError('delete', error);
      throw error;
    }
  }

  async count(criteria?: Record<string, unknown>): Promise<number> {
    let sql = 'SELECT COUNT(*) as count FROM sessions';
    const params: any[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (criteria.workspaceId) {
        conditions.push('workspaceId = ?');
        params.push(criteria.workspaceId);
      }
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
  // ISessionRepository Specific Methods
  // ============================================================================

  async getByWorkspaceId(
    workspaceId: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<SessionMetadata>> {
    const baseQuery = 'SELECT * FROM sessions WHERE workspaceId = ? ORDER BY startTime DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM sessions WHERE workspaceId = ?';
    const result = await this.queryPaginated<any>(baseQuery, countQuery, options, [workspaceId]);
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

  async getActiveSession(workspaceId: string): Promise<SessionMetadata | null> {
    const row = await this.sqliteCache.queryOne<any>(
      'SELECT * FROM sessions WHERE workspaceId = ? AND isActive = 1 ORDER BY startTime DESC LIMIT 1',
      [workspaceId]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async endSession(id: string): Promise<void> {
    const session = await this.getById(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    await this.update(id, {
      workspaceId: session.workspaceId,
      endTime: Date.now(),
      isActive: false
    });
  }

  async countByWorkspace(workspaceId: string): Promise<number> {
    return this.count({ workspaceId });
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: any): SessionMetadata {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      description: row.description ?? undefined,
      startTime: row.startTime,
      endTime: row.endTime ?? undefined,
      isActive: row.isActive === 1
    };
  }
}
