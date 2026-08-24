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

import { BaseRepository, RepositoryDependencies, DatabaseRow } from './base/BaseRepository';
import {
  IStateRepository,
  SaveStateData,
  StateListOptions,
  UpdateStateData
} from './interfaces/IStateRepository';
import { StateMetadata, StateData } from '../../types/storage/HybridStorageTypes';
import {
  StateSavedEvent,
  StateUpdatedEvent,
  StateDeletedEvent
} from '../interfaces/StorageEvents';
import { PaginatedResult, PaginationParams } from '../../types/pagination/PaginationTypes';
import { QueryParams } from './base/BaseRepository';
import { parseJsonColumn } from '../utils/jsonColumn';
import { deriveStateMetadata, resolveStateDescription } from '../utils/stateContent';

interface StateRow extends DatabaseRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  name: string;
  description?: string | null;
  created: number;
  tagsJson?: string | null;
  /**
   * 1 = archived, 0 = not archived, NULL = unknown (row predates the v16
   * migration and has not been backfilled yet). See src/database/utils/stateContent.ts.
   */
  isArchived?: number | null;
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
  protected readonly jsonlPath: (workspaceId: string) => string = (workspaceId) => `workspaces/ws_${workspaceId}.jsonl`;

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

  update(_id: string, _data: unknown): Promise<void> {
    // States are immutable snapshots - no updates allowed
    return Promise.reject(new Error('States are immutable. Create a new state instead.'));
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
    const params: QueryParams = [];

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
    options?: StateListOptions
  ): Promise<PaginatedResult<StateMetadata>> {
    let baseQuery = 'SELECT * FROM states WHERE workspaceId = ?';
    let countQuery = 'SELECT COUNT(*) as count FROM states WHERE workspaceId = ?';
    const params: QueryParams = [workspaceId];

    if (sessionId) {
      baseQuery += ' AND sessionId = ?';
      countQuery += ' AND sessionId = ?';
      params.push(sessionId);
    }

    if (options?.includeArchived === false) {
      // ONLY an explicit `false` filters. Omitting the option means "every
      // state", which is what every non-list caller depends on: restoring an
      // archived state, renaming one, and the createState name-uniqueness
      // check all have to see archived rows.
      //
      // `isArchived IS NULL` = not yet backfilled, so the answer is unknown and
      // the row MUST survive this filter; the caller resolves it from content.
      // Excluding unknowns here would hide states that are plainly not
      // archived, which is the direction of failure that actually loses data
      // from a list.
      const archiveFilter = ' AND (isArchived IS NULL OR isArchived = 0)';
      baseQuery += archiveFilter;
      countQuery += archiveFilter;
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

    // Read full state from JSONL file. Fold subsequent state_updated events
    // over the original state_saved event so callers see the latest content.
    try {
      const events = await this.jsonlWriter.readEvents<StateSavedEvent | StateUpdatedEvent>(
        this.jsonlPath(metadata.workspaceId)
      );

      const savedEvent = events.find(
        (e): e is StateSavedEvent => e.type === 'state_saved' && e.data.id === id
      );

      if (!savedEvent) {
        this.logError('getStateData', `State event not found in JSONL: ${id}`);
        return null;
      }

      let content = parseJsonColumn<unknown>(savedEvent.data.stateJson, `StateRepository.state#${id}`);

      for (const event of events) {
        if (event.type === 'state_updated' && event.stateId === id && event.data.stateJson !== undefined) {
          content = parseJsonColumn<unknown>(event.data.stateJson, `StateRepository.state#${id}`);
        }
      }

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
              stateJson: JSON.stringify(data.content),
              tags: data.tags
            }
          }
        );

        // 2. Update SQLite cache (metadata only, no content). isArchived and
        //    the description fallback are derived from the content here and by
        //    WorkspaceEventApplier on replay — the two must agree or a cache
        //    rebuild would change what lists show.
        const derived = deriveStateMetadata(data.content);
        await this.sqliteCache.run(
          `INSERT INTO states (id, workspaceId, sessionId, name, description, created, tagsJson, isArchived)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            workspaceId,
            sessionId,
            data.name,
            resolveStateDescription(data.description, derived),
            data.created ?? now,
            data.tags ? JSON.stringify(data.tags) : null,
            derived.isArchived ? 1 : 0
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
          content: data.content
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

  async updateState(id: string, updates: UpdateStateData): Promise<void> {
    if (
      updates.name === undefined &&
      updates.description === undefined &&
      updates.tags === undefined &&
      updates.content === undefined
    ) {
      return;
    }

    try {
      await this.transaction(async () => {
        const metadata = await this.getById(id);
        if (!metadata) {
          throw new Error(`State not found: ${id}`);
        }

        const eventData: StateUpdatedEvent['data'] = {};
        if (updates.name !== undefined) eventData.name = updates.name;
        if (updates.description !== undefined) eventData.description = updates.description;
        if (updates.tags !== undefined) eventData.tags = updates.tags;
        if (updates.content !== undefined) {
          eventData.stateJson = JSON.stringify(updates.content);
        }

        await this.writeEvent<StateUpdatedEvent>(
          this.jsonlPath(metadata.workspaceId),
          {
            type: 'state_updated',
            workspaceId: metadata.workspaceId,
            sessionId: metadata.sessionId,
            stateId: id,
            data: eventData
          }
        );

        const setClauses: string[] = [];
        const params: QueryParams = [];
        if (updates.name !== undefined) {
          setClauses.push('name = ?');
          params.push(updates.name);
        }
        if (updates.description !== undefined) {
          setClauses.push('description = ?');
          params.push(updates.description);
        }
        if (updates.tags !== undefined) {
          setClauses.push('tagsJson = ?');
          params.push(JSON.stringify(updates.tags));
        }
        if (updates.content !== undefined) {
          // Archiving a state IS a content update (archiveState rewrites
          // state.metadata.isArchived), so this is the write that keeps the
          // denormalized column true.
          setClauses.push('isArchived = ?');
          params.push(deriveStateMetadata(updates.content).isArchived ? 1 : 0);
        }

        if (setClauses.length > 0) {
          params.push(id);
          await this.sqliteCache.run(
            `UPDATE states SET ${setClauses.join(', ')} WHERE id = ?`,
            params
          );
        }

        // Invalidate content cache so the next getStateData re-reads the
        // folded JSONL (state_saved + state_updated events).
        this.stateContentCache.delete(id);
      });

      this.invalidateCache();
      this.log('updateState', { id, fields: Object.keys(updates) });
    } catch (error) {
      this.logError('updateState', error);
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
    const params: QueryParams = [`%"${tag}"%`];

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

  /**
   * Fill in `isArchived` (and the derived `description` fallback) for rows the
   * v16 migration left unknown.
   *
   * The migration itself cannot do this: `migrationFn` is synchronous and only
   * sees the database, while the archive flag lives in the JSONL event store.
   * It backfills the rows whose `stateJson` the event applier happened to
   * cache; everything written live by `saveState()` has `stateJson` NULL and
   * lands here.
   *
   * The cost is deliberately O(workspaces), not O(states): each workspace
   * stream is read ONCE and folded for every state in it. Reading per state —
   * which is what `getStateData()` would do — is exactly the quadratic cost
   * issue #219 exists to remove, so it must not be reintroduced by the fix.
   *
   * Idempotent and cheap to call on every startup: when nothing is unknown the
   * whole thing is one indexed SELECT that returns no rows.
   *
   * @returns number of rows updated
   */
  async backfillDerivedStateMetadata(): Promise<number> {
    const unknownRows = await this.sqliteCache.query<StateRow>(
      'SELECT id, workspaceId, description FROM states WHERE isArchived IS NULL'
    );
    if (unknownRows.length === 0) {
      return 0;
    }

    const byWorkspace = new Map<string, StateRow[]>();
    for (const row of unknownRows) {
      const list = byWorkspace.get(row.workspaceId);
      if (list) {
        list.push(row);
      } else {
        byWorkspace.set(row.workspaceId, [row]);
      }
    }

    let updated = 0;

    for (const [workspaceId, rows] of byWorkspace) {
      let contentById: Map<string, unknown>;
      try {
        contentById = await this.readStateContents(workspaceId);
      } catch (error) {
        this.logError('backfillDerivedStateMetadata', error);
        continue;
      }

      for (const row of rows) {
        // A row with no event in the stream is left unknown rather than
        // guessed at — MemoryService still resolves it from content.
        if (!contentById.has(row.id)) {
          continue;
        }

        const derived = deriveStateMetadata(contentById.get(row.id));
        await this.sqliteCache.run(
          'UPDATE states SET isArchived = ?, description = ? WHERE id = ?',
          [derived.isArchived ? 1 : 0, resolveStateDescription(row.description, derived), row.id]
        );
        updated++;
      }
    }

    if (updated > 0) {
      this.invalidateCache();
      this.log('backfillDerivedStateMetadata', { updated, workspaces: byWorkspace.size });
    }

    return updated;
  }

  /**
   * Read one workspace's event stream once and fold it into
   * stateId -> latest content (state_saved, then any state_updated on top).
   */
  private async readStateContents(workspaceId: string): Promise<Map<string, unknown>> {
    const events = await this.jsonlWriter.readEvents<StateSavedEvent | StateUpdatedEvent>(
      this.jsonlPath(workspaceId)
    );

    const contentById = new Map<string, unknown>();
    for (const event of events) {
      if (event.type === 'state_saved' && event.data?.id) {
        contentById.set(
          event.data.id,
          parseJsonColumn<unknown>(event.data.stateJson, `StateRepository.state#${event.data.id}`)
        );
      } else if (event.type === 'state_updated' && event.stateId && event.data?.stateJson !== undefined) {
        contentById.set(
          event.stateId,
          parseJsonColumn<unknown>(event.data.stateJson, `StateRepository.state#${event.stateId}`)
        );
      }
    }

    return contentById;
  }

  // ============================================================================
  // Protected Methods
  // ============================================================================

  protected rowToEntity(row: DatabaseRow): StateMetadata {
    const stateRow = row as StateRow;
    return {
      id: stateRow.id,
      sessionId: stateRow.sessionId,
      workspaceId: stateRow.workspaceId,
      name: stateRow.name,
      description: stateRow.description ?? undefined,
      created: stateRow.created,
      // NULL stays `undefined` — "unknown", not "false". Callers use that to
      // decide whether they still have to read the snapshot content.
      isArchived: stateRow.isArchived === null || stateRow.isArchived === undefined
        ? undefined
        : stateRow.isArchived === 1,
      tags: parseJsonColumn<string[]>(stateRow.tagsJson, `StateRepository.tags#${stateRow.id}`)
    };
  }
}
