/**
 * Location: src/database/repositories/TraceRepository.ts
 *
 * Trace Repository Implementation
 *
 * Manages memory traces for workspace activity tracking.
 * Trace events are written to the workspace's JSONL file.
 *
 * Design Principles:
 * - Traces record significant events and context during sessions
 * - Full-text search enabled via SQLite FTS
 * - Events go to workspace JSONL file
 * - Type-based categorization for filtering
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/ITraceRepository.ts - Interface
 * - src/types/storage/HybridStorageTypes.ts - MemoryTraceData type
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import {
  ITraceRepository,
  AddTraceData
} from './interfaces/ITraceRepository';
import { MemoryTraceData } from '../../types/storage/HybridStorageTypes';
import { TraceAddedEvent } from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryCache } from '../optimizations/QueryCache';

/**
 * Repository for memory trace entities
 *
 * Handles trace operations with full-text search support.
 * Traces provide searchable history of workspace activity.
 */
export class TraceRepository
  extends BaseRepository<MemoryTraceData>
  implements ITraceRepository {

  protected readonly tableName = 'memory_traces';
  protected readonly entityType = 'trace';
  // Traces write to workspace JSONL file
  protected readonly jsonlPath = (workspaceId: string) => `workspaces/ws_${workspaceId}.jsonl`;

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<MemoryTraceData | null> {
    const row = await this.sqliteCache.queryOne<any>(
      'SELECT * FROM memory_traces WHERE id = ?',
      [id]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<MemoryTraceData>> {
    const baseQuery = 'SELECT * FROM memory_traces ORDER BY timestamp DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM memory_traces';
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

  async create(data: AddTraceData & { workspaceId: string; sessionId: string }): Promise<string> {
    return this.addTrace(data.workspaceId, data.sessionId, data);
  }

  async update(id: string, data: any): Promise<void> {
    // Traces are immutable records - no updates allowed
    throw new Error('Traces are immutable. Create a new trace instead.');
  }

  async delete(id: string): Promise<void> {
    try {
      await this.transaction(async () => {
        // Delete from SQLite only (keep in JSONL for audit trail)
        await this.sqliteCache.run('DELETE FROM memory_traces WHERE id = ?', [id]);
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
    let sql = 'SELECT COUNT(*) as count FROM memory_traces';
    const params: any[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (criteria.workspaceId) {
        conditions.push('workspaceId = ?');
        params.push(criteria.workspaceId);
      }
      if (criteria.sessionId) {
        conditions.push('sessionId = ?');
        params.push(criteria.sessionId);
      }
      if (criteria.type) {
        conditions.push('type = ?');
        params.push(criteria.type);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  // ============================================================================
  // ITraceRepository Specific Methods
  // ============================================================================

  async getTraces(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>> {
    let baseQuery = 'SELECT * FROM memory_traces WHERE workspaceId = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM memory_traces WHERE workspaceId = ?';
    const params: any[] = [workspaceId];

    if (sessionId) {
      baseQuery += ' AND sessionId = ?';
      countQuery += ' AND sessionId = ?';
      params.push(sessionId);
    }

    baseQuery += ' ORDER BY timestamp DESC';

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

  async addTrace(
    workspaceId: string,
    sessionId: string,
    data: AddTraceData
  ): Promise<string> {
    const id = this.generateId();
    const now = Date.now();

    try {
      await this.transaction(async () => {
        // 1. Write event to workspace JSONL
        await this.writeEvent<TraceAddedEvent>(
          this.jsonlPath(workspaceId),
          {
            type: 'trace_added',
            workspaceId,
            sessionId,
            data: {
              id,
              content: data.content,
              traceType: data.type,
              metadataJson: data.metadata ? JSON.stringify(data.metadata) : undefined
            }
          }
        );

        // 2. Update SQLite cache
        await this.sqliteCache.run(
          `INSERT INTO memory_traces (id, workspaceId, sessionId, timestamp, type, content, metadataJson)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            sessionId,
            data.timestamp ?? now,
            data.type ?? null,
            data.content,
            data.metadata ? JSON.stringify(data.metadata) : null
          ]
        );
      });

      // Invalidate cache
      this.invalidateCache();
      this.log('addTrace', { id, workspaceId, sessionId });

      return id;
    } catch (error) {
      this.logError('addTrace', error);
      throw error;
    }
  }

  async searchTraces(
    workspaceId: string,
    query: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>> {
    try {
      // Use SQLite FTS for search
      let baseQuery = `
        SELECT mt.* FROM memory_traces mt
        WHERE mt.workspaceId = ?
        AND mt.content LIKE ?
      `;
      let countQuery = `
        SELECT COUNT(*) as count FROM memory_traces mt
        WHERE mt.workspaceId = ?
        AND mt.content LIKE ?
      `;
      const params: any[] = [workspaceId, `%${query}%`];

      if (sessionId) {
        baseQuery += ' AND mt.sessionId = ?';
        countQuery += ' AND mt.sessionId = ?';
        params.push(sessionId);
      }

      baseQuery += ' ORDER BY mt.timestamp DESC';

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
    } catch (error) {
      this.logError('searchTraces', error);
      throw error;
    }
  }

  async getByType(
    workspaceId: string,
    type: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<MemoryTraceData>> {
    const baseQuery = `
      SELECT * FROM memory_traces
      WHERE workspaceId = ? AND type = ?
      ORDER BY timestamp DESC
    `;
    const countQuery = `
      SELECT COUNT(*) as count FROM memory_traces
      WHERE workspaceId = ? AND type = ?
    `;
    const params = [workspaceId, type];

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

  async countTraces(workspaceId: string, sessionId?: string): Promise<number> {
    return this.count({ workspaceId, sessionId });
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: any): MemoryTraceData {
    return {
      id: row.id,
      sessionId: row.sessionId,
      workspaceId: row.workspaceId,
      timestamp: row.timestamp,
      type: row.type ?? undefined,
      content: row.content,
      metadata: row.metadataJson ? JSON.parse(row.metadataJson) : undefined
    };
  }
}
