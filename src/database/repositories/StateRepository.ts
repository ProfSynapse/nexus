/**
 * Location: src/database/repositories/StateRepository.ts
 *
 * State Repository Implementation
 *
 * Manages workspace state snapshots within sessions.
 * State events are written to the workspace's JSONL file.
 *
 * Design Principles:
 * - States are named snapshots for resuming work
 * - Full content stored in JSONL, metadata in SQLite
 * - Events go to workspace JSONL file
 * - Tag-based organization for easy categorization
 *
 * Related Files:
 * - src/database/repositories/base/BaseRepository.ts - Base functionality
 * - src/database/repositories/interfaces/IStateRepository.ts - Interface
 * - src/types/storage/HybridStorageTypes.ts - StateMetadata, StateData types
 */

import { BaseRepository, RepositoryDependencies } from './base/BaseRepository';
import {
  IStateRepository,
  SaveStateData
} from './interfaces/IStateRepository';
import { StateMetadata, StateData } from '../../types/storage/HybridStorageTypes';
import {
  StateSavedEvent,
  StateDeletedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';

type SqlParam = string | number | null;

interface StateRow {
  id: string;
  sessionId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  created: number;
  tagsJson: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRequiredStringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Invalid state row: ${field}`);
  }
  return value;
}

function getRequiredNumberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== 'number') {
    throw new Error(`Invalid state row: ${field}`);
  }
  return value;
}

function getNullableStringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  if (value === null || typeof value === 'string') {
    return value;
  }
  throw new Error(`Invalid state row: ${field}`);
}

function parseStateRow(row: unknown): StateRow {
  if (!isRecord(row)) {
    throw new Error('Invalid state row');
  }

  return {
    id: getRequiredStringField(row, 'id'),
    sessionId: getRequiredStringField(row, 'sessionId'),
    workspaceId: getRequiredStringField(row, 'workspaceId'),
    name: getRequiredStringField(row, 'name'),
    description: getNullableStringField(row, 'description'),
    created: getRequiredNumberField(row, 'created'),
    tagsJson: getNullableStringField(row, 'tagsJson')
  };
}

function parseStateTags(tagsJson: string | null): string[] | undefined {
  if (!tagsJson) {
    return undefined;
  }

  const parsed: unknown = JSON.parse(tagsJson);
  if (!Array.isArray(parsed) || !parsed.every(tag => typeof tag === 'string')) {
    throw new Error('Invalid state row: tagsJson');
  }

  return parsed;
}

/**
 * Repository for state entities
 *
 * Handles state snapshot operations with full content in JSONL.
 * Metadata cached in SQLite for fast queries.
 */
export class StateRepository
  extends BaseRepository<StateMetadata>
  implements IStateRepository {

  protected readonly tableName = 'states';
  protected readonly entityType = 'state';
  // States write to workspace JSONL file
  protected readonly jsonlPath = (workspaceId: string): string => `workspaces/ws_${workspaceId}.jsonl`;

  // In-memory cache for full state data (since content not in SQLite)
  private stateContentCache: Map<string, StateData> = new Map();

  constructor(deps: RepositoryDependencies) {
    super(deps);
  }

  // ============================================================================
  // IRepository Implementation
  // ============================================================================

  async getById(id: string): Promise<StateMetadata | null> {
    const row = await this.sqliteCache.queryOne<StateRow>(
      'SELECT * FROM states WHERE id = ?',
      [id]
    );
    return row ? this.rowToEntity(row) : null;
  }

  async getAll(options?: PaginationParams): Promise<PaginatedResult<StateMetadata>> {
    const baseQuery = 'SELECT * FROM states ORDER BY created DESC';
    const countQuery = 'SELECT COUNT(*) as count FROM states';
    const result = await this.queryPaginated<StateRow>(baseQuery, countQuery, options);
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

  async create(data: SaveStateData & { workspaceId: string; sessionId: string }): Promise<string> {
    return this.saveState(data.workspaceId, data.sessionId, data);
  }

  async update(_id: string, _data: unknown): Promise<void> {
    // States are immutable snapshots - no updates allowed
    throw new Error('States are immutable. Create a new state instead.');
  }

  async delete(id: string): Promise<void> {
    try {
      await this.transaction(async () => {
        // Get state metadata to find workspace/session
        const state = await this.getById(id);
        if (!state) {
          throw new Error(`State not found: ${id}`);
        }

        // 1. Write delete event to workspace JSONL
        await this.writeEvent<StateDeletedEvent>(
          this.jsonlPath(state.workspaceId),
          {
            type: 'state_deleted',
            workspaceId: state.workspaceId,
            sessionId: state.sessionId,
            stateId: id
          }
        );

        // 2. Delete from SQLite
        await this.sqliteCache.run('DELETE FROM states WHERE id = ?', [id]);

        // 3. Clear from content cache
        this.stateContentCache.delete(id);
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
    let sql = 'SELECT COUNT(*) as count FROM states';
    const params: SqlParam[] = [];

    if (criteria) {
      const conditions: string[] = [];
      if (typeof criteria.workspaceId === 'string') {
        conditions.push('workspaceId = ?');
        params.push(criteria.workspaceId);
      }
      if (typeof criteria.sessionId === 'string') {
        conditions.push('sessionId = ?');
        params.push(criteria.sessionId);
      }
      if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
      }
    }

    const result = await this.sqliteCache.queryOne<{ count: number }>(sql, params);
    return result?.count ?? 0;
  }

  // ============================================================================
  // IStateRepository Specific Methods
  // ============================================================================

  async getStates(
    workspaceId: string,
    sessionId?: string,
    options?: PaginationParams
  ): Promise<PaginatedResult<StateMetadata>> {
    let baseQuery = 'SELECT * FROM states WHERE workspaceId = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM states WHERE workspaceId = ?';
    const params: SqlParam[] = [workspaceId];

    if (sessionId) {
      baseQuery += ' AND sessionId = ?';
      countQuery += ' AND sessionId = ?';
      params.push(sessionId);
    }

    baseQuery += ' ORDER BY created DESC';

    const result = await this.queryPaginated<StateRow>(baseQuery, countQuery, options, params);
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

  async getStateData(id: string): Promise<StateData | null> {
    // Check content cache first
    if (this.stateContentCache.has(id)) {
      return this.stateContentCache.get(id) || null;
    }

    // Get metadata from SQLite
    const metadata = await this.getById(id);
    if (!metadata) {
      return null;
    }

    // Read full state from JSONL file
    try {
      const events = await this.jsonlWriter.readEvents<StateSavedEvent>(
        this.jsonlPath(metadata.workspaceId)
      );

      // Find the state saved event for this ID
      const stateEvent = events.find(
        e => e.type === 'state_saved' && e.data.id === id
      );

      if (!stateEvent) {
        this.logError('getStateData', `State event not found in JSONL: ${id}`);
        return null;
      }

      const content: unknown = JSON.parse(stateEvent.data.stateJson);

      const stateData: StateData = {
        ...metadata,
        content
      };

      // Cache for future requests
      this.stateContentCache.set(id, stateData);

      return stateData;
    } catch (error) {
      this.logError('getStateData', error);
      return null;
    }
  }

  async saveState(
    workspaceId: string,
    sessionId: string,
    data: SaveStateData
  ): Promise<string> {
    const id = this.generateId();
    const now = Date.now();
    const content: unknown = data.content;

    try {
      await this.transaction(async () => {
        // 1. Write event to workspace JSONL with full content
        await this.writeEvent<StateSavedEvent>(
          this.jsonlPath(workspaceId),
          {
            type: 'state_saved',
            workspaceId,
            sessionId,
            data: {
              id,
              name: data.name,
              description: data.description,
              created: data.created ?? now,
              stateJson: JSON.stringify(content),
              tags: data.tags
            }
          }
        );

        // 2. Update SQLite cache (metadata only, no content)
        await this.sqliteCache.run(
          `INSERT INTO states (id, workspaceId, sessionId, name, description, created, tagsJson)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            sessionId,
            data.name,
            data.description ?? null,
            data.created ?? now,
            data.tags ? JSON.stringify(data.tags) : null
          ]
        );

        // 3. Cache full state data
        this.stateContentCache.set(id, {
          id,
          workspaceId,
          sessionId,
          name: data.name,
          description: data.description,
          created: data.created ?? now,
          tags: data.tags,
          content
        });
      });

      // Invalidate query cache
      this.invalidateCache();
      this.log('saveState', { id, workspaceId, sessionId, name: data.name });

      return id;
    } catch (error) {
      this.logError('saveState', error);
      throw error;
    }
  }

  async countStates(workspaceId: string, sessionId?: string): Promise<number> {
    return this.count({ workspaceId, sessionId });
  }

  async getByTag(tag: string, options?: PaginationParams): Promise<PaginatedResult<StateMetadata>> {
    // SQLite JSON query for tags array
    const baseQuery = `SELECT * FROM states WHERE tagsJson LIKE ? ORDER BY created DESC`;
    const countQuery = `SELECT COUNT(*) as count FROM states WHERE tagsJson LIKE ?`;
    const params: SqlParam[] = [`%"${tag}"%`];

    const result = await this.queryPaginated<StateRow>(baseQuery, countQuery, options, params);
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

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: StateRow): StateMetadata {
    const parsedRow = parseStateRow(row);

    return {
      id: parsedRow.id,
      sessionId: parsedRow.sessionId,
      workspaceId: parsedRow.workspaceId,
      name: parsedRow.name,
      description: parsedRow.description ?? undefined,
      created: parsedRow.created,
      tags: parseStateTags(parsedRow.tagsJson)
    };
  }
}
