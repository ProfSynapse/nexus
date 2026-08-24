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
import { DatabaseRow } from './base/BaseRepository';
import {
  ISessionRepository,
  CreateSessionData,
  UpdateSessionData
} from './interfaces/ISessionRepository';
import { SessionMetadata } from '../../types/storage/HybridStorageTypes';
import {
  SessionCreatedEvent,
  SessionUpdatedEvent,
  SessionDeletedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { purgeSessionRows } from '../sessionOwnership';

type SqliteValue = string | number | null;

interface SessionRow extends DatabaseRow {
  id: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  startTime: number;
  endTime?: number | null;
  isActive: number;
}

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
  protected readonly jsonlPath = (workspaceId: string): string => `workspaces/ws_${workspaceId}.jsonl`;

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<SessionMetadata | null> {
    // First get the session to find its workspaceId
    const row = await this.sqliteCache.queryOne<SessionRow>(
      'SELECT * FROM sessions WHERE id = ?',
      [id]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<SessionMetadata>> {
    const baseQuery = 'SELECT * FROM sessions ORDER BY startTime DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM sessions';
    const result = await this.queryPaginated<SessionRow>(baseQuery, countQuery, options);
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
    const id = data.id || this.generateId();
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
              startTime: data.startTime,
              endTime: data.endTime,
              isActive: data.isActive
            }
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
        if (data.startTime !== undefined) {
          setClauses.push('startTime = ?');
          params.push(data.startTime);
        }
        if (data.endTime !== undefined) {
          setClauses.push('endTime = ?');
          params.push(data.endTime);
        }
        if (data.isActive !== undefined) {
          setClauses.push('isActive = ?');
          params.push(data.isActive ? 1 : 0);
        }
        if (data.workspaceId !== undefined) {
          setClauses.push('workspaceId = ?');
          params.push(data.workspaceId);
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

  /**
   * Permanently delete a session and everything keyed to it.
   *
   * Reachable from the storage adapter and the memory/session services — never
   * from a tool. The AI has no session delete; do not expose one.
   *
   * ## Ordering, and what happens when half of it fails
   *
   * JSONL is the source of truth and SQLite is a rebuildable cache, so the two
   * halves are not symmetric:
   *
   *   1. Tombstone. A `session_deleted` event goes into the parent workspace's
   *      stream first. That stream is shared with the workspace and its sibling
   *      sessions, so — unlike a workspace delete — there is no file to remove:
   *      the tombstone IS the removal. On replay it cancels out the
   *      `session_created` / `state_saved` / `trace_added` events that precede
   *      it, through the same `purgeSessionRows` used below.
   *   2. SQLite. Only after the event is on disk.
   *
   * The failure modes this produces, on purpose:
   *
   * - **Tombstone write fails** → we throw before touching SQLite. Nothing is
   *   destroyed, the session still lists, the delete is a retryable no-op.
   * - **SQLite purge fails** → the rows are stale cache over an event store that
   *   already says "deleted". The next `rebuildCache()` clears them. It
   *   converges on deleted.
   *
   * The opposite order — SQLite first — converges on the session coming BACK
   * with all its states and traces at the next rebuild. That was the measured
   * pre-fix behaviour: `sessions 0 → 1` across a rebuild, with 2 states and
   * 2 traces that never left in the first place.
   */
  async delete(id: string): Promise<void> {
    try {
      // The workspace ID routes the JSONL write, so it has to be read before
      // anything is removed.
      const session = await this.getById(id);
      if (!session) {
        throw new Error(`Session not found: ${id}`);
      }

      // 1. Tombstone in the source of truth.
      await this.writeEvent<SessionDeletedEvent>(
        this.jsonlPath(session.workspaceId),
        {
          type: 'session_deleted',
          workspaceId: session.workspaceId,
          sessionId: id
        }
      );

      // 2. Now the cache, which is only ever catching up to the event store.
      await this.transaction(async () => {
        await purgeSessionRows(this.sqliteCache, id);
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
    let sql = 'SELECT COUNT(*) as count FROM sessions';
    const params: SqliteValue[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (typeof criteria.workspaceId === 'string') {
        conditions.push('workspaceId = ?');
        params.push(criteria.workspaceId);
      }
      if (typeof criteria.isActive === 'boolean') {
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
    const result = await this.queryPaginated<SessionRow>(baseQuery, countQuery, options, [workspaceId]);
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
    const row = await this.sqliteCache.queryOne<SessionRow>(
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

  async moveToWorkspace(id: string, workspaceId: string): Promise<void> {
    const session = await this.getById(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }

    if (session.workspaceId === workspaceId) {
      return;
    }

    try {
      await this.transaction(async () => {
        await this.writeEvent<SessionUpdatedEvent>(
          this.jsonlPath(session.workspaceId),
          {
            type: 'session_updated',
            workspaceId: session.workspaceId,
            sessionId: id,
            data: {
              workspaceId
            }
          }
        );

        await this.writeEvent<SessionCreatedEvent>(
          this.jsonlPath(workspaceId),
          {
            type: 'session_created',
            workspaceId,
            data: {
              id,
              name: session.name,
              description: session.description,
              startTime: session.startTime
            }
          }
        );

        await this.sqliteCache.run(
          'UPDATE sessions SET workspaceId = ? WHERE id = ?',
          [workspaceId, id]
        );
        await this.sqliteCache.run(
          'UPDATE states SET workspaceId = ? WHERE sessionId = ?',
          [workspaceId, id]
        );
        await this.sqliteCache.run(
          'UPDATE memory_traces SET workspaceId = ? WHERE sessionId = ?',
          [workspaceId, id]
        );
        await this.sqliteCache.run(
          'UPDATE trace_embedding_metadata SET workspaceId = ? WHERE sessionId = ?',
          [workspaceId, id]
        );
      });

      this.invalidateCache(id);
      this.log('moveToWorkspace', { id, workspaceId });
    } catch (error) {
      this.logError('moveToWorkspace', error);
      throw error;
    }
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: DatabaseRow): SessionMetadata {
    const sessionRow = row as SessionRow;
    return {
      id: sessionRow.id,
      workspaceId: sessionRow.workspaceId,
      name: sessionRow.name,
      description: sessionRow.description ?? undefined,
      startTime: sessionRow.startTime,
      endTime: sessionRow.endTime ?? undefined,
      isActive: sessionRow.isActive === 1
    };
  }
}
